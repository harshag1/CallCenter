import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

import { canonicalJson, sha256Hex } from "../../artifacts";
import type { ScheduleBody, SignedSchedule, ScheduledUnit } from "./types";

const BODY_DOMAIN = "harshas-amazing-call-center/hacc-proof-v1/schedule/body\n";
const SIGNATURE_DOMAIN = "harshas-amazing-call-center/hacc-proof-v1/schedule/signature\n";
const SHA256 = /^[a-f0-9]{64}$/u;

function scheduleHash(body: ScheduleBody): string {
  return sha256Hex(`${BODY_DOMAIN}${canonicalJson(body)}`);
}

function signingBytes(scheduleSha256: string): Buffer {
  return Buffer.from(`${SIGNATURE_DOMAIN}${scheduleSha256}`);
}

function assertUnit(unit: ScheduledUnit): void {
  const ids = [unit.unit_id, unit.pair_id, unit.identity.provider, unit.identity.model, unit.identity.voice];
  if (ids.some((value) => !value || value.length > 256)) throw new Error("schedule contains an invalid identifier");
  for (const [label, value] of Object.entries({
    settings_sha256: unit.identity.settings_sha256,
    scenario_sha256: unit.scenario_sha256,
    caller_plan_sha256: unit.caller_plan_sha256,
    tools_sha256: unit.tools_sha256,
    substantive_context_sha256: unit.substantive_context_sha256,
  })) {
    if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  if (!Number.isSafeInteger(unit.maximum_micro_usd) || unit.maximum_micro_usd <= 0) {
    throw new Error("maximum_micro_usd must be a positive safe integer");
  }
}

function parityView(unit: ScheduledUnit): string {
  return canonicalJson({
    phase: unit.phase,
    identity: unit.identity,
    scenario_sha256: unit.scenario_sha256,
    caller_plan_sha256: unit.caller_plan_sha256,
    tools_sha256: unit.tools_sha256,
    substantive_context_sha256: unit.substantive_context_sha256,
    maximum_micro_usd: unit.maximum_micro_usd,
  });
}

export function assertScheduleBody(body: ScheduleBody): void {
  if (body.schema_version !== 1 || body.protocol !== "HACC-Proof-v1") {
    throw new Error("unsupported HACC proof schedule");
  }
  if (!body.study_id || !body.source_commit || !Number.isFinite(Date.parse(body.created_at))) {
    throw new Error("schedule metadata is invalid");
  }
  if (body.units.length === 0) throw new Error("schedule must contain at least one pair");
  const unitIds = new Set<string>();
  const pairs = new Map<string, Array<Readonly<{ unit: ScheduledUnit; index: number }>>>();
  let benchmarkSeen = false;
  for (const [index, unit] of body.units.entries()) {
    assertUnit(unit);
    if (unitIds.has(unit.unit_id)) throw new Error(`duplicate unit_id: ${unit.unit_id}`);
    unitIds.add(unit.unit_id);
    const entries = pairs.get(unit.pair_id) ?? [];
    entries.push({ unit, index });
    pairs.set(unit.pair_id, entries);
    if (unit.phase === "benchmark") benchmarkSeen = true;
    if (benchmarkSeen && unit.phase === "testing") {
      throw new Error("testing units must precede benchmark units");
    }
  }

  let pairOrdinal = 0;
  for (const [pairId, entries] of pairs) {
    const units = entries.map((entry) => entry.unit);
    if (units.length !== 2
      || entries[1]!.index !== entries[0]!.index + 1
      || units[0]?.pair_position !== 1
      || units[1]?.pair_position !== 2) {
      throw new Error(`pair ${pairId} must be adjacent and contain positions 1 then 2`);
    }
    if (units[0].arm === units[1].arm || parityView(units[0]) !== parityView(units[1])) {
      throw new Error(`pair ${pairId} violates Native/HACC parity`);
    }
    const expectedFirst = pairOrdinal % 2 === 0 ? "native" : "hacc";
    if (units[0].arm !== expectedFirst) throw new Error(`pair ${pairId} violates frozen AB/BA order`);
    pairOrdinal += 1;
  }
}

export function signSchedule(body: ScheduleBody, privateKeyPem: string): SignedSchedule {
  assertScheduleBody(body);
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("schedule signer must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const scheduleSha256 = scheduleHash(body);
  return Object.freeze({
    body,
    schedule_sha256: scheduleSha256,
    signer: Object.freeze({
      algorithm: "ed25519" as const,
      public_key_spki_base64: publicDer.toString("base64"),
      public_key_fingerprint_sha256: sha256Hex(publicDer),
    }),
    signature_base64: sign(null, signingBytes(scheduleSha256), privateKey).toString("base64"),
  });
}

export function verifySignedSchedule(schedule: SignedSchedule): void {
  assertScheduleBody(schedule.body);
  const actualHash = scheduleHash(schedule.body);
  if (actualHash !== schedule.schedule_sha256) throw new Error("schedule body hash mismatch");
  if (schedule.signer.algorithm !== "ed25519") throw new Error("schedule signature algorithm is invalid");
  const publicDer = Buffer.from(schedule.signer.public_key_spki_base64, "base64");
  if (sha256Hex(publicDer) !== schedule.signer.public_key_fingerprint_sha256) {
    throw new Error("schedule signer fingerprint mismatch");
  }
  const publicKey = createPublicKey({ key: publicDer, type: "spki", format: "der" });
  if (publicKey.asymmetricKeyType !== "ed25519"
    || !verify(null, signingBytes(actualHash), publicKey, Buffer.from(schedule.signature_base64, "base64"))) {
    throw new Error("schedule signature is invalid");
  }
}
