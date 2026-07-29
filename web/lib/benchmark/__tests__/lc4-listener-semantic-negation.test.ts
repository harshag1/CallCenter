import { describe, expect, it } from "vitest";

import {
  LC4_LISTENER_SEMANTIC_SCORER_BUILD_SHA256,
  LC4_LISTENER_SEMANTIC_SCORER_VERSION,
  scoreLc4ListenerSemanticCriterion,
  type Lc4ListenerSemanticCriterion,
} from "../lc4-listener-evidence";

function criterion(
  phrases: readonly string[],
  operator: Lc4ListenerSemanticCriterion["operator"] = "contains_any",
): Lc4ListenerSemanticCriterion {
  return Object.freeze({
    criterion_id: "current-collection-id",
    operator,
    phrases: Object.freeze([...phrases]),
    required_for_final_scorer: true,
    crp_blocker: Object.freeze({
      code: "latest_revision_unacknowledged",
      precedence: 1,
    }),
  });
}

describe("LC4 deterministic negation-aware listener scorer", () => {
  const collectionId = criterion(["OH-RIVER-17", "oh river seventeen"]);

  it.each([
    "The identifier is not OH-RIVER-17.",
    "The identifier isn't OH-RIVER-17.",
    "We can't confirm OH-RIVER-17.",
    "We are not using the code OH-RIVER-17.",
    "The old identifier was OH-RIVER-17.",
    "The prior value, OH-RIVER-17, was superseded.",
    "OH-RIVER-17 is wrong; use OH-RIVER-19.",
    "OH-RIVER-17 should be replaced with OH-RIVER-19.",
    "Is the current identifier OH-RIVER-17?",
    "Maybe the identifier is OH-RIVER-17.",
    "The identifier is OH-RIVER-170.",
    "It is anything but OH-RIVER-17.",
    "Use a value other than OH-RIVER-17.",
    "The value is far from OH-RIVER-17.",
    "Suppose the identifier is OH-RIVER-17.",
    "Unless corrected, OH-RIVER-17 is current.",
    "The caller asked is it OH-RIVER-17.",
    "OH-RIVER-17 is no longer current.",
    "OH-RIVER-17, supposedly.",
    "OH-RIVER-17 is not the current identifier.",
    "OH-RIVER-17 has not been verified.",
    "OH-RIVER-17 may be current.",
    "OH-RIVER-17, not the current identifier.",
    "Either OH-RIVER-17 or OH-RIVER-19 is current.",
    "The caller said: OH-RIVER-17.",
    "The transcript contains the string OH-RIVER-17.",
    "Had the identifier been OH-RIVER-17, we would proceed.",
    "For example, answer OH-RIVER-17.",
    "OH-RIVER-17 is current. I take that back.",
    "OH-RIVER-17 is current. I retract that statement.",
  ])("does not award current-fact credit to the hard negative %j", (transcript) => {
    expect(scoreLc4ListenerSemanticCriterion(collectionId, transcript)).toBe(false);
  });

  it("lets an explicit later correction override an earlier affirmative mention", () => {
    expect(scoreLc4ListenerSemanticCriterion(
      collectionId,
      "The identifier is OH-RIVER-17, but the correct identifier is OH-RIVER-19.",
    )).toBe(false);
    expect(scoreLc4ListenerSemanticCriterion(
      collectionId,
      "The identifier is OH-RIVER-17. Correction: it is OH-RIVER-19.",
    )).toBe(false);
  });

  it.each([
    "The current archive collection ID is OH-RIVER-17, confirmed.",
    "The collection is oh river seventeen.",
    "No, after checking, the current identifier is OH-RIVER-17.",
    "It isn't OH-RIVER-16 but OH-RIVER-17.",
    "Correction: the identifier is OH-RIVER-17.",
    "The identifier was OH-RIVER-16. Correction: it is OH-RIVER-17.",
    "Not only OH-RIVER-17 but also the family-history purpose is current.",
    "OH-RIVER-17 is not wrong.",
    "The identifier is OH-RIVER-17. Actually, we also need an accessible transcript.",
  ])("retains credit for the affirmed minimal-pair positive %j", (transcript) => {
    expect(scoreLc4ListenerSemanticCriterion(collectionId, transcript)).toBe(true);
  });

  it("uses the latest decisive mention after denial and repair", () => {
    expect(scoreLc4ListenerSemanticCriterion(
      collectionId,
      "OH-RIVER-17 is wrong. Correction: the current identifier is OH-RIVER-17.",
    )).toBe(true);
    expect(scoreLc4ListenerSemanticCriterion(
      collectionId,
      "OH-RIVER-17 is current. Wait, the identifier is OH-RIVER-19.",
    )).toBe(false);
  });

  it("keeps dotted fact revisions inside one registered assertion", () => {
    expect(scoreLc4ListenerSemanticCriterion(
      criterion(["recall collection_id.v1"]),
      "Confirmed: recall collection_id.v1.",
    )).toBe(true);
    expect(scoreLc4ListenerSemanticCriterion(
      criterion(["replace patron_record.v1 with patron_record.v2"]),
      "Confirmed: replace patron_record.v1 with patron_record.v2.",
    )).toBe(true);
  });

  it("treats explicitly rejected forbidden phrases as absent, not as violations", () => {
    const noTerminalPromise = criterion(["release confirmed"], "contains_none");
    expect(scoreLc4ListenerSemanticCriterion(noTerminalPromise, "Release confirmed.")).toBe(false);
    expect(scoreLc4ListenerSemanticCriterion(noTerminalPromise, "Release confirmed is incorrect; it remains pending.")).toBe(true);
    expect(scoreLc4ListenerSemanticCriterion(noTerminalPromise, "Do not say release confirmed.")).toBe(true);
  });

  it("does not let an unrelated earlier negation hide a later prohibited promise", () => {
    const noReservationPromise = criterion(["reserve archive room"], "contains_none");
    expect(scoreLc4ListenerSemanticCriterion(
      noReservationPromise,
      "I will not delay and will reserve archive room now.",
    )).toBe(false);
    expect(scoreLc4ListenerSemanticCriterion(
      noReservationPromise,
      "There is no reason to wait and I will reserve archive room now.",
    )).toBe(false);
  });

  it("requires affirmative ordered mentions rather than raw token order", () => {
    const ordered = criterion(["OH-RIVER-17", "family history"], "contains_ordered");
    expect(scoreLc4ListenerSemanticCriterion(
      ordered,
      "OH-RIVER-17 is current and the purpose is family history.",
    )).toBe(true);
    expect(scoreLc4ListenerSemanticCriterion(
      ordered,
      "Not OH-RIVER-17; the purpose is family history.",
    )).toBe(false);
  });

  it("exposes immutable scorer authority for plan and publication binding", () => {
    expect(LC4_LISTENER_SEMANTIC_SCORER_VERSION).toBe(
      "lc4-listener-semantic-scorer-v3-registered-lexical-adherence",
    );
    expect(LC4_LISTENER_SEMANTIC_SCORER_BUILD_SHA256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
