import { readFile } from "node:fs/promises";
import { runOfflineFlowDemo } from "../lib/offline-flow-demo";

const exampleUrl = new URL(
  "../../examples/flows/service-appointment-lifecycle.json",
  import.meta.url
);

async function main(): Promise<void> {
  const flow = JSON.parse(await readFile(exampleUrl, "utf8")) as unknown;
  const result = runOfflineFlowDemo(flow);
  const output: unknown = result.ok ? {
    ok: result.ok,
    mode: result.mode,
    installation: result.installation,
    simulation: result.simulation,
    evidence: {
      fake_call_receipts_sha256: result.evidence.fake_call_receipts_sha256,
      trace_sha256: result.evidence.trace_sha256,
      final_state_sha256: result.evidence.final_state_sha256,
    },
  } : result;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    mode: "offline",
    stage: "unhandled_error",
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
