import { canonicalJson, immutableJson, sha256Hex } from "../../artifacts";
import type { JsonValue } from "./types";

const EVENT_DOMAIN = "harshas-amazing-call-center/hacc-proof-v1/raw-event\n";
const FINAL_DOMAIN = "harshas-amazing-call-center/hacc-proof-v1/raw-final\n";

export type EvidenceEvent = Readonly<{
  sequence: number;
  event_type: string;
  observed_at: string;
  payload: JsonValue;
  previous_sha256: string | null;
  event_sha256: string;
}>;

export type RawEvidenceFinalization = Readonly<{
  event_count: number;
  chain_head_sha256: string | null;
  raw_evidence_sha256: string;
}>;

/** Provider-free custody simulator. Paid runs must use ProductionEvidenceAuthorityV2. */
export class TestOnlyEvidenceTap {
  readonly #events: EvidenceEvent[] = [];
  #finalization: RawEvidenceFinalization | null = null;
  #evaluation: JsonValue | null = null;

  append(eventType: string, observedAt: string, payload: JsonValue): EvidenceEvent {
    if (this.#finalization) throw new Error("raw evidence is already finalized");
    if (!eventType || !Number.isFinite(Date.parse(observedAt))) throw new Error("raw evidence event is invalid");
    const body = {
      sequence: this.#events.length,
      event_type: eventType,
      observed_at: observedAt,
      payload: immutableJson(payload),
      previous_sha256: this.#events.at(-1)?.event_sha256 ?? null,
    };
    const event = Object.freeze({
      ...body,
      event_sha256: sha256Hex(`${EVENT_DOMAIN}${canonicalJson(body)}`),
    });
    this.#events.push(event);
    return event;
  }

  finalizeRaw(): RawEvidenceFinalization {
    if (this.#finalization) throw new Error("raw evidence can only be finalized once");
    const body = {
      event_count: this.#events.length,
      chain_head_sha256: this.#events.at(-1)?.event_sha256 ?? null,
    };
    this.#finalization = Object.freeze({
      ...body,
      raw_evidence_sha256: sha256Hex(`${FINAL_DOMAIN}${canonicalJson(body)}`),
    });
    return this.#finalization;
  }

  recordEvaluation(evaluation: JsonValue): void {
    if (!this.#finalization) throw new Error("evaluation is forbidden before raw finalization");
    if (this.#evaluation) throw new Error("evaluation can only be recorded once");
    this.#evaluation = evaluation;
  }

  rawEvents(): readonly JsonValue[] {
    return Object.freeze(this.#events.map((event) => event as unknown as JsonValue));
  }
}
