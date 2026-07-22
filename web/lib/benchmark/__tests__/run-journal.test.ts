import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CrashDurableRunJournal,
  RunJournalError,
  redactRunJournalValue,
  verifyRunJournal,
} from "../run-journal";

const roots: string[] = [];
const PLAN_HASH = "a".repeat(64);
const MANIFEST_HASH = "b".repeat(64);
const BUDGET_HASH = "c".repeat(64);
// Every append deliberately performs three serialized durability barriers:
// journal fsync, head-file fsync, and parent-directory fsync. A small burst is
// sufficient to prove that concurrent callers are ordered; using 50 here made
// the unit suite an accidental disk-throughput benchmark and crossed Vitest's
// 5-second timeout only when other workers contended for the same filesystem.
const CONCURRENT_APPEND_PROBE_COUNT = 8;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hacc-run-journal-"));
  roots.push(root);
  return root;
}

function options(root: string, secret = "sk-super-secret-provider-key") {
  return {
    outputRoot: root,
    planSha256: PLAN_HASH,
    runId: "run-offline-001",
    canonicalPlan: "{\"plan\":\"offline\"}\n",
    knownSecrets: [secret],
    now: () => new Date("2026-07-10T12:00:00.000Z"),
  } as const;
}

describe("crash-durable redacted run journal", () => {
  it("creates the partial before work and serializes concurrent appends into a verifiable hash chain", async () => {
    const root = await outputRoot();
    const journal = await CrashDurableRunJournal.create(options(root));
    await Promise.all(Array.from(
      { length: CONCURRENT_APPEND_PROBE_COUNT },
      (_, index) => journal.append("provider.normalized", { index }),
    ));

    const verification = await verifyRunJournal(journal.paths.journal);
    expect(verification).toMatchObject({ valid: true, event_count: CONCURRENT_APPEND_PROBE_COUNT + 1 });
    const events = (await readFile(journal.paths.journal, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { event_type: string; payload: { index?: number } });
    expect(events.slice(1).map((event) => event.payload.index)).toEqual(
      Array.from({ length: CONCURRENT_APPEND_PROBE_COUNT }, (_, index) => index),
    );
    expect(await readFile(journal.paths.plan, "utf8")).toBe("{\"plan\":\"offline\"}\n");
  });

  it("redacts exact secrets, auth fields, grants, resume handles, URLs, errors, and binary payloads", async () => {
    const root = await outputRoot();
    const secret = "sk-super-secret-provider-key";
    const journal = await CrashDurableRunJournal.create(options(root, secret));
    await journal.append("provider.wire", {
      Authorization: `Bearer ${secret}`,
      capability_grant: "opaque.signed.grant",
      resume_handle: "server-resume-handle",
      endpoint: `wss://api.example.test/live?key=${secret}&model=pinned`,
      nested: { message: `provider rejected ${secret}` },
      error: new Error(`socket failed for ${secret}`),
      audio: Uint8Array.from([1, 2, 3, 4]),
    });

    const contents = await readFile(journal.paths.journal, "utf8");
    expect(contents).not.toContain(secret);
    expect(contents).not.toContain("opaque.signed.grant");
    expect(contents).not.toContain("server-resume-handle");
    expect(contents).toContain("[REDACTED]");
    expect(contents).toContain("byte_length");
    expect(await verifyRunJournal(journal.paths.journal)).toMatchObject({ valid: true });
  });

  it("writes immutable blobs and atomically finalizes only after manifest and budget heads are supplied", async () => {
    const root = await outputRoot();
    const journal = await CrashDurableRunJournal.create(options(root));
    const descriptor = await journal.writeBlob("audio/input/001.pcm", Uint8Array.from([1, 0, 2, 0]));
    expect(descriptor).toMatchObject({ path: "audio/input/001.pcm", byte_length: 4 });

    const complete = await journal.finalize({
      status: "completed",
      manifestSha256: MANIFEST_HASH,
      budgetHeadSha256: BUDGET_HASH,
    });
    expect(complete.endsWith("run-offline-001.complete")).toBe(true);
    expect(await readFile(join(complete, "FINALIZED.json"), "utf8")).toContain(MANIFEST_HASH);
    await expect(journal.append("late.event", {})).rejects.toMatchObject({ code: "closed" });
  });

  it("retains failed partials and refuses overwrite or path traversal", async () => {
    const root = await outputRoot();
    const journal = await CrashDurableRunJournal.create(options(root));
    await journal.preservePartial("provider-timeout", { retry: false });
    expect(await readFile(journal.paths.journal, "utf8")).toContain("run.partial_preserved");
    await expect(CrashDurableRunJournal.create(options(root))).rejects.toMatchObject({ code: "already_exists" });
    await expect(journal.writeBlob("../escape", Uint8Array.from([0, 0]))).rejects.toBeInstanceOf(RunJournalError);
  });

  it("detects a partial tail and rejects plans containing loaded credentials", async () => {
    const root = await outputRoot();
    const journal = await CrashDurableRunJournal.create(options(root));
    await writeFile(journal.paths.journal, "{", { flag: "a" });
    expect(await verifyRunJournal(journal.paths.journal)).toMatchObject({ valid: false });

    const second = await outputRoot();
    await expect(CrashDurableRunJournal.create({
      ...options(second),
      canonicalPlan: "{\"credential\":\"sk-super-secret-provider-key\"}\n",
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("exposes the same structured redaction for CLI stdout and stderr", () => {
    const value = redactRunJournalValue({
      headers: { Authorization: "Bearer abcdefghijk" },
      message: "token xai-1234567890abcdef",
      url: "https://example.test/?access_token=abcdefghijk",
    });
    const encoded = JSON.stringify(value);
    expect(encoded).not.toContain("abcdefghijk");
    expect(encoded).not.toContain("xai-1234567890abcdef");
  });
});
