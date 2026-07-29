import { canonicalJson, sha256Hex } from "./artifacts";

const ASSERTION_CONTRACT_DOMAIN =
  "hacc/lc4/listener-registered-assertion-contract/v1\n";

export const LC4_LISTENER_ASSERTION_CONTRACT_VERSION =
  "lc4-listener-registered-assertion-contract-v1" as const;

/**
 * Arm-common speech convention used by LC4's deterministic listener metric.
 *
 * This never discloses an expected fact, criterion, opportunity, or action.
 * It only gives both arms the same observable way to distinguish an asserted
 * claim from quoted, hypothetical, stale, uncertain, or denied language.
 */
export const LC4_LISTENER_ASSERTION_CONTRACT = Object.freeze({
  schema_version: 1 as const,
  version: LC4_LISTENER_ASSERTION_CONTRACT_VERSION,
  metric_name: "registered_lexical_adherence" as const,
  instruction: [
    "Speak naturally first.",
    "At the end, restate each fact or authoritative status you are asserting as its own short sentence in the exact form \"Confirmed: <claim>.\"",
    "Once the first final Confirmed sentence starts, say only final Confirmed sentences.",
    "Never put a quotation, hypothetical, uncertain claim, stale value, question, denied action, or unsupported completion inside a Confirmed sentence.",
    "If a claim is unresolved, explain that naturally and omit its Confirmed sentence.",
  ].join(" "),
});

export const LC4_LISTENER_ASSERTION_CONTRACT_SHA256 = sha256Hex(
  `${ASSERTION_CONTRACT_DOMAIN}${canonicalJson(LC4_LISTENER_ASSERTION_CONTRACT)}`,
);

export function renderLc4ListenerAssertionContract(): string {
  return [
    `<lc4_listener_assertion_contract sha256="${LC4_LISTENER_ASSERTION_CONTRACT_SHA256}">`,
    canonicalJson(LC4_LISTENER_ASSERTION_CONTRACT),
    "</lc4_listener_assertion_contract>",
  ].join("\n");
}
