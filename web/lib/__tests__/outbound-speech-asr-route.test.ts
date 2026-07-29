import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  claim: vi.fn(),
  dispatch: vi.fn(),
  settle: vi.fn(),
  fail: vi.fn(),
  transcribe: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/realtime/outbound-speech-asr-authority.server", async () => {
  const actual = await import("../realtime/outbound-speech-asr-authority.server");
  return {
    ...actual,
    claimOutboundSpeechAsrAuthority: mocks.claim,
    markOutboundSpeechAsrDispatched: mocks.dispatch,
    settleOutboundSpeechAsrAuthority: mocks.settle,
    failOutboundSpeechAsrAuthority: mocks.fail,
  };
});
vi.mock("@/lib/realtime/outbound-speech-asr.server", async () => {
  const actual = await import("../realtime/outbound-speech-asr.server");
  return {
    ...actual,
    transcribeGuardedSpeech: mocks.transcribe,
    verifyGuardedSpeechAsrReceipt: mocks.verify,
  };
});
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));
vi.mock("server-only", () => ({}));

import { POST } from "../../app/api/voice/outbound-speech/asr/route";
import { OutboundSpeechAsrAuthorityError } from "../realtime/outbound-speech-asr-authority.server";

const ORIGIN = "https://voice.example.test";
const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000a1";
const CALL_ID = "00000000-0000-4000-8000-0000000000c1";
const AUTHORITY_ID = "00000000-0000-4000-8000-0000000000d1";
const CLAIM_TOKEN = "00000000-0000-4000-8000-0000000000e1";
const RECEIPT_KEY = "route-test-independent-receipt-key-32bytes";
const pcm = Buffer.from([1, 0, 2, 0]);
const audioSha256 = createHash("sha256").update(pcm).digest("hex");

const receipt = Object.freeze({
  schemaVersion: 2,
  authorityId: AUTHORITY_ID,
  organizationId: ORGANIZATION_ID,
  callId: CALL_ID,
  provider: "xai",
  responseId: "response-1",
  text: "Safe transcript",
  transcriptSha256: "b".repeat(64),
  audioSha256,
  audioBytes: pcm.byteLength,
  sampleRateHz: 24_000,
  channels: 1,
  complete: true,
  engine: "openai_audio_transcriptions",
  model: "whisper-1",
  decision: "transcribed",
  receiptHmacSha256: "c".repeat(64),
  receiptSha256: "d".repeat(64),
});

function request(overrides: Record<string, unknown> = {}) {
  return new Request(`${ORIGIN}/api/voice/outbound-speech/asr`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: 1,
      callId: CALL_ID,
      responseId: "response-1",
      provider: "xai",
      audio: {
        encoding: "pcm16",
        sampleRateHz: 24_000,
        channels: 1,
        base64: pcm.toString("base64"),
        sha256: audioSha256,
        bytes: pcm.byteLength,
        durationMs: pcm.byteLength / 2 / 24_000 * 1_000,
      },
      ...overrides,
    }),
  });
}

describe("authenticated outbound-speech ASR route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBLIC_ORIGIN", ORIGIN);
    mocks.getSession.mockResolvedValue({ orgId: ORGANIZATION_ID });
    mocks.claim.mockResolvedValue({
      kind: "claimed",
      authorityId: AUTHORITY_ID,
      claimToken: CLAIM_TOKEN,
      fundingSource: "tenant_openai_byok",
      apiKey: "tenant-openai-root",
      reservedMicroUsd: 6_000,
      receiptHmacKey: RECEIPT_KEY,
    });
    mocks.dispatch.mockResolvedValue(undefined);
    mocks.transcribe.mockResolvedValue(receipt);
    mocks.settle.mockResolvedValue(undefined);
    mocks.fail.mockResolvedValue(undefined);
    mocks.verify.mockReturnValue(receipt);
  });

  it("consumes exact authority before provider dispatch and settles before returning", async () => {
    const order: string[] = [];
    mocks.claim.mockImplementation(async () => {
      order.push("claim");
      return {
        kind: "claimed",
        authorityId: AUTHORITY_ID,
        claimToken: CLAIM_TOKEN,
        fundingSource: "tenant_openai_byok",
        apiKey: "tenant-openai-root",
        reservedMicroUsd: 6_000,
        receiptHmacKey: RECEIPT_KEY,
      };
    });
    mocks.dispatch.mockImplementation(async () => { order.push("dispatch"); });
    mocks.transcribe.mockImplementation(async () => {
      order.push("provider");
      return receipt;
    });
    mocks.settle.mockImplementation(async () => { order.push("settle"); });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(order).toEqual(["claim", "dispatch", "provider", "settle"]);
    expect(mocks.claim).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      callId: CALL_ID,
      provider: "xai",
      responseId: "response-1",
      audioSha256,
      audioBytes: pcm.byteLength,
      sampleRateHz: 24_000,
      audioDurationMs: pcm.byteLength / 2 / 24_000 * 1_000,
    });
    expect(mocks.transcribe.mock.calls[0]?.[0]).toMatchObject({
      authorityId: AUTHORITY_ID,
      organizationId: ORGANIZATION_ID,
      callId: CALL_ID,
      provider: "xai",
      responseId: "response-1",
      audioSha256,
    });
    expect(mocks.transcribe.mock.calls[0]?.slice(1)).toEqual([
      "tenant-openai-root",
      RECEIPT_KEY,
    ]);
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("serves an authenticated exact cached receipt without replaying provider spend", async () => {
    mocks.claim.mockResolvedValue({
      kind: "cached",
      receipt,
      receiptHmacKey: RECEIPT_KEY,
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.verify).toHaveBeenCalledWith(receipt, {
      organizationId: ORGANIZATION_ID,
      callId: CALL_ID,
      provider: "xai",
      responseId: "response-1",
      audioSha256,
      audioBytes: pcm.byteLength,
      sampleRateHz: 24_000,
    }, RECEIPT_KEY);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong_direction", 403],
    ["provider_mismatch", 409],
    ["identity_conflict", 409],
    ["already_consumed", 409],
    ["budget_exhausted", 429],
    ["funding_unavailable", 503],
  ] as const)("rejects %s before dispatch", async (code, status) => {
    mocks.claim.mockRejectedValue(new OutboundSpeechAsrAuthorityError(code));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it("does not spend for anonymous, cross-origin, or malformed requests", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(401);

    const crossOrigin = new Request(`${ORIGIN}/api/voice/outbound-speech/asr`, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect((await POST(crossOrigin)).status).toBe(403);
    expect((await POST(request({
      audio: {
        encoding: "pcm16",
        sampleRateHz: 24_000,
        channels: 1,
        base64: pcm.toString("base64"),
        sha256: "0".repeat(64),
        bytes: pcm.byteLength,
        durationMs: pcm.byteLength / 2 / 24_000 * 1_000,
      },
    }))).status).toBe(400);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("terminalizes every failure after claim and never retries provider dispatch", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("db unavailable"));
    expect((await POST(request())).status).toBe(503);
    expect(mocks.fail).toHaveBeenLastCalledWith({
      authorityId: AUTHORITY_ID,
      claimToken: CLAIM_TOKEN,
      afterDispatch: false,
      failureCode: "local_failure",
    });
    expect(mocks.transcribe).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ orgId: ORGANIZATION_ID });
    mocks.claim.mockResolvedValue({
      kind: "claimed",
      authorityId: AUTHORITY_ID,
      claimToken: CLAIM_TOKEN,
      fundingSource: "tenant_openai_byok",
      apiKey: "tenant-openai-root",
      reservedMicroUsd: 6_000,
      receiptHmacKey: RECEIPT_KEY,
    });
    mocks.dispatch.mockResolvedValue(undefined);
    mocks.transcribe.mockRejectedValue(new Error("ambiguous provider timeout"));
    mocks.fail.mockResolvedValue(undefined);
    expect((await POST(request())).status).toBe(503);
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
    expect(mocks.fail).toHaveBeenLastCalledWith({
      authorityId: AUTHORITY_ID,
      claimToken: CLAIM_TOKEN,
      afterDispatch: true,
      failureCode: "provider_outcome_unknown",
    });
  });

  it("quarantines a post-provider settlement failure as indeterminate", async () => {
    mocks.settle.mockRejectedValue(new Error("settlement lost"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
    expect(mocks.fail).toHaveBeenCalledWith({
      authorityId: AUTHORITY_ID,
      claimToken: CLAIM_TOKEN,
      afterDispatch: true,
      failureCode: "settlement_unknown",
    });
  });
});
