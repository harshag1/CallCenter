import { canonicalJson } from "../lib/benchmark/artifacts";
import { createLc4SemanticCalibrationArtifact } from "../lib/benchmark/lc4-semantic-calibration";

const artifact = createLc4SemanticCalibrationArtifact();
process.stdout.write(`${canonicalJson(artifact)}\n`);
if (artifact.failed_case_ids.length > 0) process.exitCode = 1;
