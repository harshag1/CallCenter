import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createLc4ConstrainedInferenceArtifact } from "../lib/benchmark/lc4-constrained-inference";
import { createLc4PowerPlanArtifact } from "../lib/benchmark/lc4-power-plan";

const outputDirectory = resolve(process.cwd(), "../benchmarks/voice-long-horizon");
const outputs = Object.freeze([
  Object.freeze({
    path: resolve(outputDirectory, "HACC_LC4_POWER_PLAN_V1.json"),
    value: createLc4PowerPlanArtifact(),
  }),
  Object.freeze({
    path: resolve(outputDirectory, "HACC_LC4_CONSTRAINED_INFERENCE_V1.json"),
    value: createLc4ConstrainedInferenceArtifact(),
  }),
]);

async function main(): Promise<void> {
  for (const output of outputs) {
    await writeFile(output.path, `${JSON.stringify(output.value, null, 2)}\n`, "utf8");
    console.log(output.path);
  }
}

void main();
