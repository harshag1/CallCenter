import { describe, expect, it, vi } from "vitest";

import {
  runTwilioPstnPreflight,
  twilioPstnPreflightExitCode,
  type TwilioPstnPreflightInput,
} from "../twilio-pstn-preflight";

const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const KEY_SID = `SK${"b".repeat(32)}`;
const KEY_SECRET = "restricted-key-secret-123456789";
const AUTH_TOKEN = "inbound-signature-auth-token-123456789";
const RECEIPT_SECRET = "telephony-only-receipt-secret-123456789";
const CALLER = "+14155550100";
const DESTINATION = "+14155550101";

function source(clean = true): TwilioPstnPreflightInput["source"] {
  return Object.freeze({
    branch: "open-source",
    commit: "c".repeat(40),
    tree: "d".repeat(40),
    clean,
  });
}

function environment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({
    TWILIO_ACCOUNT_SID: ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    TWILIO_API_KEY_TYPE: "restricted",
    TWILIO_API_KEY_ACCOUNT_SID: ACCOUNT_SID,
    TWILIO_API_KEY_SID: KEY_SID,
    TWILIO_API_KEY_SECRET: KEY_SECRET,
    TWILIO_PHONE_NUMBER: CALLER,
    TWILIO_APPROVED_TEST_TO: DESTINATION,
    TELEPHONY_RECEIPT_SECRET: RECEIPT_SECRET,
    PUBLIC_ORIGIN: "https://app.example.test",
    BRIDGE_WS_URL: "wss://bridge.example.test/stream",
    BRIDGE_PUBLIC_STREAM_URL: "wss://bridge.example.test/stream",
    ...overrides,
  });
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successfulFetch(options: Readonly<{ owned?: boolean }> = {}): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith(`/Accounts/${ACCOUNT_SID}.json`)) {
      return response({ sid: ACCOUNT_SID, status: "active", type: "Full" });
    }
    if (url.pathname.endsWith("/IncomingPhoneNumbers.json")) {
      return response({
        incoming_phone_numbers: options.owned === false ? [] : [{
          phone_number: CALLER,
          capabilities: { voice: true, sms: true },
        }],
      });
    }
    if (url.href === "https://bridge.example.test/health/ready") {
      return response({ ok: true, status: "ready", active_sessions: 0 });
    }
    throw new Error("unexpected URL");
  }) as typeof fetch;
}

function baseInput(overrides: Partial<TwilioPstnPreflightInput> = {}): TwilioPstnPreflightInput {
  return {
    environment: environment(),
    source: source(),
    requestedMaxUsd: "30",
    probeReadOnly: false,
    now: () => new Date("2026-08-01T23:30:00.000Z"),
    ...overrides,
  };
}

describe("Twilio PSTN provider-safe preflight", () => {
  it("admits valid local configuration without touching the network", async () => {
    const fetchMock = vi.fn();
    const receipt = await runTwilioPstnPreflight(baseInput({ fetchImpl: fetchMock as typeof fetch }));

    expect(receipt.ready).toBe(true);
    expect(receipt.blockers).toEqual([]);
    expect(receipt.probes).toMatchObject({
      explicitly_requested: false,
      network_policy: "disabled",
      account: { status: "not_requested" },
      owned_voice_caller: { status: "not_requested" },
      bridge_readiness: { status: "not_requested" },
    });
    expect(receipt.safety).toEqual({
      calls_created: 0,
      sms_created: 0,
      provider_mutations: 0,
      secrets_emitted: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports missing approved destination and receipt secret without probing", async () => {
    const fetchMock = vi.fn();
    const receipt = await runTwilioPstnPreflight(baseInput({
      environment: environment({
        TWILIO_APPROVED_TEST_TO: undefined,
        TELEPHONY_RECEIPT_SECRET: undefined,
      }),
      probeReadOnly: true,
      fetchImpl: fetchMock as typeof fetch,
    }));

    expect(receipt.ready).toBe(false);
    expect(twilioPstnPreflightExitCode(receipt)).toBe(2);
    expect(receipt.blockers.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "approved_destination_missing",
      "telephony_receipt_secret_invalid",
    ]));
    expect(receipt.probes.account.status).toBe("skipped_local_blockers");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the legacy same-origin /api/bridge path", async () => {
    const receipt = await runTwilioPstnPreflight(baseInput({
      environment: environment({ BRIDGE_WS_URL: "wss://app.example.test/api/bridge" }),
    }));

    expect(receipt.ready).toBe(false);
    expect(receipt.blockers.map(({ code }) => code)).toContain("legacy_bridge_url");
    expect(receipt.configuration.bridge_stream_url).toBeNull();
  });

  it("rejects cross-account or non-Restricted key attestations before network access", async () => {
    const fetchMock = vi.fn();
    const receipt = await runTwilioPstnPreflight(baseInput({
      environment: environment({
        TWILIO_API_KEY_TYPE: "standard",
        TWILIO_API_KEY_ACCOUNT_SID: `AC${"e".repeat(32)}`,
      }),
      probeReadOnly: true,
      fetchImpl: fetchMock as typeof fetch,
    }));

    expect(receipt.blockers.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "twilio_key_not_restricted",
      "twilio_key_account_binding_mismatch",
    ]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces invalid API-key authentication from mocked GET probes", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "api.twilio.com") return response({ code: 20003 }, 401);
      return response({ ok: true, status: "ready", active_sessions: 0 });
    }) as typeof fetch;
    const receipt = await runTwilioPstnPreflight(baseInput({
      probeReadOnly: true,
      fetchImpl: fetchMock,
    }));

    expect(receipt.ready).toBe(false);
    expect(receipt.blockers.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "twilio_api_key_auth_rejected",
      "twilio_number_key_auth_rejected",
    ]));
    expect(receipt.probes.account).toMatchObject({
      status: "failed",
      http_status: 401,
      detail_code: "authentication_rejected",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of (fetchMock as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<[
      URL,
      RequestInit,
    ]>) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(init.redirect).toBe("error");
    }
  });

  it("rejects a caller that the read-only Twilio response does not prove is owned and voice-enabled", async () => {
    const receipt = await runTwilioPstnPreflight(baseInput({
      probeReadOnly: true,
      fetchImpl: successfulFetch({ owned: false }),
    }));

    expect(receipt.ready).toBe(false);
    expect(receipt.blockers.map(({ code }) => code)).toContain("twilio_caller_not_owned_voice_number");
    expect(receipt.probes.owned_voice_caller.detail_code).toBe("caller_not_owned_and_voice_enabled");
  });

  it("rejects a requested maximum above the fixed $30 authority ceiling", async () => {
    const fetchMock = vi.fn();
    const receipt = await runTwilioPstnPreflight(baseInput({
      requestedMaxUsd: "30.01",
      probeReadOnly: true,
      fetchImpl: fetchMock as typeof fetch,
    }));

    expect(receipt.ready).toBe(false);
    expect(receipt.authority).toMatchObject({
      requested_max_usd: 30.01,
      hard_ceiling_usd: 30,
      within_ceiling: false,
      provider_mutations_authorized: false,
    });
    expect(receipt.blockers.map(({ code }) => code)).toContain("spend_ceiling_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes all explicit read-only probes and emits no credential or phone-number preimages", async () => {
    const fetchMock = successfulFetch() as ReturnType<typeof vi.fn>;
    const receipt = await runTwilioPstnPreflight(baseInput({
      probeReadOnly: true,
      fetchImpl: fetchMock as typeof fetch,
    }));

    expect(receipt.ready).toBe(true);
    expect(twilioPstnPreflightExitCode(receipt)).toBe(0);
    expect(receipt.blockers).toEqual([]);
    expect(receipt.probes).toMatchObject({
      explicitly_requested: true,
      network_policy: "read_only_get_allowlist",
      account: { status: "passed", http_status: 200 },
      owned_voice_caller: { status: "passed", http_status: 200 },
      bridge_readiness: { status: "passed", http_status: 200 },
    });
    expect(receipt.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.next_exact_step).toContain("retain this receipt");

    const encoded = JSON.stringify(receipt);
    for (const secretOrIdentifier of [
      ACCOUNT_SID,
      KEY_SID,
      KEY_SECRET,
      AUTH_TOKEN,
      RECEIPT_SECRET,
      CALLER,
      DESTINATION,
    ]) {
      expect(encoded).not.toContain(secretOrIdentifier);
    }

    const calls = fetchMock.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(calls).toHaveLength(3);
    expect(calls.every(([, init]) => init.method === "GET" && init.body === undefined)).toBe(true);
    const readinessCall = calls.find(([url]) => url.hostname === "bridge.example.test");
    expect(new Headers(readinessCall?.[1].headers).has("authorization")).toBe(false);
  });
});
