import "server-only";

import { createHmac } from "node:crypto";
import {
  deriveDomainSeparatedSecretKey,
  mcpGatewaySecret,
} from "./high-authority-secrets";

const RECEIPT_KEY_DOMAIN = "hacc/recording-consent-receipt/key/v1";
const RECEIPT_VALUE_DOMAIN = "hacc/recording-consent-receipt/value/v1\0";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function receiptKey(): Buffer {
  return deriveDomainSeparatedSecretKey(mcpGatewaySecret(), RECEIPT_KEY_DOMAIN);
}

/** Irreversible, domain-separated server commitment to a client receipt UUID. */
export function recordingConsentReceiptHmac(consentId: string): string {
  if (!UUID_PATTERN.test(consentId)) throw new Error("recording consent receipt is invalid");
  return createHmac("sha256", receiptKey())
    .update(RECEIPT_VALUE_DOMAIN, "utf8")
    .update(consentId.toLowerCase(), "utf8")
    .digest("hex");
}
