import { createHash } from "node:crypto";
import { sendAgentEmail } from "../email";
import {
  createEmailCostQuote,
  createSmsCostQuote,
  type OperatorCostQuoteV1,
} from "../operator-pricing";
import { sendSms } from "../sms";
import { twilioAccountSid, twilioRestAuthorization } from "../telephony";
import {
  defineCommunicationProviderAdapter,
  dispatchCommunication,
  quoteCommunication,
  type CommunicationDispatchReceiptV1,
  type CommunicationProviderAdapterV1,
  type FundedCommunicationAuthorityClaimerV1,
  type FundedCommunicationAuthorityExpectationV1,
  type VerifiedFundedCommunicationAuthorityV1,
} from "./provider-adapter";

const SHA256 = /^[a-f0-9]{64}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TWILIO_ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;

type EmailConfiguration = Readonly<{
  accountId: string;
  configurationIdentitySha256: string;
}>;

type EmailRequest = Readonly<{
  brand: string | null;
  message: string;
  subject: string;
  to: string;
}>;

type SmsConfiguration = Readonly<{
  accountSid: string;
  configurationIdentitySha256: string;
  fromNumber: string;
}>;

type SmsRequest = Readonly<{
  message: string;
  segments: number;
  to: string;
}>;

export type OperatorCommunicationDispatchContext = Readonly<{
  approvalId: string;
  executionId: string;
  expectedQuote: OperatorCostQuoteV1;
}>;

export type OperatorCommunicationDependencies = Readonly<{
  sendEmail: typeof sendAgentEmail;
  sendSms: typeof sendSms;
}>;

const DEFAULT_DEPENDENCIES: OperatorCommunicationDependencies = Object.freeze({
  sendEmail: sendAgentEmail,
  sendSms,
});

function sha256Domain(label: string, values: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(`harshas-amazing-call-center/operator-communication/${label}/v1\n`, "utf8");
  for (const value of values) {
    hash.update(String(Buffer.byteLength(value, "utf8")), "utf8");
    hash.update("\n", "utf8");
    hash.update(value, "utf8");
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

function boundedSecret(value: string | undefined, label: string): string {
  if (!value || value.length < 20 || value.length > 256
      || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is not configured for communication dispatch`);
  }
  return value;
}

function communicationReceiptSecret(): string {
  const secret = process.env.TELEPHONY_RECEIPT_SECRET;
  if (!secret || secret.length < 32 || secret.length > 256
      || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new Error("TELEPHONY_RECEIPT_SECRET must protect communication receipts");
  }
  if ([
    process.env.RESEND_API_KEY,
    process.env.TWILIO_AUTH_TOKEN,
    process.env.TWILIO_API_KEY_SECRET,
    process.env.MCP_GATEWAY_SECRET,
  ].some((credential) => credential && credential === secret)) {
    throw new Error("communication receipt secret must be distinct from provider credentials");
  }
  return secret;
}

function resendConfiguration(): EmailConfiguration {
  const apiKey = boundedSecret(process.env.RESEND_API_KEY, "RESEND_API_KEY");
  const from = process.env.EMAIL_FROM;
  if (!from || from.length > 320 || from.trim() !== from
      || /[\u0000-\u001f\u007f]/.test(from)) {
    throw new Error("EMAIL_FROM is not configured for communication dispatch");
  }
  const keyRevision = sha256Domain("resend-key-revision", [apiKey]);
  return Object.freeze({
    accountId: `resend:${keyRevision}`,
    configurationIdentitySha256: sha256Domain(
      "resend-configuration",
      [keyRevision, from]
    ),
  });
}

function twilioConfiguration(): SmsConfiguration {
  const accountSid = twilioAccountSid();
  if (!TWILIO_ACCOUNT_SID.test(accountSid)) {
    throw new Error("invalid Twilio communication account");
  }
  // This performs the existing Restricted-key/account attestation without
  // returning or retaining its Basic authorization value.
  twilioRestAuthorization();
  const keySid = boundedSecret(process.env.TWILIO_API_KEY_SID, "TWILIO_API_KEY_SID");
  const keySecret = boundedSecret(
    process.env.TWILIO_API_KEY_SECRET,
    "TWILIO_API_KEY_SECRET"
  );
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!fromNumber || !E164.test(fromNumber)) {
    throw new Error("TWILIO_PHONE_NUMBER is not configured for communication dispatch");
  }
  const keyRevision = sha256Domain("twilio-key-revision", [keySid, keySecret]);
  return Object.freeze({
    accountSid,
    fromNumber,
    configurationIdentitySha256: sha256Domain(
      "twilio-sms-configuration",
      [accountSid, fromNumber, keyRevision]
    ),
  });
}

function ttlSeconds(quote: OperatorCostQuoteV1): number {
  const ttl = (Date.parse(quote.validUntil) - Date.parse(quote.quotedAt)) / 1_000;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86_400) {
    throw new Error("operator communication quote TTL is invalid");
  }
  return ttl;
}

function priceQuote(quote: OperatorCostQuoteV1) {
  return Object.freeze({
    currency: "USD" as const,
    units: quote.units,
    reservationMicroUsd: quote.reservationMicroUsd,
    validForSeconds: ttlSeconds(quote),
    pricingSnapshotSha256: quote.pricingSnapshotSha256,
    formulaSha256: quote.formulaSha256,
    limitsSha256: quote.limitsSha256,
  });
}

function exactPlainRecord(value: unknown, keys: readonly string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} shape changed`);
  }
  return record;
}

function emailAdapter(
  dependencies: OperatorCommunicationDependencies
): CommunicationProviderAdapterV1<EmailConfiguration, EmailRequest> {
  return defineCommunicationProviderAdapter({
    descriptor: {
      contractVersion: "hacc.communication-adapter.v1",
      adapterId: "hacc.resend.operator.v1",
      providerId: "resend",
      adapterVersion: "1.0.0",
      configurationSchemaVersion: "operator-env.v1",
      webhookVerificationVersion: "not-implemented.v1",
      operations: {
        "email.send": {
          pricingFormulaVersion: "operator-email-ceiling.v1",
          unitKind: "email_send",
          idempotency: "provider-key",
          reconciliation: "authoritative-read",
        },
      },
    },
    async validateConfiguration(rawConfiguration) {
      const value = exactPlainRecord(rawConfiguration, [
        "accountId",
        "configurationIdentitySha256",
      ], "Resend communication configuration") as EmailConfiguration;
      if (typeof value.accountId !== "string" || !value.accountId.startsWith("resend:")
          || !SHA256.test(value.configurationIdentitySha256)) {
        throw new Error("invalid Resend communication configuration");
      }
      return Object.freeze({
        value,
        providerAccountId: value.accountId,
        configurationIdentitySha256: value.configurationIdentitySha256,
      });
    },
    async prepareRequest({ operation, destination, payload }) {
      if (operation !== "email.send" || typeof destination !== "string"
          || !EMAIL.test(destination)) {
        throw new Error("invalid Resend communication request");
      }
      const value = exactPlainRecord(payload, [
        "brand", "message", "subject", "to",
      ], "Resend communication payload") as EmailRequest;
      if (value.to !== destination || typeof value.subject !== "string"
          || typeof value.message !== "string"
          || !(value.brand === null || typeof value.brand === "string")) {
        throw new Error("invalid Resend communication payload");
      }
      return Object.freeze({ destinationIdentity: destination, value });
    },
    async quote({ operation, request, quotedAt }) {
      if (operation !== "email.send") throw new Error("unsupported Resend operation");
      return priceQuote(createEmailCostQuote(
        { recipient: request.to },
        { now: quotedAt }
      ));
    },
    async dispatch({ operation, configuration, request, context }) {
      if (operation !== "email.send") return { status: "rejected", code: "unsupported_operation" };
      const result = await dependencies.sendEmail({
        to: request.to,
        subject: request.subject,
        message: request.message,
        brand: request.brand,
        idempotencyKey: context.idempotencyKey,
      });
      return Object.freeze({
        status: "accepted",
        providerMessageId: result.providerMessageId,
        providerAccountId: configuration.accountId,
        providerDestination: request.to,
        idempotencyKey: context.idempotencyKey,
      });
    },
    async reconcile({ idempotencyKey }) {
      return Object.freeze({ status: "unknown", idempotencyKey });
    },
    async verifyWebhook() {
      return null;
    },
  });
}

function smsAdapter(
  dependencies: OperatorCommunicationDependencies
): CommunicationProviderAdapterV1<SmsConfiguration, SmsRequest> {
  return defineCommunicationProviderAdapter({
    descriptor: {
      contractVersion: "hacc.communication-adapter.v1",
      adapterId: "hacc.twilio-sms.operator.v1",
      providerId: "twilio",
      adapterVersion: "1.0.0",
      configurationSchemaVersion: "operator-env.v1",
      webhookVerificationVersion: "not-implemented.v1",
      operations: {
        "sms.send": {
          pricingFormulaVersion: "operator-sms-ceiling.v1",
          unitKind: "sms_segment",
          idempotency: "exclusive-framework-ledger",
          reconciliation: "authoritative-read",
        },
      },
    },
    async validateConfiguration(rawConfiguration) {
      const value = exactPlainRecord(rawConfiguration, [
        "accountSid", "configurationIdentitySha256", "fromNumber",
      ], "Twilio communication configuration") as SmsConfiguration;
      if (!TWILIO_ACCOUNT_SID.test(value.accountSid) || !E164.test(value.fromNumber)
          || !SHA256.test(value.configurationIdentitySha256)) {
        throw new Error("invalid Twilio communication configuration");
      }
      return Object.freeze({
        value,
        providerAccountId: value.accountSid,
        configurationIdentitySha256: value.configurationIdentitySha256,
      });
    },
    async prepareRequest({ operation, destination, payload }) {
      if (operation !== "sms.send" || typeof destination !== "string"
          || !E164.test(destination)) {
        throw new Error("invalid Twilio communication request");
      }
      const value = exactPlainRecord(payload, [
        "message", "segments", "to",
      ], "Twilio communication payload") as SmsRequest;
      if (value.to !== destination || typeof value.message !== "string"
          || !Number.isSafeInteger(value.segments) || value.segments < 1
          || value.segments > 100) {
        throw new Error("invalid Twilio communication payload");
      }
      return Object.freeze({ destinationIdentity: destination, value });
    },
    async quote({ operation, request, quotedAt }) {
      if (operation !== "sms.send") throw new Error("unsupported Twilio operation");
      return priceQuote(createSmsCostQuote({
        destinationE164: request.to,
        segmentCount: request.segments,
      }, { now: quotedAt }));
    },
    async dispatch({ operation, configuration, request, context }) {
      if (operation !== "sms.send") return { status: "rejected", code: "unsupported_operation" };
      const result = await dependencies.sendSms(request.to, request.message);
      return Object.freeze({
        status: "accepted",
        providerMessageId: result.providerMessageId,
        providerAccountId: configuration.accountSid,
        providerDestination: request.to,
        idempotencyKey: context.idempotencyKey,
      });
    },
    async reconcile({ idempotencyKey }) {
      return Object.freeze({ status: "unknown", idempotencyKey });
    },
    async verifyWebhook() {
      return null;
    },
  });
}

function exactAuthorityClaimer(
  context: OperatorCommunicationDispatchContext
): FundedCommunicationAuthorityClaimerV1 {
  if (!UUID.test(context.approvalId) || !UUID.test(context.executionId)) {
    throw new Error("invalid operator communication authority identity");
  }
  let consumed = false;
  return Object.freeze({
    async claimForDispatch(
      expectation: FundedCommunicationAuthorityExpectationV1
    ): Promise<VerifiedFundedCommunicationAuthorityV1 | null> {
      if (consumed || expectation.approvalId !== context.approvalId
          || expectation.units !== context.expectedQuote.units
          || expectation.reservationMicroUsd
            !== context.expectedQuote.reservationMicroUsd
          || expectation.pricingSnapshotSha256
            !== context.expectedQuote.pricingSnapshotSha256
          || expectation.formulaSha256 !== context.expectedQuote.formulaSha256
          || expectation.limitsSha256 !== context.expectedQuote.limitsSha256
          || expectation.unitKind !== context.expectedQuote.unitKind) {
        return null;
      }
      consumed = true;
      return Object.freeze({
        state: "claimed-for-exclusive-dispatch",
        attempt: 1,
        approvalId: context.approvalId,
        executionId: context.executionId,
        idempotencyKey: context.executionId,
        quoteSha256: expectation.quoteSha256,
        units: expectation.units,
        reservationMicroUsd: expectation.reservationMicroUsd,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    },
  });
}

async function dispatchWithAdapter<Configuration, PreparedRequest>(input: Readonly<{
  adapter: CommunicationProviderAdapterV1<Configuration, PreparedRequest>;
  rawConfiguration: Configuration;
  operation: "email.send" | "sms.send";
  destination: string;
  payload: unknown;
  context: OperatorCommunicationDispatchContext;
}>): Promise<CommunicationDispatchReceiptV1> {
  const receiptBindingSecret = communicationReceiptSecret();
  const approvedQuote = await quoteCommunication({
    adapter: input.adapter as CommunicationProviderAdapterV1<unknown, unknown>,
    rawConfiguration: input.rawConfiguration,
    operation: input.operation,
    destination: input.destination,
    payload: input.payload,
    receiptBindingSecret,
  });
  return dispatchCommunication({
    adapter: input.adapter as CommunicationProviderAdapterV1<unknown, unknown>,
    rawConfiguration: input.rawConfiguration,
    operation: input.operation,
    destination: input.destination,
    payload: input.payload,
    receiptBindingSecret,
    approvedQuote,
    approvalId: input.context.approvalId,
    authorityClaimer: exactAuthorityClaimer(input.context),
  });
}

export function createOperatorCommunicationDispatchers(
  dependencies: OperatorCommunicationDependencies = DEFAULT_DEPENDENCIES
) {
  const resend = emailAdapter(dependencies);
  const twilio = smsAdapter(dependencies);
  return Object.freeze({
    async email(input: Readonly<{
      brand: string | null;
      context: OperatorCommunicationDispatchContext;
      message: string;
      subject: string;
      to: string;
    }>) {
      return dispatchWithAdapter({
        adapter: resend,
        rawConfiguration: resendConfiguration(),
        operation: "email.send",
        destination: input.to,
        payload: {
          brand: input.brand,
          message: input.message,
          subject: input.subject,
          to: input.to,
        },
        context: input.context,
      });
    },
    async sms(input: Readonly<{
      context: OperatorCommunicationDispatchContext;
      message: string;
      segments: number;
      to: string;
    }>) {
      return dispatchWithAdapter({
        adapter: twilio,
        rawConfiguration: twilioConfiguration(),
        operation: "sms.send",
        destination: input.to,
        payload: {
          message: input.message,
          segments: input.segments,
          to: input.to,
        },
        context: input.context,
      });
    },
  });
}

export const operatorCommunicationDispatch =
  createOperatorCommunicationDispatchers();
