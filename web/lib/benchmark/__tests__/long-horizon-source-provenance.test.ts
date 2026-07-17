import { describe, expect, it } from "vitest";
import { compileConditionSuite } from "../condition-compiler";
import { LONG_HORIZON_SCENARIO_SUITE } from "../long-horizon-scenario-suite";

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

describe("long-horizon source provenance", () => {
  it("keeps every caller fact revision linked to the immediately prior annotation", () => {
    const issues: string[] = [];

    for (const source of LONG_HORIZON_SCENARIO_SUITE) {
      const latest = new Map<string, unknown>();
      for (const [turnIndex, turn] of source.scenario.caller.turns.entries()) {
        for (const update of turn.fact_updates) {
          const hasPrior = latest.has(update.fact);
          const hasSupersedes = Object.prototype.hasOwnProperty.call(update, "supersedes");
          const label = `${source.scenario.id}/${turn.id || turnIndex + 1}/${update.fact}`;

          if (!hasPrior && hasSupersedes) {
            issues.push(`${label}: first annotation cannot supersede an unseen value`);
          } else if (hasPrior && !hasSupersedes) {
            issues.push(`${label}: later annotation requires explicit supersedes provenance`);
          } else if (hasPrior && !sameJson(update.supersedes, latest.get(update.fact))) {
            issues.push(`${label}: supersedes does not match the immediately prior annotation`);
          }
          latest.set(update.fact, update.value);
        }
      }
    }

    expect(issues).toEqual([]);
  });

  it("keeps exact injected-fault outcomes out of provider-visible pre-fault policy", () => {
    const forbiddenForeknowledge = [
      "a scheduled outage occurs before commit",
      "the scheduled first attempt fails before commit",
      "a service-busy error occurs before commit",
    ];

    for (const source of LONG_HORIZON_SCENARIO_SUITE.filter((candidate) => candidate.turnCount === 32)) {
      const suite = compileConditionSuite(source.compilerInput);
      for (const [conditionId, condition] of Object.entries(suite.conditions)) {
        const providerVisible = JSON.stringify(condition).toLowerCase();
        for (const forbidden of forbiddenForeknowledge) {
          expect(
            providerVisible.includes(forbidden),
            `${source.family}/${conditionId} discloses exact injected-fault behavior: ${forbidden}`
          ).toBe(false);
        }
        expect(condition.initialPrompt.toLowerCase()).toContain("ambiguous");
        expect(condition.initialPrompt.toLowerCase()).toContain("authoritative");
      }
    }
  });

  it("labels caller-narrated recovery as instruction-following rather than unaided diagnosis", () => {
    for (const source of LONG_HORIZON_SCENARIO_SUITE) {
      const limitations = source.runnerRequirements.join(" ").toLowerCase();
      expect(limitations, source.scenario.id).toContain("instruction following");
      expect(limitations, source.scenario.id).toContain("unaided fault diagnosis");
    }
  });
});
