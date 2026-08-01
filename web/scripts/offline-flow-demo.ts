import { readFile } from "node:fs/promises";
import {
  runOfflineFlowDemo,
  type OfflineDemoSuccess,
} from "../lib/offline-flow-demo";

const exampleUrl = new URL(
  "../../examples/flows/service-appointment-lifecycle.json",
  import.meta.url
);

function renderDeveloperView(result: OfflineDemoSuccess): string {
  const lines = [
    "HACC provider-free developer trace",
    `Flow: ${result.simulation.topic} (${result.installation.flow_steps} defined steps)`,
    "",
  ];
  for (const step of result.developer_view.steps) {
    lines.push(`COMPLETE  ${step.path}`);
    lines.push(`  scoped tools: ${step.scoped_tools.join(", ")}`);
    lines.push(`  receipts: ${step.receipt_ids.length ? step.receipt_ids.join(", ") : "none"}`);
  }
  const restart = result.developer_view.recovery.restart;
  lines.push("");
  lines.push(`RECOVERY  ${restart.reason}; quarantined ${restart.recovered_receipt_ids.join(", ")}`);
  for (const reconciliation of result.developer_view.recovery.reconciliations) {
    lines.push(
      `RECONCILE ${reconciliation.receipt_id} -> ${reconciliation.status} ` +
      `(${reconciliation.resolution}; proof ${reconciliation.proof_id})`
    );
  }
  const final = result.developer_view.final_state;
  lines.push("");
  lines.push(`FINAL  ${final.status}; active step: ${final.active_step ?? "none"}`);
  lines.push(`  completed: ${final.completed_steps.length}/${result.developer_view.steps.length}`);
  lines.push(`  checkpoints: ${final.checkpoints.join(", ")}`);
  lines.push(`  receipts: ${final.receipts.length} settled`);
  lines.push(`  outputs: ${JSON.stringify(final.outputs)}`);
  lines.push("");
  lines.push("SAFETY  provider calls: 0; database writes: 0; expected spend: $0");
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--view")) {
    throw new Error("Usage: npm run demo:offline [-- --view]");
  }
  const flow = JSON.parse(await readFile(exampleUrl, "utf8")) as unknown;
  const result = runOfflineFlowDemo(flow);
  if (args.includes("--view") && result.ok) {
    process.stdout.write(renderDeveloperView(result));
    return;
  }
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
    developer_view: result.developer_view,
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
