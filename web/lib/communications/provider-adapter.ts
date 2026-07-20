import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Provider-neutral communication boundary.
 *
 * This module deliberately does not mint approval or spend authority. A caller
 * must inject a durable authority verifier, and provider I/O is unreachable
 * until that verifier confirms exclusive ownership of an exact reservation.
 */

export const COMMUNICATION_ADAPTER_CONTRACT_VERSION =
  "hacc.communication-adapter.v1" as const;
export const COMMUNICATION_QUOTE_SCHEMA_VERSION =
  "hacc.communication-quote.v1" as const;
export const COMMUNICATION_RECEIPT_SCHEMA_VERSION =
  "hacc.communication-receipt.v1" as const;

export type CommunicationOperation =
  | "email.send"
  | "sms.send"
  | "voice.call"
  | "phone-number.purchase";

export type CommunicationIdempotencyMode =
  | "provider-key"
  | "exclusive-framework-ledger";

export type CommunicationReconciliationMode =
  | "verified-webhook-and-authoritative-read"
  | "authoritative-read";

export type CommunicationOperationContractV1 = Readonly<{
  pricingFormulaVersion: string;
  unitKind: string;
  idempotency: CommunicationIdempotencyMode;
  reconciliation: CommunicationReconciliationMode;
}>;

export type CommunicationAdapterDescriptorV1 = Readonly<{
  contractVersion: typeof COMMUNICATION_ADAPTER_CONTRACT_VERSION;
  adapterId: string;
  providerId: string;
  adapterVersion: string;
  configurationSchemaVersion: string;
  webhookVerificationVersion: string;
  operations: Readonly<Partial<Record<CommunicationOperation, CommunicationOperationContractV1>>>;
}>;

export type ValidatedCommunicationConfigurationV1<Configuration> = Readonly<{
  /** Private provider configuration. It is never included in a public receipt. */
  value: Configuration;
  /** Private provider account identity, checked against provider evidence. */
  providerAccountId: string;
  /**
   * Domain-separated digest over dispatch-relevant configuration, including
   * credential/key revision. The runtime wraps this in a keyed public binding.
   */
  configurationIdentitySha256: string;
}>;

export type PreparedCommunicationRequestV1<PreparedRequest> = Readonly<{
  /** Private exact provider destination: email, E.164 number, or purchased E.164 number. */
  destinationIdentity: string;
  /** Provider-ready request. Public artifacts include only a keyed binding. */
  value: PreparedRequest;
}>;

export type ProviderPriceQuoteV1 = Readonly<{
  currency: "USD";
  units: number;
  reservationMicroUsd: number;
  validForSeconds: number;
  pricingSnapshotSha256: string;
  formulaSha256: string;
  limitsSha256: string;
}>;

export type CommunicationQuoteV1 = Readonly<{
  schemaVersion: typeof COMMUNICATION_QUOTE_SCHEMA_VERSION;
  adapterId: string;
  providerId: string;
  operation: CommunicationOperation;
  configurationBindingSha256: string;
  accountBindingSha256: string;
  destinationBindingSha256: string;
  requestBindingSha256: string;
  pricingFormulaVersion: string;
  pricingSnapshotSha256: string;
  formulaSha256: string;
  limitsSha256: string;
  currency: "USD";
  unitKind: string;
  units: number;
  reservationMicroUsd: number;
  quotedAt: string;
  validUntil: string;
  quoteSha256: string;
}>;

export type FundedCommunicationAuthorityExpectationV1 = Readonly<{
  contractVersion: typeof COMMUNICATION_ADAPTER_CONTRACT_VERSION;
  approvalId: string;
  adapterId: string;
  providerId: string;
  operation: CommunicationOperation;
  quoteSha256: string;
  configurationBindingSha256: string;
  accountBindingSha256: string;
  destinationBindingSha256: string;
  requestBindingSha256: string;
  pricingFormulaVersion: string;
  pricingSnapshotSha256: string;
  formulaSha256: string;
  limitsSha256: string;
  unitKind: string;
  units: number;
  reservationMicroUsd: number;
}>;

export type VerifiedFundedCommunicationAuthorityV1 = Readonly<{
  state: "reserved-and-exclusively-owned";
  approvalId: string;
  executionId: string;
  /** Must equal executionId; the model cannot choose this value. */
  idempotencyKey: string;
  quoteSha256: string;
  units: number;
  reservationMicroUsd: number;
  expiresAt: string;
}>;

export interface FundedCommunicationAuthorityVerifierV1 {
  verify(
    expectation: FundedCommunicationAuthorityExpectationV1
  ): Promise<VerifiedFundedCommunicationAuthorityV1 | null>;
}

export type ProviderDispatchContextV1 = Readonly<{
  executionId: string;
  idempotencyKey: string;
  reservationMicroUsd: number;
  signal?: AbortSignal;
}>;

export type ProviderDispatchOutcomeV1 =
  | Readonly<{
      status: "accepted";
      providerMessageId: string;
      providerAccountId: string;
      providerDestination: string;
      idempotencyKey: string;
    }>
  | Readonly<{
      status: "rejected";
      code: string;
    }>
  | Readonly<{
      status: "indeterminate";
      code: string;
    }>;

export type ProviderReconciliationOutcomeV1 =
  | Readonly<{
      status: "pending";
      providerMessageId: string;
      providerAccountId: string;
      providerDestination: string;
      idempotencyKey: string;
    }>
  | Readonly<{
      status: "delivered" | "terminal_failure";
      providerStatus: string;
      providerMessageId: string;
      providerAccountId: string;
      providerDestination: string;
      idempotencyKey: string;
      sequence: number;
    }>
  | Readonly<{
      status: "authoritative_absent" | "unknown";
      idempotencyKey: string;
    }>;

export type CommunicationWebhookRequestV1 = Readonly<{
  method: "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  rawBody: Uint8Array;
}>;

export type VerifiedProviderWebhookEventV1 = Readonly<{
  status: "delivered" | "terminal_failure";
  providerStatus: string;
  providerMessageId: string;
  providerAccountId: string;
  providerDestination: string;
  sequence: number;
}>;

export interface CommunicationProviderAdapterV1<Configuration, PreparedRequest> {
  readonly descriptor: CommunicationAdapterDescriptorV1;
  validateConfiguration(
    rawConfiguration: unknown
  ): Promise<ValidatedCommunicationConfigurationV1<Configuration>>;
  prepareRequest(input: Readonly<{
    operation: CommunicationOperation;
    destination: unknown;
    payload: unknown;
  }>): Promise<PreparedCommunicationRequestV1<PreparedRequest>>;
  quote(input: Readonly<{
    operation: CommunicationOperation;
    configuration: Configuration;
    request: PreparedRequest;
    quotedAt: Date;
  }>): Promise<ProviderPriceQuoteV1>;
  dispatch(input: Readonly<{
    operation: CommunicationOperation;
    configuration: Configuration;
    request: PreparedRequest;
    approvedQuote: CommunicationQuoteV1;
    context: ProviderDispatchContextV1;
  }>): Promise<ProviderDispatchOutcomeV1>;
  reconcile(input: Readonly<{
    operation: CommunicationOperation;
    configuration: Configuration;
    providerMessageId?: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }>): Promise<ProviderReconciliationOutcomeV1>;
  verifyWebhook(input: Readonly<{
    configuration: Configuration;
    request: CommunicationWebhookRequestV1;
  }>): Promise<VerifiedProviderWebhookEventV1 | null>;
}

export type AcceptedCommunicationReceiptV1 = Readonly<{
  schemaVersion: typeof COMMUNICATION_RECEIPT_SCHEMA_VERSION;
  status: "accepted";
  evidenceSource: "provider-dispatch-response" | "authoritative-provider-read";
  verifiedTerminal: false;
  retrySafe: false;
  adapterId: string;
  providerId: string;
  operation: CommunicationOperation;
  approvalId: string;
  executionId: string;
  idempotencyKey: string;
  providerMessageId: string;
  configurationBindingSha256: string;
  accountBindingSha256: string;
  destinationBindingSha256: string;
  requestBindingSha256: string;
  quoteSha256: string;
  acceptedAt: string;
}>;

export type TerminalCommunicationReceiptV1 = Readonly<{
  schemaVersion: typeof COMMUNICATION_RECEIPT_SCHEMA_VERSION;
  status: "delivered" | "terminal_failure";
  evidenceSource: "verified-provider-webhook" | "authoritative-provider-read";
  verifiedTerminal: true;
  retrySafe: false;
  adapterId: string;
  providerId: string;
  operation: CommunicationOperation;
  approvalId: string;
  executionId: string;
  idempotencyKey: string;
  providerMessageId: string;
  providerStatus: string;
  configurationBindingSha256: string;
  accountBindingSha256: string;
  destinationBindingSha256: string;
  requestBindingSha256: string;
  quoteSha256: string;
  sequence: number;
  verifiedAt: string;
  terminalProofSha256: string;
}>;

export type NonAcceptedCommunicationReceiptV1 = Readonly<{
  schemaVersion: typeof COMMUNICATION_RECEIPT_SCHEMA_VERSION;
  status: "rejected" | "indeterminate";
  code: string;
  verifiedTerminal: false;
  retrySafe: false;
  adapterId: string;
  providerId: string;
  operation: CommunicationOperation;
  approvalId: string;
  executionId: string;
  idempotencyKey: string;
  configurationBindingSha256: string;
  accountBindingSha256: string;
  destinationBindingSha256: string;
  requestBindingSha256: string;
  quoteSha256: string;
  recordedAt: string;
}>;

export type CommunicationDispatchReceiptV1 =
  | AcceptedCommunicationReceiptV1
  | NonAcceptedCommunicationReceiptV1;

export type CommunicationReconciliationResultV1 =
  | Readonly<{ status: "pending"; receipt: AcceptedCommunicationReceiptV1 }>
  | Readonly<{ status: "delivered" | "terminal_failure"; receipt: TerminalCommunicationReceiptV1 }>
  | Readonly<{
      status: "authoritative_absent" | "unknown";
      retrySafe: false;
      idempotencyKey: string;
    }>;

type QuoteInput = Readonly<{
  adapter: CommunicationProviderAdapterV1<unknown, unknown>;
  rawConfiguration: unknown;
  operation: CommunicationOperation;
  destination: unknown;
  payload: unknown;
  receiptBindingSecret: string;
  now?: Date;
}>;

const IDENTIFIER = /^[a-z][a-z0-9.-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const UNIT_KIND = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const STABLE_CODE = /^[a-z][a-z0-9_]{0,127}$/;
const OPERATIONS = Object.freeze([
  "email.send",
  "phone-number.purchase",
  "sms.send",
  "voice.call",
] as const);
const OPERATION_SET = new Set<string>(OPERATIONS);
const MAX_CANONICAL_BYTES = 64 * 1024;
const MAX_CANONICAL_DEPTH = 16;
const MAX_CANONICAL_NODES = 2_048;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_WEBHOOK_BYTES = 64 * 1024;
const MAX_WEBHOOK_HEADERS = 64;
const MAX_QUOTE_TTL_SECONDS = 86_400;

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function boundedText(value: unknown, label: string, maximum = MAX_TEXT_BYTES): string {
  assertCondition(typeof value === "string", `${label} must be text`);
  assertCondition(
    value.length > 0 && value.trim() === value &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      Buffer.byteLength(value, "utf8") <= maximum,
    `${label} must be bounded control-free text`
  );
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  assertCondition(
    value !== null && typeof value === "object" && !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `${label} must be a plain object`
  );
  const record = value as Record<string, unknown>;
  assertCondition(Object.getOwnPropertySymbols(record).length === 0, `${label} has symbol keys`);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  assertCondition(
    actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]),
    `${label} has an unsupported shape`
  );
  return record;
}

function canonicalJson(value: unknown): string {
  let nodes = 0;
  const active = new Set<object>();
  function visit(current: unknown, depth: number): string {
    nodes += 1;
    assertCondition(nodes <= MAX_CANONICAL_NODES, "communication value is too complex");
    assertCondition(depth <= MAX_CANONICAL_DEPTH, "communication value is too deep");
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      assertCondition(Number.isFinite(current), "communication number must be finite");
      return JSON.stringify(Object.is(current, -0) ? 0 : current);
    }
    assertCondition(typeof current === "object", "communication value is not JSON-compatible");
    const object = current as object;
    assertCondition(!active.has(object), "communication value is cyclic");
    active.add(object);
    let result: string;
    if (Array.isArray(current)) {
      assertCondition(current.length <= MAX_CANONICAL_NODES, "communication array is too large");
      result = `[${current.map((entry) => visit(entry, depth + 1)).join(",")}]`;
    } else {
      assertCondition(
        Object.getPrototypeOf(current) === Object.prototype,
        "communication value must use plain objects"
      );
      assertCondition(
        Object.getOwnPropertySymbols(current).length === 0,
        "communication value has symbol keys"
      );
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      result = `{${keys.map((key) =>
        `${JSON.stringify(key)}:${visit(record[key], depth + 1)}`
      ).join(",")}}`;
    }
    active.delete(object);
    return result;
  }
  const serialized = visit(value, 0);
  assertCondition(
    Buffer.byteLength(serialized, "utf8") <= MAX_CANONICAL_BYTES,
    "communication value is too large"
  );
  return serialized;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function receiptSecret(value: string): Buffer {
  assertCondition(
    typeof value === "string" && value.length >= 32 && value.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(value),
    "communication receipt binding secret must contain 32-256 control-free characters"
  );
  return Buffer.from(value, "utf8");
}

function keyedBinding(secret: string, label: string, value: unknown): string {
  return createHmac("sha256", receiptSecret(secret))
    .update(`harshas-amazing-call-center/communications/${label}/v1\n`, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function canonicalTimestamp(value: Date, label: string): string {
  assertCondition(value instanceof Date && Number.isFinite(value.getTime()), `${label} is invalid`);
  return value.toISOString();
}

function parseTimestamp(value: unknown, label: string): number {
  assertCondition(
    typeof value === "string" && value === new Date(value).toISOString(),
    `${label} must be a canonical timestamp`
  );
  const timestamp = Date.parse(value);
  assertCondition(Number.isFinite(timestamp), `${label} is invalid`);
  return timestamp;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  assertCondition(
    Number.isSafeInteger(value) && Number(value) >= minimum,
    `${label} must be a safe integer of at least ${minimum}`
  );
  return Number(value);
}

function descriptorOf(
  adapter: CommunicationProviderAdapterV1<unknown, unknown>
): CommunicationAdapterDescriptorV1 {
  const descriptor = adapter?.descriptor;
  exactRecord(descriptor, [
    "adapterId",
    "adapterVersion",
    "configurationSchemaVersion",
    "contractVersion",
    "operations",
    "providerId",
    "webhookVerificationVersion",
  ], "communication adapter descriptor");
  assertCondition(
    descriptor.contractVersion === COMMUNICATION_ADAPTER_CONTRACT_VERSION,
    "unsupported communication adapter contract"
  );
  assertCondition(IDENTIFIER.test(descriptor.adapterId), "invalid communication adapter id");
  assertCondition(IDENTIFIER.test(descriptor.providerId), "invalid communication provider id");
  assertCondition(VERSION.test(descriptor.adapterVersion), "invalid communication adapter version");
  assertCondition(
    VERSION.test(descriptor.configurationSchemaVersion),
    "invalid communication configuration schema version"
  );
  assertCondition(
    VERSION.test(descriptor.webhookVerificationVersion),
    "invalid communication webhook verification version"
  );
  assertCondition(
    descriptor.operations !== null && typeof descriptor.operations === "object" &&
      !Array.isArray(descriptor.operations) &&
      Object.getPrototypeOf(descriptor.operations) === Object.prototype,
    "communication operations must be a plain object"
  );
  const operationKeys = Object.keys(descriptor.operations);
  assertCondition(operationKeys.length > 0, "communication adapter has no operations");
  for (const operation of operationKeys) {
    assertCondition(OPERATION_SET.has(operation), `unsupported communication operation ${operation}`);
    const contract = descriptor.operations[operation as CommunicationOperation];
    exactRecord(contract, [
      "idempotency",
      "pricingFormulaVersion",
      "reconciliation",
      "unitKind",
    ], `communication operation ${operation}`);
    assertCondition(
      VERSION.test(contract!.pricingFormulaVersion),
      `invalid pricing formula version for ${operation}`
    );
    assertCondition(UNIT_KIND.test(contract!.unitKind), `invalid unit kind for ${operation}`);
    assertCondition(
      contract!.idempotency === "provider-key" ||
        contract!.idempotency === "exclusive-framework-ledger",
      `invalid idempotency mode for ${operation}`
    );
    assertCondition(
      contract!.reconciliation === "verified-webhook-and-authoritative-read" ||
        contract!.reconciliation === "authoritative-read",
      `invalid reconciliation mode for ${operation}`
    );
  }
  return descriptor;
}

function operationContract(
  descriptor: CommunicationAdapterDescriptorV1,
  operation: CommunicationOperation
): CommunicationOperationContractV1 {
  const contract = descriptor.operations[operation];
  assertCondition(contract, `communication adapter does not support ${operation}`);
  return contract;
}

function validateConfigured<Configuration>(
  configured: ValidatedCommunicationConfigurationV1<Configuration>
): ValidatedCommunicationConfigurationV1<Configuration> {
  exactRecord(configured, [
    "configurationIdentitySha256",
    "providerAccountId",
    "value",
  ], "validated communication configuration");
  boundedText(configured.providerAccountId, "provider account identity", 2_048);
  assertCondition(
    SHA256.test(configured.configurationIdentitySha256),
    "configuration identity must be lowercase SHA-256"
  );
  return configured;
}

function validatePrepared<PreparedRequest>(
  prepared: PreparedCommunicationRequestV1<PreparedRequest>
): PreparedCommunicationRequestV1<PreparedRequest> {
  exactRecord(prepared, ["destinationIdentity", "value"], "prepared communication request");
  boundedText(prepared.destinationIdentity, "provider destination identity", 2_048);
  canonicalJson(prepared.value);
  return prepared;
}

function validatePriceQuote(
  quote: ProviderPriceQuoteV1,
  expectedFormulaVersion: string
): ProviderPriceQuoteV1 {
  exactRecord(quote, [
    "currency",
    "formulaSha256",
    "limitsSha256",
    "pricingSnapshotSha256",
    "reservationMicroUsd",
    "units",
    "validForSeconds",
  ], "provider price quote");
  assertCondition(quote.currency === "USD", "provider price quote must use USD");
  safeInteger(quote.units, "provider price quote units", 1);
  safeInteger(quote.reservationMicroUsd, "provider price quote reservation", 0);
  const ttl = safeInteger(quote.validForSeconds, "provider price quote TTL", 1);
  assertCondition(ttl <= MAX_QUOTE_TTL_SECONDS, "provider price quote TTL is too long");
  for (const [label, digest] of [
    ["pricing snapshot", quote.pricingSnapshotSha256],
    ["pricing formula", quote.formulaSha256],
    ["action limits", quote.limitsSha256],
  ] as const) {
    assertCondition(SHA256.test(digest), `${label} must be lowercase SHA-256`);
  }
  assertCondition(VERSION.test(expectedFormulaVersion), "invalid expected pricing formula version");
  return quote;
}

async function resolveQuoteContext<Configuration, PreparedRequest>(
  input: Readonly<{
    adapter: CommunicationProviderAdapterV1<Configuration, PreparedRequest>;
    rawConfiguration: unknown;
    operation: CommunicationOperation;
    destination: unknown;
    payload: unknown;
    receiptBindingSecret: string;
    quotedAt: Date;
  }>
) {
  const descriptor = descriptorOf(
    input.adapter as CommunicationProviderAdapterV1<unknown, unknown>
  );
  const contract = operationContract(descriptor, input.operation);
  receiptSecret(input.receiptBindingSecret);
  const configured = validateConfigured(
    await input.adapter.validateConfiguration(input.rawConfiguration)
  );
  const prepared = validatePrepared(await input.adapter.prepareRequest({
    operation: input.operation,
    destination: input.destination,
    payload: input.payload,
  }));
  const descriptorSha256 = sha256(descriptor);
  const configurationBindingSha256 = keyedBinding(
    input.receiptBindingSecret,
    "configuration-binding",
    {
      adapter_id: descriptor.adapterId,
      configuration_identity_sha256: configured.configurationIdentitySha256,
      descriptor_sha256: descriptorSha256,
      provider_id: descriptor.providerId,
    }
  );
  const accountBindingSha256 = keyedBinding(
    input.receiptBindingSecret,
    "account-binding",
    {
      adapter_id: descriptor.adapterId,
      configuration_binding_sha256: configurationBindingSha256,
      provider_account_id: configured.providerAccountId,
      provider_id: descriptor.providerId,
    }
  );
  const destinationBindingSha256 = keyedBinding(
    input.receiptBindingSecret,
    "destination-binding",
    {
      account_binding_sha256: accountBindingSha256,
      destination_identity: prepared.destinationIdentity,
      operation: input.operation,
    }
  );
  const requestBindingSha256 = keyedBinding(
    input.receiptBindingSecret,
    "request-binding",
    {
      destination_binding_sha256: destinationBindingSha256,
      operation: input.operation,
      provider_request: prepared.value,
    }
  );
  const price = validatePriceQuote(await input.adapter.quote({
    operation: input.operation,
    configuration: configured.value,
    request: prepared.value,
    quotedAt: input.quotedAt,
  }), contract.pricingFormulaVersion);
  return {
    descriptor,
    contract,
    configured,
    prepared,
    price,
    configurationBindingSha256,
    accountBindingSha256,
    destinationBindingSha256,
    requestBindingSha256,
  };
}

function quoteCore(
  context: Awaited<ReturnType<typeof resolveQuoteContext>>,
  operation: CommunicationOperation,
  quotedAt: Date
): Omit<CommunicationQuoteV1, "quoteSha256"> {
  const quotedAtText = canonicalTimestamp(quotedAt, "quote time");
  const validUntil = new Date(quotedAt.getTime() + context.price.validForSeconds * 1_000);
  return {
    schemaVersion: COMMUNICATION_QUOTE_SCHEMA_VERSION,
    adapterId: context.descriptor.adapterId,
    providerId: context.descriptor.providerId,
    operation,
    configurationBindingSha256: context.configurationBindingSha256,
    accountBindingSha256: context.accountBindingSha256,
    destinationBindingSha256: context.destinationBindingSha256,
    requestBindingSha256: context.requestBindingSha256,
    pricingFormulaVersion: context.contract.pricingFormulaVersion,
    pricingSnapshotSha256: context.price.pricingSnapshotSha256,
    formulaSha256: context.price.formulaSha256,
    limitsSha256: context.price.limitsSha256,
    currency: "USD",
    unitKind: context.contract.unitKind,
    units: context.price.units,
    reservationMicroUsd: context.price.reservationMicroUsd,
    quotedAt: quotedAtText,
    validUntil: validUntil.toISOString(),
  };
}

function quoteWithDigest(
  core: Omit<CommunicationQuoteV1, "quoteSha256">
): CommunicationQuoteV1 {
  return Object.freeze({ ...core, quoteSha256: sha256(core) });
}

function parseQuote(value: unknown): CommunicationQuoteV1 {
  const quote = exactRecord(value, [
    "accountBindingSha256",
    "adapterId",
    "configurationBindingSha256",
    "currency",
    "destinationBindingSha256",
    "formulaSha256",
    "limitsSha256",
    "operation",
    "pricingFormulaVersion",
    "pricingSnapshotSha256",
    "providerId",
    "quotedAt",
    "quoteSha256",
    "requestBindingSha256",
    "reservationMicroUsd",
    "schemaVersion",
    "unitKind",
    "units",
    "validUntil",
  ], "communication quote");
  assertCondition(
    quote.schemaVersion === COMMUNICATION_QUOTE_SCHEMA_VERSION,
    "unsupported communication quote"
  );
  assertCondition(
    typeof quote.operation === "string" && OPERATION_SET.has(quote.operation),
    "invalid communication quote operation"
  );
  assertCondition(
    quote.currency === "USD" &&
      typeof quote.adapterId === "string" && IDENTIFIER.test(quote.adapterId) &&
      typeof quote.providerId === "string" && IDENTIFIER.test(quote.providerId) &&
      typeof quote.pricingFormulaVersion === "string" && VERSION.test(quote.pricingFormulaVersion) &&
      typeof quote.unitKind === "string" && UNIT_KIND.test(quote.unitKind),
    "invalid communication quote identity"
  );
  safeInteger(quote.units, "communication quote units", 1);
  safeInteger(quote.reservationMicroUsd, "communication quote reservation", 0);
  for (const [label, digest] of [
    ["configuration binding", quote.configurationBindingSha256],
    ["account binding", quote.accountBindingSha256],
    ["destination binding", quote.destinationBindingSha256],
    ["request binding", quote.requestBindingSha256],
    ["pricing snapshot", quote.pricingSnapshotSha256],
    ["pricing formula", quote.formulaSha256],
    ["action limits", quote.limitsSha256],
    ["quote", quote.quoteSha256],
  ] as const) {
    assertCondition(typeof digest === "string" && SHA256.test(digest), `${label} is invalid`);
  }
  const quotedAt = parseTimestamp(quote.quotedAt, "quote quotedAt");
  const validUntil = parseTimestamp(quote.validUntil, "quote validUntil");
  assertCondition(
    validUntil > quotedAt && validUntil - quotedAt <= MAX_QUOTE_TTL_SECONDS * 1_000,
    "communication quote validity window is invalid"
  );
  const { quoteSha256, ...core } = quote;
  assertCondition(
    sameDigest(quoteSha256 as string, sha256(core)),
    "communication quote digest mismatch"
  );
  return Object.freeze(quote as unknown as CommunicationQuoteV1);
}

function exactQuote(left: CommunicationQuoteV1, right: CommunicationQuoteV1): boolean {
  return sameDigest(left.quoteSha256, right.quoteSha256) &&
    canonicalJson(left) === canonicalJson(right);
}

export async function quoteCommunication(
  input: QuoteInput
): Promise<CommunicationQuoteV1> {
  const quotedAt = input.now ?? new Date();
  const context = await resolveQuoteContext({
    ...input,
    quotedAt,
  });
  return quoteWithDigest(quoteCore(context, input.operation, quotedAt));
}

function authorityExpectation(
  approvalId: string,
  quote: CommunicationQuoteV1
): FundedCommunicationAuthorityExpectationV1 {
  assertCondition(UUID.test(approvalId), "communication approval id must be a UUID");
  return Object.freeze({
    contractVersion: COMMUNICATION_ADAPTER_CONTRACT_VERSION,
    approvalId,
    adapterId: quote.adapterId,
    providerId: quote.providerId,
    operation: quote.operation,
    quoteSha256: quote.quoteSha256,
    configurationBindingSha256: quote.configurationBindingSha256,
    accountBindingSha256: quote.accountBindingSha256,
    destinationBindingSha256: quote.destinationBindingSha256,
    requestBindingSha256: quote.requestBindingSha256,
    pricingFormulaVersion: quote.pricingFormulaVersion,
    pricingSnapshotSha256: quote.pricingSnapshotSha256,
    formulaSha256: quote.formulaSha256,
    limitsSha256: quote.limitsSha256,
    unitKind: quote.unitKind,
    units: quote.units,
    reservationMicroUsd: quote.reservationMicroUsd,
  });
}

function validateAuthority(
  value: VerifiedFundedCommunicationAuthorityV1 | null,
  expectation: FundedCommunicationAuthorityExpectationV1,
  now: Date
): VerifiedFundedCommunicationAuthorityV1 {
  assertCondition(value, "funded communication authority was denied");
  exactRecord(value, [
    "approvalId",
    "executionId",
    "expiresAt",
    "idempotencyKey",
    "quoteSha256",
    "reservationMicroUsd",
    "state",
    "units",
  ], "funded communication authority");
  assertCondition(
    value.state === "reserved-and-exclusively-owned" &&
      value.approvalId === expectation.approvalId &&
      UUID.test(value.executionId) &&
      value.idempotencyKey === value.executionId &&
      value.quoteSha256 === expectation.quoteSha256 &&
      value.units === expectation.units &&
      value.reservationMicroUsd === expectation.reservationMicroUsd,
    "funded communication authority does not match the exact reservation"
  );
  assertCondition(
    parseTimestamp(value.expiresAt, "funded communication authority expiry") > now.getTime(),
    "funded communication authority expired"
  );
  return value;
}

function outcomeCode(value: unknown, fallback: string): string {
  return typeof value === "string" && STABLE_CODE.test(value) ? value : fallback;
}

function baseReceipt(
  context: Awaited<ReturnType<typeof resolveQuoteContext>>,
  quote: CommunicationQuoteV1,
  approvalId: string,
  authority: VerifiedFundedCommunicationAuthorityV1
) {
  return {
    schemaVersion: COMMUNICATION_RECEIPT_SCHEMA_VERSION,
    adapterId: context.descriptor.adapterId,
    providerId: context.descriptor.providerId,
    operation: quote.operation,
    approvalId,
    executionId: authority.executionId,
    idempotencyKey: authority.idempotencyKey,
    configurationBindingSha256: quote.configurationBindingSha256,
    accountBindingSha256: quote.accountBindingSha256,
    destinationBindingSha256: quote.destinationBindingSha256,
    requestBindingSha256: quote.requestBindingSha256,
    quoteSha256: quote.quoteSha256,
  } as const;
}

function providerIdentityMatches(
  context: Awaited<ReturnType<typeof resolveQuoteContext>>,
  input: Readonly<{
    providerAccountId: string;
    providerDestination: string;
    idempotencyKey: string;
  }>,
  authority: VerifiedFundedCommunicationAuthorityV1
): boolean {
  return input.providerAccountId === context.configured.providerAccountId &&
    input.providerDestination === context.prepared.destinationIdentity &&
    input.idempotencyKey === authority.idempotencyKey;
}

function acceptedReceipt(
  base: ReturnType<typeof baseReceipt>,
  providerMessageId: string,
  acceptedAt: Date,
  evidenceSource: AcceptedCommunicationReceiptV1["evidenceSource"]
): AcceptedCommunicationReceiptV1 {
  boundedText(providerMessageId, "provider message identity", 2_048);
  return Object.freeze({
    ...base,
    status: "accepted",
    evidenceSource,
    verifiedTerminal: false,
    retrySafe: false,
    providerMessageId,
    acceptedAt: canonicalTimestamp(acceptedAt, "acceptance time"),
  });
}

function nonAcceptedReceipt(
  base: ReturnType<typeof baseReceipt>,
  status: NonAcceptedCommunicationReceiptV1["status"],
  code: string,
  recordedAt: Date
): NonAcceptedCommunicationReceiptV1 {
  return Object.freeze({
    ...base,
    status,
    code,
    verifiedTerminal: false,
    retrySafe: false,
    recordedAt: canonicalTimestamp(recordedAt, "receipt time"),
  });
}

export async function dispatchCommunication(
  input: QuoteInput & Readonly<{
    approvedQuote: unknown;
    approvalId: string;
    authorityVerifier: FundedCommunicationAuthorityVerifierV1;
    signal?: AbortSignal;
  }>
): Promise<CommunicationDispatchReceiptV1> {
  const now = input.now ?? new Date();
  const quote = parseQuote(input.approvedQuote);
  assertCondition(
    quote.operation === input.operation,
    "approved communication quote operation changed"
  );
  assertCondition(
    parseTimestamp(quote.validUntil, "communication quote validUntil") > now.getTime(),
    "approved communication quote expired"
  );
  const quotedAt = new Date(parseTimestamp(quote.quotedAt, "communication quote quotedAt"));
  const context = await resolveQuoteContext({
    adapter: input.adapter,
    rawConfiguration: input.rawConfiguration,
    operation: input.operation,
    destination: input.destination,
    payload: input.payload,
    receiptBindingSecret: input.receiptBindingSecret,
    quotedAt,
  });
  const currentQuote = quoteWithDigest(quoteCore(context, input.operation, quotedAt));
  assertCondition(
    exactQuote(quote, currentQuote),
    "approved communication quote no longer matches configuration, request, or pricing"
  );
  const expectation = authorityExpectation(input.approvalId, quote);
  const authority = validateAuthority(
    await input.authorityVerifier.verify(expectation),
    expectation,
    now
  );
  const base = baseReceipt(context, quote, input.approvalId, authority);

  let outcome: ProviderDispatchOutcomeV1;
  try {
    outcome = await input.adapter.dispatch({
      operation: input.operation,
      configuration: context.configured.value,
      request: context.prepared.value,
      approvedQuote: quote,
      context: Object.freeze({
        executionId: authority.executionId,
        idempotencyKey: authority.idempotencyKey,
        reservationMicroUsd: authority.reservationMicroUsd,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    });
  } catch {
    // Once provider dispatch is entered, an exception cannot prove absence.
    return nonAcceptedReceipt(base, "indeterminate", "provider_outcome_unknown", now);
  }

  if (!outcome || typeof outcome !== "object") {
    return nonAcceptedReceipt(base, "indeterminate", "provider_evidence_invalid", now);
  }
  if (outcome.status === "accepted") {
    try {
      exactRecord(outcome, [
        "idempotencyKey",
        "providerAccountId",
        "providerDestination",
        "providerMessageId",
        "status",
      ], "accepted provider outcome");
      assertCondition(
        providerIdentityMatches(context, outcome, authority),
        "accepted provider identity mismatch"
      );
      return acceptedReceipt(
        base,
        outcome.providerMessageId,
        now,
        "provider-dispatch-response"
      );
    } catch {
      return nonAcceptedReceipt(base, "indeterminate", "provider_evidence_invalid", now);
    }
  }
  if (outcome.status === "rejected") {
    try {
      exactRecord(outcome, ["code", "status"], "rejected provider outcome");
      return nonAcceptedReceipt(base, "rejected", outcomeCode(outcome.code, "provider_rejected"), now);
    } catch {
      return nonAcceptedReceipt(base, "indeterminate", "provider_evidence_invalid", now);
    }
  }
  if (outcome.status === "indeterminate") {
    try {
      exactRecord(outcome, ["code", "status"], "indeterminate provider outcome");
      return nonAcceptedReceipt(
        base,
        "indeterminate",
        outcomeCode(outcome.code, "provider_outcome_unknown"),
        now
      );
    } catch {
      return nonAcceptedReceipt(base, "indeterminate", "provider_evidence_invalid", now);
    }
  }
  return nonAcceptedReceipt(base, "indeterminate", "provider_evidence_invalid", now);
}

function parseDispatchReceipt(
  value: CommunicationDispatchReceiptV1
): CommunicationDispatchReceiptV1 {
  assertCondition(
    value && value.schemaVersion === COMMUNICATION_RECEIPT_SCHEMA_VERSION &&
      (value.status === "accepted" || value.status === "indeterminate"),
    "only accepted or indeterminate communication receipts can be reconciled"
  );
  assertCondition(
    UUID.test(value.approvalId) && UUID.test(value.executionId) &&
      value.idempotencyKey === value.executionId,
    "communication receipt authority identity is invalid"
  );
  return value;
}

function validateReconciliationIdentity(
  context: Readonly<{
    configured: Readonly<{ providerAccountId: string }>;
    prepared: Readonly<{ destinationIdentity: string }>;
  }>,
  outcome: Exclude<ProviderReconciliationOutcomeV1, {
    status: "authoritative_absent" | "unknown";
  }>,
  receipt: CommunicationDispatchReceiptV1
): void {
  boundedText(outcome.providerMessageId, "provider message identity", 2_048);
  assertCondition(
    outcome.providerAccountId === context.configured.providerAccountId &&
      outcome.providerDestination === context.prepared.destinationIdentity &&
      outcome.idempotencyKey === receipt.idempotencyKey,
    "provider reconciliation identity mismatch"
  );
  if (receipt.status === "accepted") {
    assertCondition(
      outcome.providerMessageId === receipt.providerMessageId,
      "provider reconciliation message identity mismatch"
    );
  }
}

function terminalReceipt(
  input: Readonly<{
    accepted: AcceptedCommunicationReceiptV1;
    status: TerminalCommunicationReceiptV1["status"];
    providerStatus: string;
    sequence: number;
    verifiedAt: Date;
    evidenceSource: TerminalCommunicationReceiptV1["evidenceSource"];
    receiptBindingSecret: string;
  }>
): TerminalCommunicationReceiptV1 {
  boundedText(input.providerStatus, "provider terminal status", 256);
  safeInteger(input.sequence, "provider event sequence", 0);
  const core = {
    schemaVersion: COMMUNICATION_RECEIPT_SCHEMA_VERSION,
    status: input.status,
    evidenceSource: input.evidenceSource,
    verifiedTerminal: true as const,
    retrySafe: false as const,
    adapterId: input.accepted.adapterId,
    providerId: input.accepted.providerId,
    operation: input.accepted.operation,
    approvalId: input.accepted.approvalId,
    executionId: input.accepted.executionId,
    idempotencyKey: input.accepted.idempotencyKey,
    providerMessageId: input.accepted.providerMessageId,
    providerStatus: input.providerStatus,
    configurationBindingSha256: input.accepted.configurationBindingSha256,
    accountBindingSha256: input.accepted.accountBindingSha256,
    destinationBindingSha256: input.accepted.destinationBindingSha256,
    requestBindingSha256: input.accepted.requestBindingSha256,
    quoteSha256: input.accepted.quoteSha256,
    sequence: input.sequence,
    verifiedAt: canonicalTimestamp(input.verifiedAt, "terminal verification time"),
  };
  return Object.freeze({
    ...core,
    terminalProofSha256: keyedBinding(
      input.receiptBindingSecret,
      "terminal-proof",
      core
    ),
  });
}

async function reconciliationContext<Configuration, PreparedRequest>(
  input: Readonly<{
    adapter: CommunicationProviderAdapterV1<Configuration, PreparedRequest>;
    rawConfiguration: unknown;
    operation: CommunicationOperation;
    destination: unknown;
    payload: unknown;
    receiptBindingSecret: string;
    receipt: CommunicationDispatchReceiptV1;
  }>
) {
  const receipt = parseDispatchReceipt(input.receipt);
  const descriptor = descriptorOf(
    input.adapter as CommunicationProviderAdapterV1<unknown, unknown>
  );
  operationContract(descriptor, input.operation);
  assertCondition(
    receipt.adapterId === descriptor.adapterId &&
      receipt.providerId === descriptor.providerId &&
      receipt.operation === input.operation,
    "communication receipt does not belong to this adapter operation"
  );
  const configured = validateConfigured(
    await input.adapter.validateConfiguration(input.rawConfiguration)
  );
  const prepared = validatePrepared(await input.adapter.prepareRequest({
    operation: input.operation,
    destination: input.destination,
    payload: input.payload,
  }));
  const descriptorSha256 = sha256(descriptor);
  const configurationBindingSha256 = keyedBinding(
    input.receiptBindingSecret,
    "configuration-binding",
    {
      adapter_id: descriptor.adapterId,
      configuration_identity_sha256: configured.configurationIdentitySha256,
      descriptor_sha256: descriptorSha256,
      provider_id: descriptor.providerId,
    }
  );
  const accountBindingSha256 = keyedBinding(
    input.receiptBindingSecret,
    "account-binding",
    {
      adapter_id: descriptor.adapterId,
      configuration_binding_sha256: configurationBindingSha256,
      provider_account_id: configured.providerAccountId,
      provider_id: descriptor.providerId,
    }
  );
  const destinationBindingSha256 = keyedBinding(
    input.receiptBindingSecret,
    "destination-binding",
    {
      account_binding_sha256: accountBindingSha256,
      destination_identity: prepared.destinationIdentity,
      operation: input.operation,
    }
  );
  const requestBindingSha256 = keyedBinding(
    input.receiptBindingSecret,
    "request-binding",
    {
      destination_binding_sha256: destinationBindingSha256,
      operation: input.operation,
      provider_request: prepared.value,
    }
  );
  assertCondition(
    sameDigest(receipt.configurationBindingSha256, configurationBindingSha256) &&
      sameDigest(receipt.accountBindingSha256, accountBindingSha256) &&
      sameDigest(receipt.destinationBindingSha256, destinationBindingSha256) &&
      sameDigest(receipt.requestBindingSha256, requestBindingSha256),
    "communication receipt configuration or request binding changed"
  );
  return { receipt, descriptor, configured, prepared };
}

export async function reconcileCommunication(
  input: Readonly<{
    adapter: CommunicationProviderAdapterV1<unknown, unknown>;
    rawConfiguration: unknown;
    operation: CommunicationOperation;
    destination: unknown;
    payload: unknown;
    receiptBindingSecret: string;
    receipt: CommunicationDispatchReceiptV1;
    now?: Date;
    signal?: AbortSignal;
  }>
): Promise<CommunicationReconciliationResultV1> {
  const now = input.now ?? new Date();
  const context = await reconciliationContext(input);
  let outcome: ProviderReconciliationOutcomeV1;
  try {
    outcome = await input.adapter.reconcile({
      operation: input.operation,
      configuration: context.configured.value,
      ...(context.receipt.status === "accepted"
        ? { providerMessageId: context.receipt.providerMessageId }
        : {}),
      idempotencyKey: context.receipt.idempotencyKey,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch {
    return Object.freeze({
      status: "unknown",
      retrySafe: false,
      idempotencyKey: context.receipt.idempotencyKey,
    });
  }
  if (!outcome || typeof outcome !== "object") {
    return Object.freeze({
      status: "unknown",
      retrySafe: false,
      idempotencyKey: context.receipt.idempotencyKey,
    });
  }
  if (outcome.status === "authoritative_absent" || outcome.status === "unknown") {
    try {
      exactRecord(outcome, ["idempotencyKey", "status"], "provider reconciliation outcome");
      assertCondition(
        outcome.idempotencyKey === context.receipt.idempotencyKey,
        "provider reconciliation idempotency identity mismatch"
      );
      return Object.freeze({
        status: outcome.status,
        retrySafe: false,
        idempotencyKey: context.receipt.idempotencyKey,
      });
    } catch {
      return Object.freeze({
        status: "unknown",
        retrySafe: false,
        idempotencyKey: context.receipt.idempotencyKey,
      });
    }
  }
  try {
    if (outcome.status === "pending") {
      exactRecord(outcome, [
        "idempotencyKey",
        "providerAccountId",
        "providerDestination",
        "providerMessageId",
        "status",
      ], "pending provider reconciliation");
      validateReconciliationIdentity(context, outcome, context.receipt);
      const accepted = context.receipt.status === "accepted"
        ? context.receipt
        : acceptedReceipt(
            {
              schemaVersion: COMMUNICATION_RECEIPT_SCHEMA_VERSION,
              adapterId: context.receipt.adapterId,
              providerId: context.receipt.providerId,
              operation: context.receipt.operation,
              approvalId: context.receipt.approvalId,
              executionId: context.receipt.executionId,
              idempotencyKey: context.receipt.idempotencyKey,
              configurationBindingSha256: context.receipt.configurationBindingSha256,
              accountBindingSha256: context.receipt.accountBindingSha256,
              destinationBindingSha256: context.receipt.destinationBindingSha256,
              requestBindingSha256: context.receipt.requestBindingSha256,
              quoteSha256: context.receipt.quoteSha256,
            },
            outcome.providerMessageId,
            now,
            "authoritative-provider-read"
          );
      return Object.freeze({ status: "pending", receipt: accepted });
    }
    if (outcome.status !== "delivered" && outcome.status !== "terminal_failure") {
      return Object.freeze({
        status: "unknown",
        retrySafe: false,
        idempotencyKey: context.receipt.idempotencyKey,
      });
    }
    exactRecord(outcome, [
      "idempotencyKey",
      "providerAccountId",
      "providerDestination",
      "providerMessageId",
      "providerStatus",
      "sequence",
      "status",
    ], "terminal provider reconciliation");
    validateReconciliationIdentity(context, outcome, context.receipt);
    const accepted = context.receipt.status === "accepted"
      ? context.receipt
      : acceptedReceipt(
          {
            schemaVersion: COMMUNICATION_RECEIPT_SCHEMA_VERSION,
            adapterId: context.receipt.adapterId,
            providerId: context.receipt.providerId,
            operation: context.receipt.operation,
            approvalId: context.receipt.approvalId,
            executionId: context.receipt.executionId,
            idempotencyKey: context.receipt.idempotencyKey,
            configurationBindingSha256: context.receipt.configurationBindingSha256,
            accountBindingSha256: context.receipt.accountBindingSha256,
            destinationBindingSha256: context.receipt.destinationBindingSha256,
            requestBindingSha256: context.receipt.requestBindingSha256,
            quoteSha256: context.receipt.quoteSha256,
          },
          outcome.providerMessageId,
          now,
          "authoritative-provider-read"
        );
    const receipt = terminalReceipt({
      accepted,
      status: outcome.status,
      providerStatus: outcome.providerStatus,
      sequence: outcome.sequence,
      verifiedAt: now,
      evidenceSource: "authoritative-provider-read",
      receiptBindingSecret: input.receiptBindingSecret,
    });
    return Object.freeze({ status: outcome.status, receipt });
  } catch {
    return Object.freeze({
      status: "unknown",
      retrySafe: false,
      idempotencyKey: context.receipt.idempotencyKey,
    });
  }
}

function normalizeWebhookRequest(value: CommunicationWebhookRequestV1): CommunicationWebhookRequestV1 {
  exactRecord(value, ["headers", "method", "rawBody", "url"], "communication webhook request");
  assertCondition(value.method === "POST", "communication webhook must use POST");
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("communication webhook URL is invalid");
  }
  assertCondition(
    url.protocol === "https:" && !url.username && !url.password &&
      Buffer.byteLength(url.href, "utf8") <= MAX_TEXT_BYTES,
    "communication webhook URL must be credential-free HTTPS"
  );
  assertCondition(
    value.rawBody instanceof Uint8Array && value.rawBody.byteLength <= MAX_WEBHOOK_BYTES,
    "communication webhook body is invalid"
  );
  assertCondition(
    value.headers !== null && typeof value.headers === "object" &&
      !Array.isArray(value.headers) &&
      Object.getPrototypeOf(value.headers) === Object.prototype,
    "communication webhook headers must be a plain object"
  );
  const entries = Object.entries(value.headers);
  assertCondition(entries.length <= MAX_WEBHOOK_HEADERS, "communication webhook has too many headers");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    assertCondition(
      /^[a-z0-9-]{1,128}$/.test(name) && name === name.toLowerCase(),
      "communication webhook header names must be normalized"
    );
    headers[name] = boundedText(headerValue, `communication webhook ${name}`, MAX_TEXT_BYTES);
  }
  return Object.freeze({
    method: "POST",
    url: url.href,
    headers: Object.freeze(headers),
    rawBody: new Uint8Array(value.rawBody),
  });
}

export async function reconcileCommunicationWebhook(
  input: Readonly<{
    adapter: CommunicationProviderAdapterV1<unknown, unknown>;
    rawConfiguration: unknown;
    operation: CommunicationOperation;
    destination: unknown;
    payload: unknown;
    receiptBindingSecret: string;
    acceptedReceipt: AcceptedCommunicationReceiptV1;
    webhook: CommunicationWebhookRequestV1;
    now?: Date;
  }>
): Promise<TerminalCommunicationReceiptV1> {
  const now = input.now ?? new Date();
  const context = await reconciliationContext({
    adapter: input.adapter,
    rawConfiguration: input.rawConfiguration,
    operation: input.operation,
    destination: input.destination,
    payload: input.payload,
    receiptBindingSecret: input.receiptBindingSecret,
    receipt: input.acceptedReceipt,
  });
  assertCondition(
    context.receipt.status === "accepted",
    "verified webhook reconciliation requires an accepted receipt"
  );
  const contract = operationContract(context.descriptor, input.operation);
  assertCondition(
    contract.reconciliation === "verified-webhook-and-authoritative-read",
    "communication operation does not admit webhook reconciliation"
  );
  const verified = await input.adapter.verifyWebhook({
    configuration: context.configured.value,
    request: normalizeWebhookRequest(input.webhook),
  });
  assertCondition(verified, "communication webhook verification failed");
  exactRecord(verified, [
    "providerAccountId",
    "providerDestination",
    "providerMessageId",
    "providerStatus",
    "sequence",
    "status",
  ], "verified communication webhook event");
  assertCondition(
    verified.status === "delivered" || verified.status === "terminal_failure",
    "verified communication webhook is not terminal"
  );
  validateReconciliationIdentity(
    context,
    {
      ...verified,
      idempotencyKey: context.receipt.idempotencyKey,
    },
    context.receipt
  );
  return terminalReceipt({
    accepted: context.receipt,
    status: verified.status,
    providerStatus: verified.providerStatus,
    sequence: verified.sequence,
    verifiedAt: now,
    evidenceSource: "verified-provider-webhook",
    receiptBindingSecret: input.receiptBindingSecret,
  });
}

/**
 * Validates and detaches an adapter manifest at its source boundary.
 * Registration remains explicit; this does not auto-load arbitrary packages.
 */
export function defineCommunicationProviderAdapter<Configuration, PreparedRequest>(
  adapter: CommunicationProviderAdapterV1<Configuration, PreparedRequest>
): CommunicationProviderAdapterV1<Configuration, PreparedRequest> {
  const descriptor = descriptorOf(
    adapter as CommunicationProviderAdapterV1<unknown, unknown>
  );
  const operations: Partial<Record<CommunicationOperation, CommunicationOperationContractV1>> = {};
  for (const operation of OPERATIONS) {
    const contract = descriptor.operations[operation];
    if (contract) operations[operation] = Object.freeze({ ...contract });
  }
  return Object.freeze({
    ...adapter,
    descriptor: Object.freeze({
      ...descriptor,
      operations: Object.freeze(operations),
    }),
  });
}
