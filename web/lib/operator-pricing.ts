import { createHash } from "node:crypto";

/**
 * Offline, configuration-backed spend reservations for funded operator actions.
 *
 * This module deliberately does not call a provider. Deployments must configure
 * pessimistic global ceilings which cover every destination they permit. Exact
 * action inputs are committed into `limitsSha256`, allowing dispatch to compare
 * an approved quote with a freshly reconstructed quote before an irreversible
 * provider call.
 */

export const OPERATOR_COST_QUOTE_SCHEMA_VERSION = 1 as const;
export const OPERATOR_COST_QUOTE_CURRENCY = "USD" as const;
export const MAX_OPERATOR_QUOTE_TTL_SECONDS = 86_400;

export const OPERATOR_PRICING_ENV = Object.freeze({
  emailSendCeilingUsd: "HACC_OPERATOR_EMAIL_SEND_CEILING_USD",
  smsSegmentCeilingUsd: "HACC_OPERATOR_SMS_SEGMENT_CEILING_USD",
  voiceMinuteCeilingUsd: "HACC_OPERATOR_VOICE_MINUTE_CEILING_USD",
  numberMonthlyCeilingUsd: "HACC_OPERATOR_NUMBER_MONTHLY_CEILING_USD",
  callMaxDurationSeconds: "HACC_OPERATOR_CALL_MAX_DURATION_SECONDS",
  safetyMarginUsd: "HACC_OPERATOR_QUOTE_SAFETY_MARGIN_USD",
  quoteTtlSeconds: "HACC_OPERATOR_QUOTE_TTL_SECONDS",
  maxReservationUsd: "HACC_OPERATOR_QUOTE_MAX_RESERVATION_USD",
} as const);

export const MAX_OPERATOR_CALL_DURATION_SECONDS = 86_400;

export type OperatorCostUnitKind =
  | "email_send"
  | "sms_segment"
  | "voice_minute"
  | "phone_number_month";

export type OperatorCostComponentV1 = Readonly<{
  name:
    | "email_provider_send"
    | "sms_provider_segment"
    | "voice_provider_minute"
    | "phone_number_month";
  quantity: number;
  unitKind: OperatorCostUnitKind;
  unitMicroUsd: number;
  upperBoundMicroUsd: number;
  source: "operator_config";
}>;

export type OperatorCostQuoteV1 = Readonly<{
  schemaVersion: 1;
  currency: "USD";
  reservationMicroUsd: number;
  units: number;
  unitKind: OperatorCostUnitKind;
  quotedAt: string;
  validUntil: string;
  pricingSnapshotSha256: string;
  formulaSha256: string;
  limitsSha256: string;
  components: readonly OperatorCostComponentV1[];
  safetyMarginMicroUsd: number;
}>;

export type OperatorPricingEnvironment = Readonly<Record<string, string | undefined>>;

export type OperatorQuoteCreationOptions = Readonly<{
  /** Defaults to `process.env`. Tests should inject an explicit environment. */
  environment?: OperatorPricingEnvironment;
  /** Defaults to the current wall clock. */
  now?: Date;
}>;

export type EmailCostQuoteInput = Readonly<{
  recipient: string;
}>;

export type SmsCostQuoteInput = Readonly<{
  destinationE164: string;
  /** Exact segment count from the same versioned counter used at dispatch. */
  segmentCount: number;
}>;

export type VoiceCostQuoteInput = Readonly<{
  originE164: string;
  destinationE164: string;
  /** A server-enforced connected-call limit, not an answer timeout. */
  maxDurationSeconds: number;
}>;

export type VoiceCampaignCostQuoteInput = Readonly<{
  originE164: string;
  destinationE164s: readonly string[];
  /** Existing campaign authority commitment over the exact normalized target set. */
  targetSetSha256: string;
  /** A server-enforced connected-call limit applied independently to every target. */
  maxDurationSeconds: number;
}>;

export type NumberMonthlyCostQuoteInput = Readonly<{
  candidateE164: string;
  countryCode: string;
  numberType: string;
}>;

export type OperatorQuoteUseConstraints = Readonly<{
  reservationCapMicroUsd: number;
  now?: Date;
  expectedUnitKind?: OperatorCostUnitKind;
  expectedPricingSnapshotSha256?: string;
  expectedFormulaSha256?: string;
  expectedLimitsSha256?: string;
}>;

export type VoiceQuoteRuntimeConstraints = Readonly<{
  expectedUnits: number;
  maxDurationSeconds: number;
  environment?: OperatorPricingEnvironment;
}>;

export type OperatorPricingErrorCode =
  | "invalid_amount"
  | "invalid_configuration"
  | "invalid_input"
  | "invalid_quote"
  | "quote_not_yet_valid"
  | "quote_expired"
  | "quote_exceeds_cap"
  | "quote_binding_mismatch";

export class OperatorPricingError extends Error {
  readonly code: OperatorPricingErrorCode;

  constructor(code: OperatorPricingErrorCode, message: string) {
    super(message);
    this.name = "OperatorPricingError";
    this.code = code;
  }
}

export type CanonicalJsonValue =
  | null
  | boolean
  | string
  | number
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

type CommonConfig = Readonly<{
  safetyMarginMicroUsd: number;
  quoteTtlSeconds: number;
  maxReservationMicroUsd: number;
}>;

type QuoteBuildInput = Readonly<{
  unitKind: OperatorCostUnitKind;
  componentName: OperatorCostComponentV1["name"];
  quantity: number;
  unitMicroUsd: number;
  pricingEnvironmentKey: string;
  formula: CanonicalJsonValue;
  binding: CanonicalJsonValue;
  config: CommonConfig;
  now: Date;
}>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
const ISO_UTC_MILLISECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNIT_KINDS = new Set<OperatorCostUnitKind>([
  "email_send",
  "sms_segment",
  "voice_minute",
  "phone_number_month",
]);
const COMPONENT_NAMES = new Set<OperatorCostComponentV1["name"]>([
  "email_provider_send",
  "sms_provider_segment",
  "voice_provider_minute",
  "phone_number_month",
]);

const PRICING_SNAPSHOT_DOMAIN = "harshas-amazing-call-center/operator-pricing/snapshot/v1";
const FORMULA_DOMAIN = "harshas-amazing-call-center/operator-pricing/formula/v1";
const LIMITS_DOMAIN = "harshas-amazing-call-center/operator-pricing/limits/v1";

function fail(code: OperatorPricingErrorCode, message: string): never {
  throw new OperatorPricingError(code, message);
}

function assertCondition(
  condition: unknown,
  code: OperatorPricingErrorCode,
  message: string
): asserts condition {
  if (!condition) fail(code, message);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function safeAdd(left: number, right: number, code: OperatorPricingErrorCode, label: string): number {
  assertCondition(
    isSafeNonNegativeInteger(left) && isSafeNonNegativeInteger(right),
    code,
    `${label} contains an invalid integer`
  );
  assertCondition(left <= Number.MAX_SAFE_INTEGER - right, code, `${label} exceeds safe integer precision`);
  return left + right;
}

function safeMultiply(
  left: number,
  right: number,
  code: OperatorPricingErrorCode,
  label: string
): number {
  assertCondition(
    isSafeNonNegativeInteger(left) && isSafeNonNegativeInteger(right),
    code,
    `${label} contains an invalid integer`
  );
  if (left === 0 || right === 0) return 0;
  assertCondition(
    left <= Math.floor(Number.MAX_SAFE_INTEGER / right),
    code,
    `${label} exceeds safe integer precision`
  );
  return left * right;
}

/**
 * Parse a plain decimal USD string into integer micro-USD.
 *
 * Numbers, exponents, signs, whitespace, rounding, and sub-micro amounts are
 * rejected. Construction from decimal digits avoids binary floating point.
 */
export function parseUsdToMicroUsd(value: string): number {
  assertCondition(typeof value === "string", "invalid_amount", "USD amount must be a decimal string");
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value);
  assertCondition(Boolean(match), "invalid_amount", "USD amount must be a non-negative plain decimal with at most six fractional digits");

  const whole = match![1];
  const fraction = (match![2] ?? "").padEnd(6, "0");
  const microDigits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  assertCondition(microDigits.length <= 16, "invalid_amount", "USD amount exceeds safe integer precision");

  const result = Number(microDigits);
  assertCondition(Number.isSafeInteger(result), "invalid_amount", "USD amount exceeds safe integer precision");
  return result;
}

function canonicalize(value: unknown, active: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    assertCondition(
      Number.isSafeInteger(value) && !Object.is(value, -0),
      "invalid_input",
      "Canonical JSON numbers must be safe integers and may not be negative zero"
    );
    return String(value);
  }

  assertCondition(typeof value === "object", "invalid_input", "Value is not canonical JSON");
  assertCondition(!active.has(value), "invalid_input", "Canonical JSON may not contain cycles");
  assertCondition(Object.getOwnPropertySymbols(value).length === 0, "invalid_input", "Canonical JSON may not contain symbol keys");
  active.add(value);

  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      assertCondition(keys.length === value.length, "invalid_input", "Canonical JSON arrays may not be sparse");
      const encoded: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        assertCondition(keys[index] === String(index), "invalid_input", "Canonical JSON arrays may not have custom properties");
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        assertCondition(
          Boolean(descriptor) && "value" in descriptor! && descriptor!.enumerable,
          "invalid_input",
          "Canonical JSON arrays may contain only enumerable data properties"
        );
        encoded.push(canonicalize(descriptor!.value, active));
      }
      return `[${encoded.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    assertCondition(
      prototype === Object.prototype || prototype === null,
      "invalid_input",
      "Canonical JSON objects must have a plain or null prototype"
    );
    const names = Object.getOwnPropertyNames(value).sort();
    const encoded: string[] = [];
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      assertCondition(
        Boolean(descriptor) && "value" in descriptor! && descriptor!.enumerable,
        "invalid_input",
        "Canonical JSON objects may contain only enumerable data properties"
      );
      encoded.push(`${JSON.stringify(name)}:${canonicalize(descriptor!.value, active)}`);
    }
    return `{${encoded.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

/** Stable, key-sorted canonical JSON for quote evidence and deterministic tests. */
export function canonicalOperatorPricingJson(value: CanonicalJsonValue): string {
  return canonicalize(value, new Set());
}

/** Domain-separated SHA-256 over canonical JSON. */
export function operatorPricingSha256(domain: string, value: CanonicalJsonValue): string {
  assertCondition(
    typeof domain === "string" && /^[\x20-\x7e]{1,200}$/.test(domain),
    "invalid_input",
    "Hash domain must be 1-200 printable ASCII characters"
  );
  return createHash("sha256")
    .update(`${domain}\n`, "utf8")
    .update(canonicalOperatorPricingJson(value), "utf8")
    .digest("hex");
}

function readRequiredEnvironmentValue(environment: OperatorPricingEnvironment, key: string): string {
  const value = environment[key];
  assertCondition(
    typeof value === "string" && value.length > 0,
    "invalid_configuration",
    `Missing required operator pricing configuration: ${key}`
  );
  return value;
}

function readConfiguredMicroUsd(
  environment: OperatorPricingEnvironment,
  key: string,
  allowZero: boolean
): number {
  const raw = readRequiredEnvironmentValue(environment, key);
  let parsed: number;
  try {
    parsed = parseUsdToMicroUsd(raw);
  } catch {
    fail("invalid_configuration", `${key} must be an exact non-negative USD decimal with at most six fractional digits`);
  }
  assertCondition(
    allowZero ? parsed >= 0 : parsed > 0,
    "invalid_configuration",
    `${key} must be ${allowZero ? "non-negative" : "greater than zero"}`
  );
  return parsed;
}

function readCommonConfig(environment: OperatorPricingEnvironment): CommonConfig {
  const ttlRaw = readRequiredEnvironmentValue(environment, OPERATOR_PRICING_ENV.quoteTtlSeconds);
  assertCondition(
    /^(?:[1-9]\d*)$/.test(ttlRaw),
    "invalid_configuration",
    `${OPERATOR_PRICING_ENV.quoteTtlSeconds} must be a positive integer`
  );
  const quoteTtlSeconds = Number(ttlRaw);
  assertCondition(
    Number.isSafeInteger(quoteTtlSeconds) && quoteTtlSeconds <= MAX_OPERATOR_QUOTE_TTL_SECONDS,
    "invalid_configuration",
    `${OPERATOR_PRICING_ENV.quoteTtlSeconds} must be at most ${MAX_OPERATOR_QUOTE_TTL_SECONDS}`
  );

  return Object.freeze({
    safetyMarginMicroUsd: readConfiguredMicroUsd(
      environment,
      OPERATOR_PRICING_ENV.safetyMarginUsd,
      true
    ),
    quoteTtlSeconds,
    maxReservationMicroUsd: readConfiguredMicroUsd(
      environment,
      OPERATOR_PRICING_ENV.maxReservationUsd,
      false
    ),
  });
}

/** Resolve an optional per-call duration against the deployment's hard cap. */
export function resolveVoiceMaxDurationSeconds(
  requested: unknown,
  environment: OperatorPricingEnvironment = process.env
): number {
  const configured = readRequiredEnvironmentValue(
    environment,
    OPERATOR_PRICING_ENV.callMaxDurationSeconds
  );
  assertCondition(
    /^(?:[1-9]\d*)$/.test(configured),
    "invalid_configuration",
    `${OPERATOR_PRICING_ENV.callMaxDurationSeconds} must be a positive integer`
  );
  const hardCap = Number(configured);
  assertCondition(
    Number.isSafeInteger(hardCap) && hardCap <= MAX_OPERATOR_CALL_DURATION_SECONDS,
    "invalid_configuration",
    `${OPERATOR_PRICING_ENV.callMaxDurationSeconds} must be at most ${MAX_OPERATOR_CALL_DURATION_SECONDS}`
  );
  if (requested === undefined || requested === null) return hardCap;
  assertCondition(
    isSafePositiveInteger(requested) && requested <= hardCap,
    "invalid_input",
    `Requested call duration must be a positive integer no greater than ${hardCap}`
  );
  return requested;
}

function resolveEnvironment(options: OperatorQuoteCreationOptions): OperatorPricingEnvironment {
  return options.environment ?? process.env;
}

function resolveNow(now: Date | undefined, code: OperatorPricingErrorCode): Date {
  assertCondition(now === undefined || now instanceof Date, code, "Quote clock must be a Date");
  const resolved = now === undefined ? new Date() : new Date(now.getTime());
  assertCondition(Number.isFinite(resolved.getTime()), code, "Quote clock must be a valid Date");
  return resolved;
}

function assertE164(value: unknown, label: string): asserts value is string {
  assertCondition(typeof value === "string" && E164_PATTERN.test(value), "invalid_input", `${label} must be canonical E.164`);
}

function deepFreezeQuote(quote: OperatorCostQuoteV1): OperatorCostQuoteV1 {
  const components = Object.freeze(quote.components.map((component) => Object.freeze({ ...component })));
  return Object.freeze({ ...quote, components });
}

function buildQuote(input: QuoteBuildInput): OperatorCostQuoteV1 {
  assertCondition(isSafePositiveInteger(input.quantity), "invalid_input", "Quote quantity must be a positive safe integer");
  assertCondition(isSafePositiveInteger(input.unitMicroUsd), "invalid_configuration", "Configured unit ceiling must be positive");

  const upperBoundMicroUsd = safeMultiply(
    input.quantity,
    input.unitMicroUsd,
    "invalid_amount",
    "Quote component upper bound"
  );
  const reservationMicroUsd = safeAdd(
    upperBoundMicroUsd,
    input.config.safetyMarginMicroUsd,
    "invalid_amount",
    "Quote reservation"
  );

  assertCondition(
    reservationMicroUsd <= input.config.maxReservationMicroUsd,
    "quote_exceeds_cap",
    "Operator action reservation exceeds the configured maximum"
  );

  const quotedAt = input.now.toISOString();
  const validUntilMs = input.now.getTime() + input.config.quoteTtlSeconds * 1_000;
  assertCondition(Number.isFinite(validUntilMs), "invalid_input", "Quote expiry exceeds the supported clock range");
  const validUntil = new Date(validUntilMs).toISOString();

  const pricingSnapshotSha256 = operatorPricingSha256(PRICING_SNAPSHOT_DOMAIN, {
    ceilingMicroUsd: input.unitMicroUsd,
    environmentKey: input.pricingEnvironmentKey,
    schemaVersion: 1,
    source: "operator_config",
    unitKind: input.unitKind,
  });
  const formulaSha256 = operatorPricingSha256(FORMULA_DOMAIN, input.formula);
  const limitsSha256 = operatorPricingSha256(LIMITS_DOMAIN, {
    actionBinding: input.binding,
    maxReservationMicroUsd: input.config.maxReservationMicroUsd,
    quoteTtlSeconds: input.config.quoteTtlSeconds,
    safetyMarginMicroUsd: input.config.safetyMarginMicroUsd,
    schemaVersion: 1,
    unitKind: input.unitKind,
    units: input.quantity,
  });

  return deepFreezeQuote({
    schemaVersion: OPERATOR_COST_QUOTE_SCHEMA_VERSION,
    currency: OPERATOR_COST_QUOTE_CURRENCY,
    reservationMicroUsd,
    units: input.quantity,
    unitKind: input.unitKind,
    quotedAt,
    validUntil,
    pricingSnapshotSha256,
    formulaSha256,
    limitsSha256,
    components: [{
      name: input.componentName,
      quantity: input.quantity,
      unitKind: input.unitKind,
      unitMicroUsd: input.unitMicroUsd,
      upperBoundMicroUsd,
      source: "operator_config",
    }],
    safetyMarginMicroUsd: input.config.safetyMarginMicroUsd,
  });
}

export function createEmailCostQuote(
  input: EmailCostQuoteInput,
  options: OperatorQuoteCreationOptions = {}
): OperatorCostQuoteV1 {
  assertCondition(
    typeof input.recipient === "string"
      && input.recipient.length <= 320
      && input.recipient === input.recipient.trim()
      && /^[^\s@]+@[^\s@]+$/.test(input.recipient),
    "invalid_input",
    "Email quote recipient must be a bounded, normalized email address"
  );
  const environment = resolveEnvironment(options);
  const config = readCommonConfig(environment);
  const unitMicroUsd = readConfiguredMicroUsd(
    environment,
    OPERATOR_PRICING_ENV.emailSendCeilingUsd,
    false
  );

  return buildQuote({
    unitKind: "email_send",
    componentName: "email_provider_send",
    quantity: 1,
    unitMicroUsd,
    pricingEnvironmentKey: OPERATOR_PRICING_ENV.emailSendCeilingUsd,
    formula: {
      formula: "quantity_times_configured_ceiling_plus_safety_margin",
      quantity: "one_email_send",
      schemaVersion: 1,
    },
    binding: { recipient: input.recipient },
    config,
    now: resolveNow(options.now, "invalid_input"),
  });
}

export function createSmsCostQuote(
  input: SmsCostQuoteInput,
  options: OperatorQuoteCreationOptions = {}
): OperatorCostQuoteV1 {
  assertE164(input.destinationE164, "SMS destination");
  assertCondition(
    isSafePositiveInteger(input.segmentCount),
    "invalid_input",
    "SMS segment count must be an exact positive safe integer"
  );
  const environment = resolveEnvironment(options);
  const config = readCommonConfig(environment);
  const unitMicroUsd = readConfiguredMicroUsd(
    environment,
    OPERATOR_PRICING_ENV.smsSegmentCeilingUsd,
    false
  );

  return buildQuote({
    unitKind: "sms_segment",
    componentName: "sms_provider_segment",
    quantity: input.segmentCount,
    unitMicroUsd,
    pricingEnvironmentKey: OPERATOR_PRICING_ENV.smsSegmentCeilingUsd,
    formula: {
      formula: "exact_segments_times_global_destination_ceiling_plus_safety_margin",
      segmentCountSource: "dispatch_versioned_counter",
      schemaVersion: 1,
    },
    binding: {
      destinationE164: input.destinationE164,
      exactSegmentCount: input.segmentCount,
    },
    config,
    now: resolveNow(options.now, "invalid_input"),
  });
}

export function createVoiceCostQuote(
  input: VoiceCostQuoteInput,
  options: OperatorQuoteCreationOptions = {}
): OperatorCostQuoteV1 {
  assertE164(input.originE164, "Voice origin");
  assertE164(input.destinationE164, "Voice destination");
  assertCondition(
    isSafePositiveInteger(input.maxDurationSeconds),
    "invalid_input",
    "Voice maximum duration must be a positive safe integer number of seconds"
  );

  // Avoid `seconds + 59`, which could overflow at the safe-integer boundary.
  const billedMinuteCeiling = Math.floor((input.maxDurationSeconds - 1) / 60) + 1;
  assertCondition(
    isSafePositiveInteger(billedMinuteCeiling),
    "invalid_input",
    "Voice billed-minute ceiling exceeds safe integer precision"
  );

  const environment = resolveEnvironment(options);
  const config = readCommonConfig(environment);
  const unitMicroUsd = readConfiguredMicroUsd(
    environment,
    OPERATOR_PRICING_ENV.voiceMinuteCeilingUsd,
    false
  );

  return buildQuote({
    unitKind: "voice_minute",
    componentName: "voice_provider_minute",
    quantity: billedMinuteCeiling,
    unitMicroUsd,
    pricingEnvironmentKey: OPERATOR_PRICING_ENV.voiceMinuteCeilingUsd,
    formula: {
      durationRounding: "ceil_connected_seconds_divided_by_60",
      formula: "billed_minute_ceiling_times_global_route_ceiling_plus_safety_margin",
      schemaVersion: 1,
    },
    binding: {
      billedMinuteCeiling,
      destinationE164: input.destinationE164,
      maxDurationSeconds: input.maxDurationSeconds,
      originE164: input.originE164,
    },
    config,
    now: resolveNow(options.now, "invalid_input"),
  });
}

/**
 * Quote an exact campaign target set as one arithmetic component. Recipient
 * values are used only to build a domain-separated digest and never appear in
 * the returned quote, keeping the model-visible authority target-free.
 */
export function createVoiceCampaignCostQuote(
  input: VoiceCampaignCostQuoteInput,
  options: OperatorQuoteCreationOptions = {}
): OperatorCostQuoteV1 {
  assertE164(input.originE164, "Campaign voice origin");
  assertCondition(
    Array.isArray(input.destinationE164s)
      && input.destinationE164s.length >= 1
      && input.destinationE164s.length <= 5_000,
    "invalid_input",
    "Campaign voice destinations must contain 1-5000 exact targets"
  );
  const destinations = [...input.destinationE164s];
  for (const destination of destinations) assertE164(destination, "Campaign voice destination");
  const sortedDestinations = [...destinations].sort();
  assertCondition(
    sortedDestinations.every((destination, index) => index === 0 || destination !== sortedDestinations[index - 1]),
    "invalid_input",
    "Campaign voice destinations must be unique"
  );
  assertCondition(
    typeof input.targetSetSha256 === "string" && SHA256_PATTERN.test(input.targetSetSha256),
    "invalid_input",
    "Campaign target-set commitment must be lowercase SHA-256 hex"
  );
  assertCondition(
    isSafePositiveInteger(input.maxDurationSeconds),
    "invalid_input",
    "Campaign voice maximum duration must be a positive safe integer number of seconds"
  );
  const billedMinutesPerTarget = Math.floor((input.maxDurationSeconds - 1) / 60) + 1;
  const totalBilledMinuteCeiling = safeMultiply(
    billedMinutesPerTarget,
    sortedDestinations.length,
    "invalid_input",
    "Campaign billed-minute ceiling"
  );
  assertCondition(
    isSafePositiveInteger(totalBilledMinuteCeiling),
    "invalid_input",
    "Campaign billed-minute ceiling must be positive"
  );

  const environment = resolveEnvironment(options);
  const config = readCommonConfig(environment);
  const unitMicroUsd = readConfiguredMicroUsd(
    environment,
    OPERATOR_PRICING_ENV.voiceMinuteCeilingUsd,
    false
  );
  const destinationSetSha256 = operatorPricingSha256(
    "harshas-amazing-call-center/operator-pricing/campaign-destinations/v1",
    sortedDestinations
  );

  return buildQuote({
    unitKind: "voice_minute",
    componentName: "voice_provider_minute",
    quantity: totalBilledMinuteCeiling,
    unitMicroUsd,
    pricingEnvironmentKey: OPERATOR_PRICING_ENV.voiceMinuteCeilingUsd,
    formula: {
      durationRounding: "ceil_each_connected_seconds_divided_by_60",
      formula: "targets_times_billed_minute_ceiling_times_global_route_ceiling_plus_one_safety_margin",
      schemaVersion: 1,
    },
    binding: {
      billedMinutesPerTarget,
      destinationSetSha256,
      maxDurationSeconds: input.maxDurationSeconds,
      originE164: input.originE164,
      targetCount: sortedDestinations.length,
      targetSetSha256: input.targetSetSha256,
    },
    config,
    now: resolveNow(options.now, "invalid_input"),
  });
}

export function createNumberMonthlyCostQuote(
  input: NumberMonthlyCostQuoteInput,
  options: OperatorQuoteCreationOptions = {}
): OperatorCostQuoteV1 {
  assertE164(input.candidateE164, "Phone-number candidate");
  assertCondition(
    typeof input.countryCode === "string" && /^[A-Z]{2}$/.test(input.countryCode),
    "invalid_input",
    "Phone-number country code must be an uppercase ISO alpha-2 code"
  );
  assertCondition(
    typeof input.numberType === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(input.numberType),
    "invalid_input",
    "Phone-number type must be a normalized identifier"
  );
  const environment = resolveEnvironment(options);
  const config = readCommonConfig(environment);
  const unitMicroUsd = readConfiguredMicroUsd(
    environment,
    OPERATOR_PRICING_ENV.numberMonthlyCeilingUsd,
    false
  );

  return buildQuote({
    unitKind: "phone_number_month",
    componentName: "phone_number_month",
    quantity: 1,
    unitMicroUsd,
    pricingEnvironmentKey: OPERATOR_PRICING_ENV.numberMonthlyCeilingUsd,
    formula: {
      formula: "one_number_month_times_configured_ceiling_plus_safety_margin",
      schemaVersion: 1,
    },
    binding: {
      candidateE164: input.candidateE164,
      countryCode: input.countryCode,
      numberType: input.numberType,
    },
    config,
    now: resolveNow(options.now, "invalid_input"),
  });
}

function readExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> {
  assertCondition(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_quote", `${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  assertCondition(
    prototype === Object.prototype || prototype === null,
    "invalid_quote",
    `${label} must have a plain or null prototype`
  );
  assertCondition(Object.getOwnPropertySymbols(value).length === 0, "invalid_quote", `${label} may not contain symbol keys`);

  const actualKeys = Object.getOwnPropertyNames(value).sort();
  const wantedKeys = [...expectedKeys].sort();
  assertCondition(
    actualKeys.length === wantedKeys.length && actualKeys.every((key, index) => key === wantedKeys[index]),
    "invalid_quote",
    `${label} has missing or unknown fields`
  );

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assertCondition(
      Boolean(descriptor) && "value" in descriptor! && descriptor!.enumerable,
      "invalid_quote",
      `${label}.${key} must be an enumerable data property`
    );
    snapshot[key] = descriptor!.value;
  }
  return snapshot;
}

function parseCanonicalTimestamp(value: unknown, label: string): { value: string; milliseconds: number } {
  assertCondition(
    typeof value === "string" && ISO_UTC_MILLISECOND_PATTERN.test(value),
    "invalid_quote",
    `${label} must be a canonical UTC timestamp with milliseconds`
  );
  const milliseconds = Date.parse(value);
  assertCondition(
    Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value,
    "invalid_quote",
    `${label} is not a valid canonical timestamp`
  );
  return { value, milliseconds };
}

function parseDigest(value: unknown, label: string): string {
  assertCondition(typeof value === "string" && SHA256_PATTERN.test(value), "invalid_quote", `${label} must be lowercase SHA-256 hex`);
  return value;
}

function readComponents(value: unknown, topLevelUnitKind: OperatorCostUnitKind): readonly OperatorCostComponentV1[] {
  assertCondition(Array.isArray(value) && value.length === 1, "invalid_quote", "Schema-v1 quotes must contain exactly one component");
  assertCondition(Object.getPrototypeOf(value) === Array.prototype, "invalid_quote", "Quote components must be a plain array");
  assertCondition(Object.getOwnPropertySymbols(value).length === 0, "invalid_quote", "Quote components may not contain symbol keys");
  const componentKeys = Object.keys(value);
  assertCondition(
    componentKeys.length === value.length
      && componentKeys.every((key, index) => key === String(index)),
    "invalid_quote",
    "Quote components may not be sparse or contain custom properties"
  );

  const parsed: OperatorCostComponentV1[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const arrayDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
    assertCondition(
      Boolean(arrayDescriptor) && "value" in arrayDescriptor! && arrayDescriptor!.enumerable,
      "invalid_quote",
      `Quote component ${index} must be an enumerable data property`
    );
    const raw = arrayDescriptor!.value;
    const component = readExactRecord(raw, [
      "name",
      "quantity",
      "source",
      "unitKind",
      "unitMicroUsd",
      "upperBoundMicroUsd",
    ], `Quote component ${index}`);

    assertCondition(COMPONENT_NAMES.has(component.name as OperatorCostComponentV1["name"]), "invalid_quote", `Quote component ${index} has an unknown name`);
    assertCondition(component.unitKind === topLevelUnitKind, "invalid_quote", `Quote component ${index} has a mismatched unit kind`);
    const expectedNameByUnitKind: Readonly<Record<OperatorCostUnitKind, OperatorCostComponentV1["name"]>> = {
      email_send: "email_provider_send",
      sms_segment: "sms_provider_segment",
      voice_minute: "voice_provider_minute",
      phone_number_month: "phone_number_month",
    };
    assertCondition(
      component.name === expectedNameByUnitKind[topLevelUnitKind],
      "invalid_quote",
      `Quote component ${index} name does not match its unit kind`
    );
    assertCondition(component.source === "operator_config", "invalid_quote", `Quote component ${index} has an unsupported source`);
    assertCondition(isSafePositiveInteger(component.quantity), "invalid_quote", `Quote component ${index} quantity is invalid`);
    assertCondition(isSafePositiveInteger(component.unitMicroUsd), "invalid_quote", `Quote component ${index} unit price is invalid`);
    assertCondition(isSafePositiveInteger(component.upperBoundMicroUsd), "invalid_quote", `Quote component ${index} upper bound is invalid`);
    assertCondition(
      safeMultiply(component.quantity, component.unitMicroUsd, "invalid_quote", `Quote component ${index}`) === component.upperBoundMicroUsd,
      "invalid_quote",
      `Quote component ${index} upper bound does not match quantity times unit price`
    );

    parsed.push(Object.freeze({
      name: component.name as OperatorCostComponentV1["name"],
      quantity: component.quantity,
      unitKind: topLevelUnitKind,
      unitMicroUsd: component.unitMicroUsd,
      upperBoundMicroUsd: component.upperBoundMicroUsd,
      source: "operator_config" as const,
    }));
  }
  return Object.freeze(parsed);
}

/** Strictly parse persisted or browser-returned quote JSON and re-freeze it. */
export function parseOperatorCostQuote(value: unknown): OperatorCostQuoteV1 {
  const quote = readExactRecord(value, [
    "components",
    "currency",
    "formulaSha256",
    "limitsSha256",
    "pricingSnapshotSha256",
    "quotedAt",
    "reservationMicroUsd",
    "safetyMarginMicroUsd",
    "schemaVersion",
    "unitKind",
    "units",
    "validUntil",
  ], "Operator cost quote");

  assertCondition(quote.schemaVersion === OPERATOR_COST_QUOTE_SCHEMA_VERSION, "invalid_quote", "Unsupported operator cost quote schema");
  assertCondition(quote.currency === OPERATOR_COST_QUOTE_CURRENCY, "invalid_quote", "Operator cost quote currency must be USD");
  assertCondition(UNIT_KINDS.has(quote.unitKind as OperatorCostUnitKind), "invalid_quote", "Operator cost quote has an unknown unit kind");
  const unitKind = quote.unitKind as OperatorCostUnitKind;
  assertCondition(isSafePositiveInteger(quote.units), "invalid_quote", "Operator cost quote units are invalid");
  assertCondition(isSafeNonNegativeInteger(quote.safetyMarginMicroUsd), "invalid_quote", "Operator cost quote safety margin is invalid");
  assertCondition(isSafePositiveInteger(quote.reservationMicroUsd), "invalid_quote", "Operator cost quote reservation is invalid");

  const quotedAt = parseCanonicalTimestamp(quote.quotedAt, "quotedAt");
  const validUntil = parseCanonicalTimestamp(quote.validUntil, "validUntil");
  assertCondition(validUntil.milliseconds > quotedAt.milliseconds, "invalid_quote", "validUntil must be after quotedAt");

  const components = readComponents(quote.components, unitKind);
  let calculatedUnits = 0;
  let calculatedReservation = quote.safetyMarginMicroUsd;
  for (const component of components) {
    calculatedUnits = safeAdd(calculatedUnits, component.quantity, "invalid_quote", "Quote units");
    calculatedReservation = safeAdd(
      calculatedReservation,
      component.upperBoundMicroUsd,
      "invalid_quote",
      "Quote reservation"
    );
  }
  assertCondition(calculatedUnits === quote.units, "invalid_quote", "Quote units do not match its components");
  assertCondition(
    calculatedReservation === quote.reservationMicroUsd,
    "invalid_quote",
    "Quote reservation does not match its components and safety margin"
  );

  return deepFreezeQuote({
    schemaVersion: OPERATOR_COST_QUOTE_SCHEMA_VERSION,
    currency: OPERATOR_COST_QUOTE_CURRENCY,
    reservationMicroUsd: quote.reservationMicroUsd,
    units: quote.units,
    unitKind,
    quotedAt: quotedAt.value,
    validUntil: validUntil.value,
    pricingSnapshotSha256: parseDigest(quote.pricingSnapshotSha256, "pricingSnapshotSha256"),
    formulaSha256: parseDigest(quote.formulaSha256, "formulaSha256"),
    limitsSha256: parseDigest(quote.limitsSha256, "limitsSha256"),
    components,
    safetyMarginMicroUsd: quote.safetyMarginMicroUsd,
  });
}

/**
 * Re-check a persisted voice reservation against current deployment ceilings
 * immediately before a delayed provider boundary. Quote expiry is deliberately
 * irrelevant here: the human already approved and funded the durable job. What
 * matters is that current configured pricing and safety margin still fit inside
 * that exact reservation, and that the approved duration still fits today's
 * hard cap.
 */
export function assertVoiceQuoteCoversCurrentPricing(
  value: unknown,
  constraints: VoiceQuoteRuntimeConstraints
): OperatorCostQuoteV1 {
  const quote = parseOperatorCostQuote(value);
  assertCondition(
    quote.unitKind === "voice_minute"
      && isSafePositiveInteger(constraints.expectedUnits)
      && quote.units === constraints.expectedUnits,
    "quote_binding_mismatch",
    "Approved voice quote does not match the exact runtime units"
  );
  const environment = constraints.environment ?? process.env;
  resolveVoiceMaxDurationSeconds(constraints.maxDurationSeconds, environment);
  const config = readCommonConfig(environment);
  const currentUnitMicroUsd = readConfiguredMicroUsd(
    environment,
    OPERATOR_PRICING_ENV.voiceMinuteCeilingUsd,
    false
  );
  const currentUpperBoundMicroUsd = safeMultiply(
    constraints.expectedUnits,
    currentUnitMicroUsd,
    "invalid_configuration",
    "Current voice reservation"
  );
  const currentReservationMicroUsd = safeAdd(
    currentUpperBoundMicroUsd,
    config.safetyMarginMicroUsd,
    "invalid_configuration",
    "Current voice reservation"
  );
  const approvedComponent = quote.components[0]!;
  assertCondition(
    currentReservationMicroUsd <= config.maxReservationMicroUsd
      && currentUnitMicroUsd <= approvedComponent.unitMicroUsd
      && config.safetyMarginMicroUsd <= quote.safetyMarginMicroUsd
      && currentReservationMicroUsd <= quote.reservationMicroUsd,
    "quote_exceeds_cap",
    "Approved voice reservation no longer covers current configured pricing"
  );
  return quote;
}

function assertExpectedDigest(actual: string, expected: string | undefined, label: string): void {
  if (expected === undefined) return;
  assertCondition(SHA256_PATTERN.test(expected), "invalid_input", `${label} expectation must be lowercase SHA-256 hex`);
  assertCondition(actual === expected, "quote_binding_mismatch", `${label} no longer matches the approved quote`);
}

/**
 * Validate schema, arithmetic, freshness, reservation cap, and optional live
 * reconstruction digests. `now === validUntil` is expired.
 */
export function assertOperatorCostQuoteUsable(
  value: unknown,
  constraints: OperatorQuoteUseConstraints
): OperatorCostQuoteV1 {
  assertCondition(
    isSafePositiveInteger(constraints.reservationCapMicroUsd),
    "invalid_input",
    "Quote reservation cap must be a positive safe integer"
  );
  const quote = parseOperatorCostQuote(value);
  const now = resolveNow(constraints.now, "invalid_input").getTime();
  const quotedAt = Date.parse(quote.quotedAt);
  const validUntil = Date.parse(quote.validUntil);

  assertCondition(now >= quotedAt, "quote_not_yet_valid", "Operator cost quote is not yet valid");
  assertCondition(now < validUntil, "quote_expired", "Operator cost quote has expired");
  assertCondition(
    quote.reservationMicroUsd <= constraints.reservationCapMicroUsd,
    "quote_exceeds_cap",
    "Operator cost quote exceeds the current reservation cap"
  );

  if (constraints.expectedUnitKind !== undefined) {
    assertCondition(
      quote.unitKind === constraints.expectedUnitKind,
      "quote_binding_mismatch",
      "Operator cost quote unit kind no longer matches the approved action"
    );
  }
  assertExpectedDigest(
    quote.pricingSnapshotSha256,
    constraints.expectedPricingSnapshotSha256,
    "Pricing snapshot"
  );
  assertExpectedDigest(quote.formulaSha256, constraints.expectedFormulaSha256, "Pricing formula");
  assertExpectedDigest(quote.limitsSha256, constraints.expectedLimitsSha256, "Action limits");
  return quote;
}
