import { canonicalJson } from "./artifacts";
import {
  LC4_DEV_PUBLIC_RESULT_FILENAMES,
  publishLc4DevPublicResult,
  verifyLc4DevPublicResult,
} from "./lc4-development-public-results";

type Io = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
}>;

function flags(args: readonly string[]): Readonly<Record<string, string>> {
  if (args.length % 2 !== 0) throw new Error("LC4-DEV public result CLI requires --flag value pairs");
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1]!;
    if (!key.startsWith("--") || value.startsWith("--") || parsed[key] !== undefined) {
      throw new Error("LC4-DEV public result CLI flags are malformed or duplicated");
    }
    parsed[key] = value;
  }
  return Object.freeze(parsed);
}

function exact(actual: Readonly<Record<string, string>>, expected: readonly string[]): void {
  if (canonicalJson(Object.keys(actual).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`LC4-DEV public result CLI requires exactly: ${[...expected].sort().join(", ")}`);
  }
}

export async function runLc4DevPublicResultCli(
  args: readonly string[],
  io: Io = {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
  },
): Promise<number> {
  try {
    const command = args[0];
    const parsed = flags(args.slice(1));
    if (command === "publish") {
      exact(parsed, [
        "--evidence-root",
        "--output-root",
        "--authority-trust-root-sha256",
        "--gate-d-receipt",
        "--gate-d-invocation-marker",
        "--gate-d-trust-root-sha256",
      ]);
      const result = await publishLc4DevPublicResult({
        evidence_root: parsed["--evidence-root"]!,
        output_root: parsed["--output-root"]!,
        authority_trust_root_sha256:
          parsed["--authority-trust-root-sha256"]!,
        xai_finite_manual_gate_d: {
          receipt_path: parsed["--gate-d-receipt"]!,
          invocation_marker_path:
            parsed["--gate-d-invocation-marker"]!,
          plan_trust_root_sha256:
            parsed["--gate-d-trust-root-sha256"]!,
        },
      });
      io.stdout(canonicalJson({
        valid: true,
        action: "published",
        evidence_class: result.evidence_class,
        efficacy_claim_eligible: result.efficacy_claim_eligible,
        public_result_sha256: result.public_result_sha256,
        authority_trust_root_sha256:
          result.qualification.listener_authority_trust_root_sha256,
        files: LC4_DEV_PUBLIC_RESULT_FILENAMES,
        provider_calls_made: false,
      }));
      return 0;
    }
    if (command === "verify") {
      exact(parsed, [
        "--evidence-root",
        "--public-json",
        "--public-markdown",
        "--authority-trust-root-sha256",
        "--gate-d-receipt",
        "--gate-d-invocation-marker",
        "--gate-d-trust-root-sha256",
      ]);
      const result = await verifyLc4DevPublicResult({
        evidence_root: parsed["--evidence-root"]!,
        public_json: parsed["--public-json"]!,
        public_markdown: parsed["--public-markdown"]!,
        authority_trust_root_sha256:
          parsed["--authority-trust-root-sha256"]!,
        xai_finite_manual_gate_d: {
          receipt_path: parsed["--gate-d-receipt"]!,
          invocation_marker_path:
            parsed["--gate-d-invocation-marker"]!,
          plan_trust_root_sha256:
            parsed["--gate-d-trust-root-sha256"]!,
        },
      });
      io.stdout(canonicalJson({
        valid: true,
        action: "verified",
        evidence_class: result.evidence_class,
        efficacy_claim_eligible: result.efficacy_claim_eligible,
        public_result_sha256: result.public_result_sha256,
        authority_trust_root_sha256:
          result.qualification.listener_authority_trust_root_sha256,
        provider_calls_made: false,
      }));
      return 0;
    }
    throw new Error("usage: lc4-development-public-results <publish|verify>");
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "LC4-DEV public result CLI failed");
    return 1;
  }
}
