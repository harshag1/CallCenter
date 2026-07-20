import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  COMMUNICATION_ADAPTER_CONTRACT_VERSION,
  defineCommunicationProviderAdapter,
  dispatchCommunication,
  quoteCommunication,
  reconcileCommunication,
  reconcileCommunicationWebhook,
  type CommunicationDispatchReceiptV1,
  type CommunicationOperation,
  type CommunicationProviderAdapterV1,
  type FundedCommunicationAuthorityExpectationV1,
  type FundedCommunicationAuthorityVerifierV1,
  type ProviderDispatchOutcomeV1,
  type ProviderReconciliationOutcomeV1,
  type VerifiedProviderWebhookEventV1,
} from "../provider-adapter";

const RECEIPT_SECRET = "test-only-domain-specific-receipt-secret-123456789";
const APPROVAL_ID = "00000000-0000-4000-8000-000000000401";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000402";
const NOW = new Date("2026-07-19T20:00:00.000Z");
const DISPATCH_NOW = new Date("2026-07-19T20:00:01.000Z");
const ACCOUNT = "provider-account-private";
const DESTINATION = "+14155550101";
const MESSAGE_ID = "provider-message-private";
const CONFIGURATION = Object.freeze({
  accountId: ACCOUNT,
  credentialRevision: "key-revision-7",
});
const PAYLOAD = Object.freeze({ message: "Your renewal is ready." });
const PRICING_SNAPSHOT = "1".repeat(64);
const FORMULA = "2".repeat(64);
const LIMITS = "3".repeat(64);

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type HarnessState = {
  events: string[];
  dispatchOutcome: ProviderDispatchOutcomeV1;
  reconciliationOutcome: ProviderReconciliationOutcomeV1;
  webhookEvent: VerifiedProviderWebhookEventV1 | null;
  reservationMicroUsd: number;
  pricingSnapshotSha256: string;
};

function operationContracts() {
  return {
    "email.send": {
      pricingFormulaVersion: "email-v1",
      unitKind: "email_send",
      idempotency: "provider-key",
      reconciliation: "verified-webhook-and-authoritative-read",
    },
    "sms.send": {
      pricingFormulaVersion: "sms-v1",
      unitKind: "sms_segment",
      idempotency: "provider-key",
      reconciliation: "verified-webhook-and-authoritative-read",
    },
    "voice.call": {
      pricingFormulaVersion: "voice-v1",
      unitKind: "voice_minute",
      idempotency: "exclusive-framework-ledger",
      reconciliation: "verified-webhook-and-authoritative-read",
    },
    "phone-number.purchase": {
      pricingFormulaVersion: "number-v1",
      unitKind: "number_month",
      idempotency: "exclusive-framework-ledger",
      reconciliation: "authoritative-read",
    },
  } as const;
}

function makeHarness(): {
  state: HarnessState;
  adapter: CommunicationProviderAdapterV1<unknown, unknown>;
} {
  const state: HarnessState = {
    events: [],
    dispatchOutcome: {
      status: "accepted",
      providerMessageId: MESSAGE_ID,
      providerAccountId: ACCOUNT,
      providerDestination: DESTINATION,
      idempotencyKey: EXECUTION_ID,
    },
    reconciliationOutcome: {
      status: "pending",
      providerMessageId: MESSAGE_ID,
      providerAccountId: ACCOUNT,
      providerDestination: DESTINATION,
      idempotencyKey: EXECUTION_ID,
    },
    webhookEvent: {
      status: "delivered",
      providerStatus: "delivered",
      providerMessageId: MESSAGE_ID,
      providerAccountId: ACCOUNT,
      providerDestination: DESTINATION,
      sequence: 7,
    },
    reservationMicroUsd: 12_345,
    pricingSnapshotSha256: PRICING_SNAPSHOT,
  };
  const adapter = defineCommunicationProviderAdapter<unknown, unknown>({
    descriptor: {
      contractVersion: COMMUNICATION_ADAPTER_CONTRACT_VERSION,
      adapterId: "synthetic-communications",
      providerId: "synthetic-provider",
      adapterVersion: "1.0.0",
      configurationSchemaVersion: "config-v1",
      webhookVerificationVersion: "signature-v1",
      operations: operationContracts(),
    },
    async validateConfiguration(rawConfiguration) {
      state.events.push("validate-configuration");
      const value = rawConfiguration as typeof CONFIGURATION;
      if (!value || value.accountId !== ACCOUNT || !value.credentialRevision) {
        throw new Error("invalid synthetic configuration");
      }
      return {
        value,
        providerAccountId: value.accountId,
        configurationIdentitySha256: digest({
          account: value.accountId,
          credentialRevision: value.credentialRevision,
        }),
      };
    },
    async prepareRequest({ operation, destination, payload }) {
      state.events.push("prepare-request");
      if (typeof destination !== "string" || !destination.startsWith("+")) {
        throw new Error("invalid synthetic destination");
      }
      return {
        destinationIdentity: destination,
        value: { operation, destination, payload },
      };
    },
    async quote() {
      state.events.push("quote");
      return {
        currency: "USD",
        units: 1,
        reservationMicroUsd: state.reservationMicroUsd,
        validForSeconds: 300,
        pricingSnapshotSha256: state.pricingSnapshotSha256,
        formulaSha256: FORMULA,
        limitsSha256: LIMITS,
      };
    },
    async dispatch({ context }) {
      state.events.push("dispatch");
      expect(context.executionId).toBe(EXECUTION_ID);
      expect(context.idempotencyKey).toBe(EXECUTION_ID);
      expect(context.reservationMicroUsd).toBe(state.reservationMicroUsd);
      return state.dispatchOutcome;
    },
    async reconcile() {
      state.events.push("reconcile");
      return state.reconciliationOutcome;
    },
    async verifyWebhook({ request }) {
      state.events.push("verify-webhook");
      return request.headers["x-synthetic-signature"] === "valid"
        ? state.webhookEvent
        : null;
    },
  });
  return { state, adapter };
}

function authorityVerifier(
  events: string[],
  mutate?: (
    expectation: FundedCommunicationAuthorityExpectationV1
  ) => Partial<Awaited<ReturnType<FundedCommunicationAuthorityVerifierV1["verify"]>>>
): FundedCommunicationAuthorityVerifierV1 & {
  verify: ReturnType<typeof vi.fn>;
} {
  const verify = vi.fn(async (expectation: FundedCommunicationAuthorityExpectationV1) => {
    events.push("verify-authority");
    return {
      state: "reserved-and-exclusively-owned" as const,
      approvalId: APPROVAL_ID,
      executionId: EXECUTION_ID,
      idempotencyKey: EXECUTION_ID,
      quoteSha256: expectation.quoteSha256,
      units: expectation.units,
      reservationMicroUsd: expectation.reservationMicroUsd,
      expiresAt: "2026-07-19T20:04:00.000Z",
      ...(mutate?.(expectation) ?? {}),
    };
  });
  return { verify };
}

async function quoteFor(
  adapter: CommunicationProviderAdapterV1<unknown, unknown>,
  operation: CommunicationOperation = "voice.call"
) {
  return quoteCommunication({
    adapter,
    rawConfiguration: CONFIGURATION,
    operation,
    destination: DESTINATION,
    payload: PAYLOAD,
    receiptBindingSecret: RECEIPT_SECRET,
    now: NOW,
  });
}

async function dispatchFor(
  adapter: CommunicationProviderAdapterV1<unknown, unknown>,
  verifier: FundedCommunicationAuthorityVerifierV1,
  approvedQuote: unknown,
  operation: CommunicationOperation = "voice.call",
  overrides: Partial<{
    rawConfiguration: unknown;
    destination: unknown;
    payload: unknown;
  }> = {}
) {
  return dispatchCommunication({
    adapter,
    rawConfiguration: overrides.rawConfiguration ?? CONFIGURATION,
    operation,
    destination: overrides.destination ?? DESTINATION,
    payload: overrides.payload ?? PAYLOAD,
    receiptBindingSecret: RECEIPT_SECRET,
    approvedQuote,
    approvalId: APPROVAL_ID,
    authorityVerifier: verifier,
    now: DISPATCH_NOW,
  });
}

describe("communication provider adapter manifest", () => {
  it("deeply detaches operation contracts and rejects unsupported manifests", () => {
    const mutable = operationContracts()["email.send"];
    const adapter = defineCommunicationProviderAdapter<unknown, unknown>({
      descriptor: {
        contractVersion: COMMUNICATION_ADAPTER_CONTRACT_VERSION,
        adapterId: "email-adapter",
        providerId: "provider",
        adapterVersion: "1",
        configurationSchemaVersion: "1",
        webhookVerificationVersion: "1",
        operations: { "email.send": mutable },
      },
      validateConfiguration: vi.fn(),
      prepareRequest: vi.fn(),
      quote: vi.fn(),
      dispatch: vi.fn(),
      reconcile: vi.fn(),
      verifyWebhook: vi.fn(),
    });

    expect(Object.isFrozen(adapter)).toBe(true);
    expect(Object.isFrozen(adapter.descriptor)).toBe(true);
    expect(Object.isFrozen(adapter.descriptor.operations)).toBe(true);
    expect(Object.isFrozen(adapter.descriptor.operations["email.send"])).toBe(true);

    expect(() => defineCommunicationProviderAdapter({
      ...adapter,
      descriptor: {
        ...adapter.descriptor,
        adapterId: "../unsafe",
      },
    })).toThrow("invalid communication adapter id");
  });
});

describe("communication quote and funded dispatch conformance", () => {
  it.each([
    "email.send",
    "sms.send",
    "voice.call",
    "phone-number.purchase",
  ] as const)("supports %s without a provider-specific runtime switch", async (operation) => {
    const { adapter, state } = makeHarness();
    const quote = await quoteFor(adapter, operation);
    const verifier = authorityVerifier(state.events);
    const receipt = await dispatchFor(adapter, verifier, quote, operation);

    expect(receipt.status).toBe("accepted");
    expect(receipt.operation).toBe(operation);
    expect(receipt.verifiedTerminal).toBe(false);
    expect(receipt.retrySafe).toBe(false);
    expect(state.events.slice(-5)).toEqual([
      "validate-configuration",
      "prepare-request",
      "quote",
      "verify-authority",
      "dispatch",
    ]);
  });

  it("binds exact configuration, account, destination, request, formula, and reservation", async () => {
    const { adapter, state } = makeHarness();
    const quote = await quoteFor(adapter);
    const verifier = authorityVerifier(state.events);
    const receipt = await dispatchFor(adapter, verifier, quote);

    expect(verifier.verify).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: APPROVAL_ID,
      adapterId: "synthetic-communications",
      providerId: "synthetic-provider",
      operation: "voice.call",
      quoteSha256: quote.quoteSha256,
      configurationBindingSha256: quote.configurationBindingSha256,
      accountBindingSha256: quote.accountBindingSha256,
      destinationBindingSha256: quote.destinationBindingSha256,
      requestBindingSha256: quote.requestBindingSha256,
      pricingFormulaVersion: "voice-v1",
      pricingSnapshotSha256: PRICING_SNAPSHOT,
      formulaSha256: FORMULA,
      limitsSha256: LIMITS,
      units: 1,
      reservationMicroUsd: 12_345,
    }));
    expect(receipt).not.toHaveProperty("providerAccountId");
    expect(receipt).not.toHaveProperty("providerDestination");
    expect(JSON.stringify(receipt)).not.toContain(ACCOUNT);
    expect(JSON.stringify(receipt)).not.toContain(DESTINATION);
    expect(JSON.stringify(receipt)).not.toContain(PAYLOAD.message);
  });

  it("never enters provider dispatch before exact durable authority is verified", async () => {
    const { adapter, state } = makeHarness();
    const quote = await quoteFor(adapter);
    state.events.length = 0;
    const denied: FundedCommunicationAuthorityVerifierV1 = {
      verify: vi.fn(async () => {
        state.events.push("verify-authority");
        return null;
      }),
    };

    await expect(dispatchFor(adapter, denied, quote)).rejects.toThrow(
      "funded communication authority was denied"
    );
    expect(state.events).toEqual([
      "validate-configuration",
      "prepare-request",
      "quote",
      "verify-authority",
    ]);
    expect(state.events).not.toContain("dispatch");
  });

  it("rejects request, configuration, price, and reservation drift before provider I/O", async () => {
    const { adapter, state } = makeHarness();
    const quote = await quoteFor(adapter);
    const verifier = authorityVerifier(state.events);

    await expect(dispatchFor(adapter, verifier, quote, "voice.call", {
      payload: { message: "substituted" },
    })).rejects.toThrow("approved communication quote no longer matches");
    expect(state.events).not.toContain("dispatch");

    state.events.length = 0;
    state.pricingSnapshotSha256 = "4".repeat(64);
    await expect(dispatchFor(adapter, verifier, quote)).rejects.toThrow(
      "approved communication quote no longer matches"
    );
    expect(state.events).not.toContain("verify-authority");

    state.pricingSnapshotSha256 = PRICING_SNAPSHOT;
    const wrongReservation = authorityVerifier(state.events, () => ({
      reservationMicroUsd: 1,
    }));
    await expect(dispatchFor(adapter, wrongReservation, quote)).rejects.toThrow(
      "does not match the exact reservation"
    );
    expect(state.events.at(-1)).toBe("verify-authority");
  });

  it("forwards one stable execution id as provider idempotency identity", async () => {
    const { adapter, state } = makeHarness();
    const quote = await quoteFor(adapter, "email.send");
    const verifier = authorityVerifier(state.events);

    const first = await dispatchFor(adapter, verifier, quote, "email.send");
    const second = await dispatchFor(adapter, verifier, quote, "email.send");

    expect(first.idempotencyKey).toBe(EXECUTION_ID);
    expect(second.idempotencyKey).toBe(EXECUTION_ID);
    expect(first.quoteSha256).toBe(second.quoteSha256);
  });

  it("classifies throws and malformed post-dispatch evidence as indeterminate do-not-retry", async () => {
    const { adapter, state } = makeHarness();
    const quote = await quoteFor(adapter);
    const verifier = authorityVerifier(state.events);
    const throwingAdapter = {
      ...adapter,
      dispatch: vi.fn(async () => {
        throw new Error(`secret provider body for ${DESTINATION}`);
      }),
    };

    const thrown = await dispatchFor(throwingAdapter, verifier, quote);
    expect(thrown).toEqual(expect.objectContaining({
      status: "indeterminate",
      code: "provider_outcome_unknown",
      retrySafe: false,
    }));
    expect(JSON.stringify(thrown)).not.toContain("secret provider body");

    state.dispatchOutcome = {
      status: "accepted",
      providerMessageId: MESSAGE_ID,
      providerAccountId: "substituted-account",
      providerDestination: DESTINATION,
      idempotencyKey: EXECUTION_ID,
    };
    const malformed = await dispatchFor(adapter, verifier, quote);
    expect(malformed).toEqual(expect.objectContaining({
      status: "indeterminate",
      code: "provider_evidence_invalid",
      retrySafe: false,
    }));
  });
});

describe("accepted versus terminal reconciliation conformance", () => {
  async function acceptedFixture() {
    const harness = makeHarness();
    const quote = await quoteFor(harness.adapter);
    const receipt = await dispatchFor(
      harness.adapter,
      authorityVerifier(harness.state.events),
      quote
    );
    expect(receipt.status).toBe("accepted");
    return {
      ...harness,
      receipt: receipt as Extract<CommunicationDispatchReceiptV1, { status: "accepted" }>,
    };
  }

  it("does not turn provider acceptance into delivery", async () => {
    const { receipt } = await acceptedFixture();
    expect(receipt.status).toBe("accepted");
    expect(receipt.verifiedTerminal).toBe(false);
    expect(receipt).not.toHaveProperty("providerStatus");
    expect(receipt).not.toHaveProperty("terminalProofSha256");
  });

  it("requires a verified webhook before issuing a terminal receipt", async () => {
    const { adapter, receipt } = await acceptedFixture();
    const base = {
      adapter,
      rawConfiguration: CONFIGURATION,
      operation: "voice.call" as const,
      destination: DESTINATION,
      payload: PAYLOAD,
      receiptBindingSecret: RECEIPT_SECRET,
      acceptedReceipt: receipt,
      now: new Date("2026-07-19T20:01:00.000Z"),
    };

    await expect(reconcileCommunicationWebhook({
      ...base,
      webhook: {
        method: "POST",
        url: "https://hooks.example.test/communications",
        headers: { "x-synthetic-signature": "invalid" },
        rawBody: new TextEncoder().encode("{}"),
      },
    })).rejects.toThrow("webhook verification failed");

    const terminal = await reconcileCommunicationWebhook({
      ...base,
      webhook: {
        method: "POST",
        url: "https://hooks.example.test/communications",
        headers: { "x-synthetic-signature": "valid" },
        rawBody: new TextEncoder().encode("{}"),
      },
    });
    expect(terminal).toEqual(expect.objectContaining({
      status: "delivered",
      evidenceSource: "verified-provider-webhook",
      verifiedTerminal: true,
      providerMessageId: MESSAGE_ID,
      providerStatus: "delivered",
      sequence: 7,
      retrySafe: false,
    }));
    expect(terminal.terminalProofSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(terminal)).not.toContain(ACCOUNT);
    expect(JSON.stringify(terminal)).not.toContain(DESTINATION);
  });

  it("fails closed on webhook identity substitution and oversized input", async () => {
    const { adapter, state, receipt } = await acceptedFixture();
    state.webhookEvent = {
      ...state.webhookEvent!,
      providerDestination: "+14155550999",
    };
    await expect(reconcileCommunicationWebhook({
      adapter,
      rawConfiguration: CONFIGURATION,
      operation: "voice.call",
      destination: DESTINATION,
      payload: PAYLOAD,
      receiptBindingSecret: RECEIPT_SECRET,
      acceptedReceipt: receipt,
      webhook: {
        method: "POST",
        url: "https://hooks.example.test/communications",
        headers: { "x-synthetic-signature": "valid" },
        rawBody: new TextEncoder().encode("{}"),
      },
      now: DISPATCH_NOW,
    })).rejects.toThrow("reconciliation identity mismatch");

    await expect(reconcileCommunicationWebhook({
      adapter,
      rawConfiguration: CONFIGURATION,
      operation: "voice.call",
      destination: DESTINATION,
      payload: PAYLOAD,
      receiptBindingSecret: RECEIPT_SECRET,
      acceptedReceipt: receipt,
      webhook: {
        method: "POST",
        url: "https://hooks.example.test/communications",
        headers: { "x-synthetic-signature": "valid" },
        rawBody: new Uint8Array(64 * 1024 + 1),
      },
      now: DISPATCH_NOW,
    })).rejects.toThrow("webhook body is invalid");
  });

  it("supports authoritative pending, terminal, absent, and unknown reads without auto-retry", async () => {
    const { adapter, state, receipt } = await acceptedFixture();
    const base = {
      adapter,
      rawConfiguration: CONFIGURATION,
      operation: "voice.call" as const,
      destination: DESTINATION,
      payload: PAYLOAD,
      receiptBindingSecret: RECEIPT_SECRET,
      receipt,
      now: new Date("2026-07-19T20:02:00.000Z"),
    };

    const pending = await reconcileCommunication(base);
    expect(pending).toEqual(expect.objectContaining({ status: "pending" }));
    if (pending.status === "pending") {
      expect(pending.receipt.verifiedTerminal).toBe(false);
    }

    state.reconciliationOutcome = {
      status: "terminal_failure",
      providerStatus: "undeliverable",
      providerMessageId: MESSAGE_ID,
      providerAccountId: ACCOUNT,
      providerDestination: DESTINATION,
      idempotencyKey: EXECUTION_ID,
      sequence: 9,
    };
    const terminal = await reconcileCommunication(base);
    expect(terminal).toEqual(expect.objectContaining({ status: "terminal_failure" }));
    if (terminal.status === "terminal_failure") {
      expect(terminal.receipt.verifiedTerminal).toBe(true);
      expect(terminal.receipt.evidenceSource).toBe("authoritative-provider-read");
    }

    state.reconciliationOutcome = {
      status: "authoritative_absent",
      idempotencyKey: EXECUTION_ID,
    };
    expect(await reconcileCommunication(base)).toEqual({
      status: "authoritative_absent",
      retrySafe: false,
      idempotencyKey: EXECUTION_ID,
    });

    state.reconciliationOutcome = {
      status: "unknown",
      idempotencyKey: "substituted",
    };
    expect(await reconcileCommunication(base)).toEqual({
      status: "unknown",
      retrySafe: false,
      idempotencyKey: EXECUTION_ID,
    });
  });
});
