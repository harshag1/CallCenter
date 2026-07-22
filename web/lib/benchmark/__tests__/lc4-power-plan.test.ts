import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import { createLc4PowerPlanArtifact } from "../lc4-power-plan";

describe("outcome-blind LC4 power and randomization plan", () => {
  it("reproduces the two exact 72-pair McNemar calculations", () => {
    const artifact = createLc4PowerPlanArtifact();
    expect(artifact.outcome_blindness.lc3_treatment_effect_outcomes_used).toBe(false);
    expect(artifact.exact_independent_pair_power.scenarios).toHaveLength(2);
    expect(artifact.exact_independent_pair_power.scenarios[0]).toMatchObject({
      sample_size: 72,
      hacc_only_probability: 0.30,
      native_only_probability: 0.05,
      risk_difference: 0.25,
      discordance: 0.35,
    });
    expect(artifact.exact_independent_pair_power.scenarios[0].power).toBeCloseTo(0.9601001249977493, 14);
    expect(artifact.exact_independent_pair_power.scenarios[1].power).toBeCloseTo(0.8772507900580803, 14);
  });

  it("freezes 24 templates, 72 provider pairs, 144 episodes, and exact balance", () => {
    const artifact = createLc4PowerPlanArtifact();
    expect(artifact.randomization.assignments).toHaveLength(72);
    expect(artifact.randomization.provider_support_size).toBe(504);
    expect(artifact.randomization.joint_support_size).toBe("128024064");
    expect(new Set(artifact.randomization.assignments.map((item) => item.pair_id))).toHaveLength(72);
    expect(new Set(artifact.randomization.assignments.map((item) => item.template_id))).toHaveLength(24);
    expect(artifact.schedule).toMatchObject({
      independent_templates: 24,
      matched_pairs: 72,
      episodes: 144,
      scheduled_caller_opportunities: 8_640,
    });
    for (const provider of ["openai", "gemini", "xai"] as const) {
      const rows = artifact.randomization.assignments.filter((item) => item.provider === provider);
      expect(rows).toHaveLength(24);
      expect(rows.filter((item) => item.arm_order[0] === "native")).toHaveLength(12);
      for (const family of artifact.schedule.families) {
        const stratum = rows.filter((item) => item.family === family);
        expect(stratum).toHaveLength(4);
        expect(stratum.filter((item) => item.arm_order[0] === "native")).toHaveLength(2);
      }
      for (const variant of artifact.schedule.structural_variants) {
        const stratum = rows.filter((item) => item.structural_variant === variant);
        expect(stratum).toHaveLength(6);
        expect(stratum.filter((item) => item.arm_order[0] === "native")).toHaveLength(3);
      }
      for (const voice of artifact.schedule.tts_voice_slots) {
        const stratum = rows.filter((item) => item.tts_voice_slot === voice);
        expect(stratum).toHaveLength(8);
        expect(stratum.filter((item) => item.arm_order[0] === "native")).toHaveLength(4);
      }
      expect([...rows]
        .sort((left, right) => left.template_id.localeCompare(right.template_id))
        .map((item) => item.arm_order[0] === "native" ? "1" : "0")
        .join("")).toBe(artifact.randomization.provider_selections[provider].native_first_bitstring);
      expect(artifact.randomization.provider_selections[provider].rejection_counter).toBe(0);
    }
    for (const provider of ["openai", "gemini", "xai"] as const) {
      for (let position = 0; position < 3; position += 1) {
        expect(artifact.randomization.assignments.filter((item) => item.provider === "openai")
          .map((item) => item.template_id)
          .filter((templateId, index, values) => values.indexOf(templateId) === index)
          .map((templateId) => artifact.randomization.assignments.find((item) => item.template_id === templateId)!)
          .filter((item) => item.provider_execution_order[position] === provider)).toHaveLength(8);
      }
    }
  });

  it("shows cluster sensitivity without relabeling it as confirmatory power", () => {
    const artifact = createLc4PowerPlanArtifact();
    const adverse = artifact.template_cluster_sensitivity.rows.filter((row) =>
      row.alternative === "hacc-only-0.35_native-only-0.10"
    );
    expect(adverse.map((row) => row.effective_pairs_floor)).toEqual([72, 60, 48, 36, 24]);
    expect(adverse.map((row) => row.exact_power_at_effective_pairs)).toEqual([
      0.8772507900580803,
      0.8014223234096615,
      0.6952042194243462,
      0.5482371829343844,
      0.3392263361999647,
    ]);
    expect(artifact.template_cluster_sensitivity.method_scope).toMatch(/not power for the final/);
    expect(artifact.claim_boundaries.join(" ")).toMatch(/zero provider calls/);
  });

  it("matches the checked-in canonical machine artifact and its domain hash", async () => {
    const generated = createLc4PowerPlanArtifact();
    const checkedIn = JSON.parse(await readFile(resolve(
      process.cwd(),
      "../benchmarks/voice-long-horizon/HACC_LC4_POWER_PLAN_V1.json",
    ), "utf8"));
    expect(checkedIn).toEqual(generated);
    expect(generated.artifact_sha256).toBe("3f0ddf9aa1b01feff4aebf7ec4f02c4eabc4c5a8a6b1681aa4dacd2378518f0c");
    expect(generated.randomization.allocation_sha256).toBe("c2dfc96536e3444b4ee6c8478174c9796eca30e8261f9695743dbd36a01e35ba");
    const body = Object.fromEntries(Object.entries(generated).filter(([key]) => key !== "artifact_sha256"));
    expect(generated.artifact_sha256).toBe(sha256Hex(
      `harshas-amazing-call-center/lc4-power-plan/v1\n${canonicalJson(body)}`,
    ));
  });
});
