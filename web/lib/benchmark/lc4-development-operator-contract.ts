import { canonicalJson, sha256Hex } from "./artifacts";

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const AUTHORIZATION_BINDING_DOMAIN = "harshas-amazing-call-center/lc4-dev-authorization-binding/v2\n";
const LEDGER_GENESIS_DOMAIN = "harshas-amazing-call-center/lc4-dev-ledger-genesis/v2\n";

export const LC4_DEV_OPERATOR_VERSION = "HACC-LC4-DEV-OPERATOR-v2" as const;

export type Lc4DevLedgerGenesisInput = Readonly<{
  execution_id: string;
  prepare_sha256: string;
  authorization_binding_sha256: string;
  authority_public_key_fingerprint_sha256: string;
}>;

export function lc4DevSharedAuthorizationBindingSha256(body: unknown): string {
  return sha256Hex(`${AUTHORIZATION_BINDING_DOMAIN}${canonicalJson(body)}`);
}

export function lc4DevSharedLedgerGenesisSha256(input: Lc4DevLedgerGenesisInput): string {
  if (!SAFE_ID.test(input.execution_id)) throw new Error("LC4-DEV ledger execution ID must be a safe opaque identifier");
  for (const [label, value] of Object.entries({
    "prepare hash": input.prepare_sha256,
    "authorization binding": input.authorization_binding_sha256,
    "authority fingerprint": input.authority_public_key_fingerprint_sha256,
  })) {
    if (!HASH.test(value)) throw new Error(`LC4-DEV ledger ${label} must be one lowercase SHA-256`);
  }
  return sha256Hex(`${LEDGER_GENESIS_DOMAIN}${canonicalJson({
    schema_version: 2,
    operator_version: LC4_DEV_OPERATOR_VERSION,
    ...input,
  })}`);
}
