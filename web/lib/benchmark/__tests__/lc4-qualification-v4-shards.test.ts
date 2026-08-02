import { chmod, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import {
  LC4_QUALIFICATION_V4_PROVIDER_ORDER,
  assertLc4QualificationV4CompletedReplay,
  inspectLc4QualificationV4ProviderShards,
  runLc4QualificationV4ProviderShards,
  type Lc4QualificationV4Binding,
  type Lc4QualificationV4PhaseContext,
  type Lc4QualificationV4PhaseResult,
  type Lc4QualificationV4Manifest,
  type Lc4QualificationV4Aggregate,
  type Lc4QualificationV4ReplayShard,
} from "../lc4-qualification-v4-shards";
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const INVOKED_AT = "2026-08-01T16:00:00.000Z";

function hash(label: string): string {
  return sha256Hex(`test:${label}`);
}

function binding(overrides: Partial<Lc4QualificationV4Binding> = {}): Lc4QualificationV4Binding {
  return Object.freeze({
    attempt_id: "qualification-v4-test-attempt",
    authorization_artifact_sha256: hash("authorization"),
    authorization_maximum_total_micro_usd: 3_000_000,
    plan_artifact_sha256: hash("plan-artifact"),
    plan_sha256: hash("plan"),
    source_commit: "a".repeat(40),
    source_tree_sha256: hash("tree"),
    credential_set_sha256: hash("credential-set"),
    provider_profile_manifest_sha256: hash("profiles"),
    setup_configuration_matrix_sha256: hash("setup-matrix"),
    paid_configuration_matrix_sha256: hash("paid-matrix"),
    providers: Object.freeze(LC4_QUALIFICATION_V4_PROVIDER_ORDER.map((provider) => Object.freeze({
      provider,
      model: `${provider}-model-v1`,
      setup_configuration_sha256: hash(`${provider}:setup`),
      paid_configuration_sha256: hash(`${provider}:paid`),
      credential_sha256: hash(`${provider}:credential`),
      caller_audio_sha256: hash(`${provider}:audio`),
      caller_audio_bytes: 48_000,
      audio_delivery_profile_sha256: hash(`${provider}:profile`),
    }))),
    ...overrides,
  });
}

function result(context: Lc4QualificationV4PhaseContext, status: "passed" | "failed" = "passed"): Lc4QualificationV4PhaseResult {
  return Object.freeze({
    status,
    failure_class: status === "passed" ? "none" : `${context.provider}_${context.phase}_failed`,
    evidence_sha256: hash(`${context.provider}:${context.phase}:evidence`),
    wire_head_sha256: hash(`${context.provider}:${context.phase}:wire`),
    wire_observation_count: 4,
    reconnect_count: 0,
    usage_event_count: context.phase === "paid" ? 1 : 0,
    usage_evidence_sha256: hash(`${context.provider}:${context.phase}:usage`),
    provider_sessions_opened: status === "passed" ? 1 : 0,
    paid_sessions_opened: status === "passed" && context.phase === "paid" ? 1 : 0,
    generation_phases_attempted: status === "passed" && context.phase === "paid" ? 2 : 0,
    tool_roundtrips_attempted: status === "passed" && context.phase === "paid" ? 1 : 0,
  });
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "hacc-lc4qv4-"));
  roots.push(base);
  const repository = resolve(base, "repository");
  const evidence = resolve(base, "evidence");
  await mkdir(repository, { mode: 0o700 });
  await mkdir(evidence, { mode: 0o700 });
  await chmod(evidence, 0o700);
  return Object.freeze({ repository, evidence });
}

describe("LC4 qualification v4 provider shards", () => {
  it("pre-materializes three deterministic $1 shards and retains the all-pass 6/3/6/3 result", async () => {
    const { repository, evidence } = await fixture();
    const calls: string[] = [];
    const aggregate = await runLc4QualificationV4ProviderShards({
      root: evidence,
      repository_root: repository,
      binding: binding(),
      invoked_at: INVOKED_AT,
      dependencies: {
        async runSetup(context) {
          const reservations = await Promise.all(LC4_QUALIFICATION_V4_PROVIDER_ORDER.map(async (provider, ordinal) => (
            readdir(resolve(evidence, "qualification-v4-shards", `${ordinal}-${provider}`))
          )));
          expect(reservations.every((names) => names.includes("reservation.json"))).toBe(true);
          calls.push(`${context.provider}:setup`);
          return result(context);
        },
        async runPaid(context) {
          calls.push(`${context.provider}:paid`);
          return result(context);
        },
      },
    });

    expect(calls).toEqual([
      "openai:setup", "openai:paid",
      "gemini:setup", "gemini:paid",
      "xai:setup", "xai:paid",
    ]);
    expect(aggregate).toMatchObject({
      status: "passed",
      primary_failure_class: null,
      provider_sessions_opened: 6,
      paid_sessions_opened: 3,
      generation_phases_attempted: 6,
      tool_roundtrips_attempted: 3,
      paid_retries_attempted: 0,
      maximum_total_micro_usd: 3_000_000,
    });
  });

  it("resumes only from a retained setup terminal before paid admission and preserves prior bytes", async () => {
    const { repository, evidence } = await fixture();
    const firstCalls: string[] = [];
    await expect(runLc4QualificationV4ProviderShards({
      root: evidence,
      repository_root: repository,
      binding: binding(),
      invoked_at: INVOKED_AT,
      dependencies: {
        async runSetup(context) {
          firstCalls.push(`${context.provider}:setup`);
          return result(context);
        },
        async runPaid(context) {
          firstCalls.push(`${context.provider}:paid`);
          return result(context);
        },
        async afterSetupTerminal(context) {
          if (context.provider === "openai") throw new Error("simulated process stop at safe boundary");
        },
      },
    })).rejects.toThrow("safe boundary");
    expect(firstCalls).toEqual(["openai:setup"]);
    const setupPath = resolve(evidence, "qualification-v4-shards/0-openai/setup-terminal.json");
    const before = await readFile(setupPath);

    const resumedCalls: string[] = [];
    const aggregate = await runLc4QualificationV4ProviderShards({
      root: evidence,
      repository_root: repository,
      binding: binding(),
      invoked_at: INVOKED_AT,
      dependencies: {
        async runSetup(context) {
          resumedCalls.push(`${context.provider}:setup`);
          return result(context);
        },
        async runPaid(context) {
          resumedCalls.push(`${context.provider}:paid`);
          return result(context);
        },
      },
    });
    expect(resumedCalls).toEqual([
      "openai:paid",
      "gemini:setup", "gemini:paid",
      "xai:setup", "xai:paid",
    ]);
    expect(await readFile(setupPath)).toEqual(before);
    expect(aggregate.status).toBe("passed");
  });

  it("quarantines an admitted phase without terminal evidence and never retries it", async () => {
    const { repository, evidence } = await fixture();
    let setupCalls = 0;
    await expect(runLc4QualificationV4ProviderShards({
      root: evidence,
      repository_root: repository,
      binding: binding(),
      invoked_at: INVOKED_AT,
      dependencies: {
        async runSetup() {
          setupCalls += 1;
          throw new Error("connection outcome unknown");
        },
        async runPaid(context) {
          return result(context);
        },
      },
    })).rejects.toThrow("quarantined");
    expect(setupCalls).toBe(1);

    await expect(runLc4QualificationV4ProviderShards({
      root: evidence,
      repository_root: repository,
      binding: binding(),
      invoked_at: INVOKED_AT,
      dependencies: {
        async runSetup(context) {
          setupCalls += 1;
          return result(context);
        },
        async runPaid(context) {
          return result(context);
        },
      },
    })).rejects.toThrow("quarantined");
    expect(setupCalls).toBe(1);
    const status = await inspectLc4QualificationV4ProviderShards({
      root: evidence,
      repository_root: repository,
      binding: binding(),
    });
    expect(status.quarantined_provider).toBe("openai");
  });

  it("atomically admits only one process and never duplicates a provider callback", async () => {
    const { repository, evidence } = await fixture();
    let setupCalls = 0;
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const firstEntered = new Promise<void>((resolveEntered) => { markEntered = resolveEntered; });
    const release = new Promise<void>((resolveRelease) => { releaseFirst = resolveRelease; });
    const dependencies = {
      async runSetup(context: Lc4QualificationV4PhaseContext) {
        setupCalls += 1;
        markEntered();
        await release;
        return result(context);
      },
      async runPaid(context: Lc4QualificationV4PhaseContext) {
        return result(context);
      },
    };
    const first = runLc4QualificationV4ProviderShards({
      root: evidence,
      repository_root: repository,
      binding: binding(),
      invoked_at: INVOKED_AT,
      dependencies,
    });
    await firstEntered;
    const contender = runLc4QualificationV4ProviderShards({
      root: evidence,
      repository_root: repository,
      binding: binding(),
      invoked_at: INVOKED_AT,
      dependencies,
    });
    await expect(contender).rejects.toThrow("quarantined");
    releaseFirst();
    await expect(first).rejects.toThrow("concurrently quarantined");
    expect(setupCalls).toBe(1);
  });

  it("stops on first failed provider and retains later shards as zero-session cancellations", async () => {
    const { repository, evidence } = await fixture();
    const calls: string[] = [];
    const aggregate = await runLc4QualificationV4ProviderShards({
      root: evidence,
      repository_root: repository,
      binding: binding(),
      invoked_at: INVOKED_AT,
      dependencies: {
        async runSetup(context) {
          calls.push(`${context.provider}:setup`);
          return result(context);
        },
        async runPaid(context) {
          calls.push(`${context.provider}:paid`);
          return result(context, context.provider === "gemini" ? "failed" : "passed");
        },
      },
    });
    expect(calls).toEqual([
      "openai:setup", "openai:paid",
      "gemini:setup", "gemini:paid",
    ]);
    expect(aggregate).toMatchObject({
      status: "failed",
      primary_failure_class: "gemini_paid_failed",
      provider_sessions_opened: 3,
      paid_sessions_opened: 1,
      generation_phases_attempted: 2,
      tool_roundtrips_attempted: 1,
    });
    const xai = JSON.parse(await readFile(
      resolve(evidence, "qualification-v4-shards/2-xai/shard-terminal.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(xai).toMatchObject({
      status: "cancelled",
      failure_class: "predecessor_failed",
      provider_sessions_opened: 0,
      paid_sessions_opened: 0,
    });
  });

  it("rejects changed source, auth, model, credential, audio, profile, and predecessor before callbacks", async () => {
    const { repository, evidence } = await fixture();
    let callbacks = 0;
    const original = binding();
    await expect(runLc4QualificationV4ProviderShards({
      root: evidence,
      repository_root: repository,
      binding: original,
      invoked_at: INVOKED_AT,
      dependencies: {
        async runSetup(context) {
          callbacks += 1;
          return result(context);
        },
        async runPaid(context) {
          return result(context);
        },
        async afterSetupTerminal() {
          throw new Error("pause");
        },
      },
    })).rejects.toThrow("pause");
    expect(callbacks).toBe(1);

    const changedProviders = original.providers.map((provider) => ({ ...provider }));
    changedProviders[0] = { ...changedProviders[0]!, model: "changed-model" };
    const changed = binding({
      source_tree_sha256: hash("changed-tree"),
      authorization_artifact_sha256: hash("changed-auth"),
      providers: changedProviders,
    });
    await expect(runLc4QualificationV4ProviderShards({
      root: evidence,
      repository_root: repository,
      binding: changed,
      invoked_at: INVOKED_AT,
      dependencies: {
        async runSetup(context) {
          callbacks += 1;
          return result(context);
        },
        async runPaid(context) {
          callbacks += 1;
          return result(context);
        },
      },
    })).rejects.toThrow(/binding changed|immutable qualification artifact differs/);
    expect(callbacks).toBe(1);
  });

  it("replay rejects missing, reordered, substituted, and cross-bound source/auth/credential shards", async () => {
    const { repository, evidence } = await fixture();
    const exactBinding = binding();
    await runLc4QualificationV4ProviderShards({
      root: evidence,
      repository_root: repository,
      binding: exactBinding,
      invoked_at: INVOKED_AT,
      dependencies: {
        async runSetup(context) { return result(context); },
        async runPaid(context) { return result(context); },
      },
    });
    const parse = async <T,>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;
    const manifest = await parse<Lc4QualificationV4Manifest>(resolve(evidence, "qualification-v4-shard-manifest.json"));
    const aggregate = await parse<Lc4QualificationV4Aggregate>(resolve(evidence, "qualification-v4-aggregate.json"));
    const shards: Lc4QualificationV4ReplayShard[] = [];
    for (const [ordinal, provider] of LC4_QUALIFICATION_V4_PROVIDER_ORDER.entries()) {
      const root = resolve(evidence, "qualification-v4-shards", `${ordinal}-${provider}`);
      shards.push({
        reservation: await parse(resolve(root, "reservation.json")),
        setup_admission: await parse(resolve(root, "setup-admission.json")),
        setup_terminal: await parse(resolve(root, "setup-terminal.json")),
        paid_admission: await parse(resolve(root, "paid-admission.json")),
        paid_terminal: await parse(resolve(root, "paid-terminal.json")),
        shard_terminal: await parse(resolve(root, "shard-terminal.json")),
      });
    }
    expect(() => assertLc4QualificationV4CompletedReplay({
      binding: exactBinding, manifest, aggregate, shards,
    })).not.toThrow();
    expect(() => assertLc4QualificationV4CompletedReplay({
      binding: exactBinding, manifest, aggregate, shards: shards.slice(0, 2),
    })).toThrow("exactly three");
    expect(() => assertLc4QualificationV4CompletedReplay({
      binding: exactBinding, manifest, aggregate, shards: [shards[1]!, shards[0]!, shards[2]!],
    })).toThrow(/substituted or reordered/);
    expect(() => assertLc4QualificationV4CompletedReplay({
      binding: exactBinding,
      manifest,
      aggregate,
      shards: [{ ...shards[0]!, shard_terminal: shards[1]!.shard_terminal }, shards[1]!, shards[2]!],
    })).toThrow(/immutable integrity/);
    for (const changed of [
      binding({ source_tree_sha256: hash("cross-source") }),
      binding({ authorization_artifact_sha256: hash("cross-auth") }),
      binding({ credential_set_sha256: hash("cross-credentials") }),
    ]) {
      expect(() => assertLc4QualificationV4CompletedReplay({
        binding: changed, manifest, aggregate, shards,
      })).toThrow(/source, authorization, model, credential, audio, profile, or plan binding changed/);
    }
  });
});
