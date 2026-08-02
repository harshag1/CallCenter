import {
  claimLc4PausedCell,
  recoverExpiredLc4CellBeforeNetwork,
  type Lc4CellResumePlan,
} from "../../lc4-cell-resume-journal";

type Payload = Readonly<{
  journal_path: string;
  expected_head_sha256: string;
  expected_plan: Lc4CellResumePlan;
  evidence_sha256?: string;
  cell_id?: string;
  owner_id?: string;
  owner_token_sha256?: string;
  owner_expires_at?: string;
  now: string;
}>;

const mode = process.argv[2];
const payload = JSON.parse(process.argv[3] ?? "null") as Payload;
const afterBudgetMutation = async () => {
  process.stdout.write("BUDGET_MUTATED\n");
  await new Promise<never>(() => undefined);
};

async function main(): Promise<void> {
if (mode === "recover") {
  await recoverExpiredLc4CellBeforeNetwork({
    journal_path: payload.journal_path,
    expected_head_sha256: payload.expected_head_sha256,
    expected_plan: payload.expected_plan,
    evidence_sha256: payload.evidence_sha256!,
    now: () => new Date(payload.now),
  }, { afterBudgetMutation });
} else if (mode === "claim") {
  await claimLc4PausedCell({
    journal_path: payload.journal_path,
    expected_head_sha256: payload.expected_head_sha256,
    expected_plan: payload.expected_plan,
    cell_id: payload.cell_id!,
    owner_id: payload.owner_id!,
    owner_token_sha256: payload.owner_token_sha256!,
    owner_expires_at: payload.owner_expires_at!,
    now: () => new Date(payload.now),
  }, { afterBudgetMutation });
} else {
  throw new Error(`unknown crash worker mode: ${mode}`);
}
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
