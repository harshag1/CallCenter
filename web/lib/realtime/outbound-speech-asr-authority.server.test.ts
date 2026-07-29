import { describe, expect, it, vi } from "vitest";
import {
  claimOutboundSpeechAsrAuthority,
  failOutboundSpeechAsrAuthority,
  markOutboundSpeechAsrDispatched,
  OutboundSpeechAsrAuthorityError,
  settleOutboundSpeechAsrAuthority,
  type OutboundSpeechAsrAuthorityDependencies,
} from "./outbound-speech-asr-authority.server";
import { createGuardedSpeechAsrReceipt } from "./outbound-speech-asr.server";

const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000a1";
const CALL_ID = "00000000-0000-4000-8000-0000000000c1";
const AUTHORITY_ID = "00000000-0000-4000-8000-0000000000d1";
const CLAIM_TOKEN = "00000000-0000-4000-8000-0000000000e1";
const AUDIO_SHA256 = "a".repeat(64);
const RECEIPT_KEY = "authority-test-independent-receipt-key-32bytes";
const TENANT_KEY = "tenant-owned-openai-root-at-least-16-bytes";

const INPUT = Object.freeze({
  organizationId: ORGANIZATION_ID,
  callId: CALL_ID,
  provider: "xai" as const,
  responseId: "response-1",
  audioSha256: AUDIO_SHA256,
  audioBytes: 48_000,
  sampleRateHz: 24_000,
  audioDurationMs: 1_000,
});

function result(rows: unknown[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function baseEnvironment(): Record<string, string> {
  return {
    HACC_OUTBOUND_SPEECH_ASR_RECEIPT_HMAC_KEY: RECEIPT_KEY,
    HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_WEB_CALL: "120000",
    HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_ORG_DAY: "600000",
  };
}

function dependencies(input: Readonly<{
  direction?: string;
  status?: string;
  provider?: "xai" | "openai" | "gemini";
  existing?: Record<string, unknown> | null;
  aggregate?: Record<string, unknown>;
  organizationAggregate?: number;
  tenantCredential?: string | null;
}> = {}) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    void params;
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return result();
    if (sql.includes("SELECT c.status, c.direction")) {
      return result([{
        status: input.status ?? "active",
        direction: input.direction ?? "web",
        settings: {
          voice_provider: input.provider ?? "xai",
          speech_guardrail: { mode: "enforce" },
        },
      }]);
    }
    if (sql.includes("SELECT authority_id, provider")) {
      return result(input.existing ? [input.existing] : []);
    }
    if (sql.includes("pg_advisory_xact_lock")) return result([{}]);
    if (sql.includes("claimed_at >= (") && !sql.includes("count(*)")) {
      return result([{ reserved_micro_usd: input.organizationAggregate ?? 0 }]);
    }
    if (sql.includes("count(*)::int AS response_count")) {
      return result([input.aggregate ?? {
        response_count: 0,
        audio_bytes: 0,
        audio_duration_ms: 0,
        reserved_micro_usd: 0,
      }]);
    }
    if (sql.includes("INSERT INTO hacc_private.outbound_speech_asr_authorities")) {
      return result([{ authority_id: AUTHORITY_ID }], 1);
    }
    if (sql.startsWith("UPDATE hacc_private.outbound_speech_asr_authorities")) {
      return result([{}], 1);
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const release = vi.fn();
  const ids = [AUTHORITY_ID, CLAIM_TOKEN];
  const deps: OutboundSpeechAsrAuthorityDependencies = {
    connect: vi.fn(async () => ({ query, release }) as never),
    randomUUID: vi.fn(() => ids.shift() ?? CLAIM_TOKEN),
    loadTenantOpenAiCredential: vi.fn(async () =>
      input.tenantCredential === undefined ? TENANT_KEY : input.tenantCredential),
    environment: baseEnvironment(),
  };
  return { deps, query, release };
}

function existingReceipt() {
  const receipt = createGuardedSpeechAsrReceipt({
    authorityId: AUTHORITY_ID,
    organizationId: ORGANIZATION_ID,
    callId: CALL_ID,
    provider: "xai",
    responseId: INPUT.responseId,
    text: "Safe cached transcript",
    audioSha256: AUDIO_SHA256,
    audioBytes: INPUT.audioBytes,
    sampleRateHz: INPUT.sampleRateHz,
  }, RECEIPT_KEY);
  return {
    authority_id: AUTHORITY_ID,
    provider: "xai",
    audio_sha256: AUDIO_SHA256,
    audio_bytes: INPUT.audioBytes,
    sample_rate_hz: INPUT.sampleRateHz,
    audio_duration_ms: INPUT.audioDurationMs,
    state: "settled",
    receipt_json: receipt,
  };
}

describe("outbound speech ASR spend authority", () => {
  it("claims tenant-funded ASR only after locking an active tenant-owned web call", async () => {
    const { deps, query } = dependencies();
    await expect(claimOutboundSpeechAsrAuthority(INPUT, deps)).resolves.toEqual({
      kind: "claimed",
      authorityId: AUTHORITY_ID,
      claimToken: CLAIM_TOKEN,
      fundingSource: "tenant_openai_byok",
      apiKey: TENANT_KEY,
      reservedMicroUsd: 6_000,
      receiptHmacKey: RECEIPT_KEY,
    });

    const sql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("FOR UPDATE OF c");
    expect(sql).toContain("a.org_id = $2::uuid");
    expect(sql).toContain("INSERT INTO hacc_private.outbound_speech_asr_authorities");
    expect(sql).toContain("pg_advisory_xact_lock");
    const insertion = query.mock.calls.find(([statement]) =>
      statement.includes("INSERT INTO hacc_private.outbound_speech_asr_authorities"));
    expect(insertion?.[1]).toEqual([
      AUTHORITY_ID,
      ORGANIZATION_ID,
      CALL_ID,
      INPUT.responseId,
      "xai",
      AUDIO_SHA256,
      INPUT.audioBytes,
      INPUT.sampleRateHz,
      INPUT.audioDurationMs,
      6_000,
      "tenant_openai_byok",
      CLAIM_TOKEN,
    ]);
  });

  it.each([
    [{ direction: "outbound" }, "wrong_direction"],
    [{ direction: "inbound" }, "wrong_direction"],
    [{ status: "ended" }, "call_unavailable"],
    [{ provider: "openai" as const }, "provider_mismatch"],
  ])("rejects wrong call authority before any reservation", async (options, code) => {
    const { deps, query } = dependencies(options);
    await expect(claimOutboundSpeechAsrAuthority(INPUT, deps))
      .rejects.toMatchObject({ code });
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO"))).toBe(false);
    expect(deps.loadTenantOpenAiCredential).not.toHaveBeenCalled();
  });

  it("returns an exact settled replay without another reservation and rejects changed-audio replay", async () => {
    const cached = dependencies({ existing: existingReceipt(), tenantCredential: null });
    await expect(claimOutboundSpeechAsrAuthority(INPUT, cached.deps)).resolves.toMatchObject({
      kind: "cached",
      receipt: { authorityId: AUTHORITY_ID, responseId: INPUT.responseId },
      receiptHmacKey: RECEIPT_KEY,
    });
    expect(cached.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO"))).toBe(false);

    const changed = dependencies({ existing: existingReceipt() });
    await expect(claimOutboundSpeechAsrAuthority({
      ...INPUT,
      audioSha256: "b".repeat(64),
    }, changed.deps)).rejects.toMatchObject({ code: "identity_conflict" });
    expect(changed.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO"))).toBe(false);
  });

  it("rejects unsupported rates before storage and exhausts exact count/byte/time/cost totals", async () => {
    const invalid = dependencies();
    await expect(claimOutboundSpeechAsrAuthority({
      ...INPUT,
      sampleRateHz: 96_000,
      audioDurationMs: 500,
    }, invalid.deps)).rejects.toMatchObject({ code: "identity_conflict" });
    expect(invalid.deps.connect).not.toHaveBeenCalled();

    for (const aggregate of [
      { response_count: 128, audio_bytes: 0, audio_duration_ms: 0, reserved_micro_usd: 0 },
      { response_count: 0, audio_bytes: 128 * 1024 * 1024, audio_duration_ms: 0, reserved_micro_usd: 0 },
      { response_count: 0, audio_bytes: 0, audio_duration_ms: 30 * 60 * 1_000, reserved_micro_usd: 0 },
      { response_count: 0, audio_bytes: 0, audio_duration_ms: 0, reserved_micro_usd: 120_000 },
    ]) {
      const { deps, query } = dependencies({ aggregate });
      await expect(claimOutboundSpeechAsrAuthority(INPUT, deps))
        .rejects.toMatchObject({ code: "budget_exhausted" });
      expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO"))).toBe(false);
    }
  });

  it("serializes tenant BYOK under an organization-wide daily ceiling", async () => {
    const admitted = dependencies({
      organizationAggregate: 594_000,
    });
    await expect(claimOutboundSpeechAsrAuthority(INPUT, admitted.deps)).resolves.toMatchObject({
      kind: "claimed",
      fundingSource: "tenant_openai_byok",
      reservedMicroUsd: 6_000,
    });
    const statements = admitted.query.mock.calls.map(([sql]) => sql);
    expect(statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("claimed_at >= (")));
    expect(statements.findIndex((sql) => sql.includes("claimed_at >= (")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("INSERT INTO")));

    const exhausted = dependencies({
      organizationAggregate: 600_000,
    });
    await expect(claimOutboundSpeechAsrAuthority(INPUT, exhausted.deps))
      .rejects.toMatchObject({ code: "budget_exhausted" });
    expect(exhausted.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO"))).toBe(false);
  });

  it("never treats a deployment OpenAI root as browser ASR spend authority", async () => {
    const unavailable = dependencies({ tenantCredential: null });
    (unavailable.deps.environment as Record<string, string>).OPENAI_API_KEY =
      "shared-deployment-root-that-must-not-authorize-asr";
    await expect(claimOutboundSpeechAsrAuthority(INPUT, unavailable.deps))
      .rejects.toMatchObject({ code: "funding_unavailable" });
    expect(unavailable.deps.connect).toHaveBeenCalledOnce();
    expect(unavailable.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO"))).toBe(false);
  });

  it("requires one exact lifecycle transition and never reopens a consumed claim", async () => {
    const dispatched = dependencies();
    await markOutboundSpeechAsrDispatched({
      authorityId: AUTHORITY_ID,
      claimToken: CLAIM_TOKEN,
    }, dispatched.deps);
    expect(dispatched.query.mock.calls[0]?.[0]).toContain("state = 'claimed'");
    expect(dispatched.query.mock.calls[0]?.[0]).toContain("state = 'dispatched'");

    const receipt = existingReceipt().receipt_json;
    const settled = dependencies();
    await settleOutboundSpeechAsrAuthority({
      authorityId: AUTHORITY_ID,
      claimToken: CLAIM_TOKEN,
      receipt,
    }, settled.deps);
    expect(settled.query.mock.calls[0]?.[0]).toContain("state = 'dispatched'");
    expect(settled.query.mock.calls[0]?.[0]).toContain("state = 'settled'");

    const indeterminate = dependencies();
    await failOutboundSpeechAsrAuthority({
      authorityId: AUTHORITY_ID,
      claimToken: CLAIM_TOKEN,
      afterDispatch: true,
      failureCode: "settlement_unknown",
    }, indeterminate.deps);
    expect(indeterminate.query.mock.calls[0]?.[0]).toContain("state = 'indeterminate'");

    const providerUnknown = dependencies();
    await failOutboundSpeechAsrAuthority({
      authorityId: AUTHORITY_ID,
      claimToken: CLAIM_TOKEN,
      afterDispatch: true,
      failureCode: "provider_outcome_unknown",
    }, providerUnknown.deps);
    expect(providerUnknown.query.mock.calls[0]?.[0]).toContain("state = 'indeterminate'");
    expect(providerUnknown.query.mock.calls[0]?.[0]).not.toContain("state = 'failed'");

    const consumed = dependencies();
    consumed.query.mockImplementationOnce(async () => result([], 0));
    await expect(markOutboundSpeechAsrDispatched({
      authorityId: AUTHORITY_ID,
      claimToken: CLAIM_TOKEN,
    }, consumed.deps)).rejects.toEqual(expect.objectContaining({
      name: "OutboundSpeechAsrAuthorityError",
      code: "already_consumed",
    } satisfies Partial<OutboundSpeechAsrAuthorityError>));
  });
});
