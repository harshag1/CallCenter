import { createPrivateKey, createPublicKey } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { canonicalJson, sha256Hex } from "./artifacts";
import {
  assertLc4QualificationV3Authorization,
  assertLc4QualificationV3PlanArtifact,
  assertXaiServerVadGateARiskArtifact,
  assertXaiServerVadGateBBindingArtifact,
  createXaiServerVadGateARiskArtifact,
  createXaiServerVadGateBBindingArtifact,
  createLc4QualificationV3Targets,
  credentialIdentity,
  credentialSetSha256,
  inspectLc4QualificationV3GitSource,
  loadLc4QualificationV3AuthorizationFile,
  loadLc4QualificationV3ExplicitCredentials,
  loadLc4QualificationV3PrivateKeyFile,
  paidRoundtripTargets,
  qualificationClientOptions,
  retainRoundtrip,
  type Lc4QualificationV3PlanArtifact,
  type Lc4XaiServerVadGateARiskArtifact,
} from "./lc4-qualification-v3-runner";
import {
  finalizeLc4QualificationBudget,
  reserveOrResumeLc4QualificationBudget,
  type Lc4QualificationBudgetBinding,
} from "./lc4-qualification-budget";
import {
  inspectLc4QualificationV4ProviderShards,
  runLc4QualificationV4ProviderShards,
  type Lc4QualificationV4Binding,
} from "./lc4-qualification-v4-shards";
import { qualifyProviderTargetShard } from "./provider-qualification";
import {
  LC4_S2S_TOOL_SCHEMA_SHA256,
  assertLc4S2sRoundtripExecution,
  executeLc4S2sToolRoundtrip,
  loadLc4S2sPcm,
} from "./provider-s2s-tool-roundtrip";
import { createProductionRealtimeClient } from "./production-realtime-provider";
import { DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE } from "./orchestrator";
import {
  createSignedLc4QualificationV4Package,
  verifySignedLc4QualificationV4Package,
  verifySignedLc4QualificationV4PackageCustody,
} from "./lc4-qualification-v4-package";
import type {
  Lc4QualificationV4Aggregate,
  Lc4QualificationV4Manifest,
  Lc4QualificationV4PhaseTerminal,
  Lc4QualificationV4ReplayShard,
  Lc4QualificationV4Reservation,
  Lc4QualificationV4ShardTerminal,
} from "./lc4-qualification-v4-shards";
import type { Lc4QualificationPackageFile } from "./lc4-qualification-package-envelope";

const MAXIMUM_JSON_BYTES = 16 * 1024 * 1024;

type Io = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
  now(): Date;
}>;

function flags(args: readonly string[]): Readonly<Record<string, string>> {
  if (args.length % 2 !== 0) throw new Error("qualification v4 operator requires --flag value pairs");
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1]!;
    if (!key.startsWith("--") || value.startsWith("--") || result[key] !== undefined) {
      throw new Error("qualification v4 operator flags are malformed or duplicated");
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function exactFlags(actual: Readonly<Record<string, string>>, expected: readonly string[]): void {
  if (canonicalJson(Object.keys(actual).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`qualification v4 operator requires exactly ${[...expected].sort().join(", ")}`);
  }
}

function absolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be absolute and normalized`);
  return path;
}

async function readPlan(root: string): Promise<Lc4QualificationV3PlanArtifact> {
  const path = resolve(root, "lc4-qualification-v3-plan.json");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAXIMUM_JSON_BYTES) {
    throw new Error("qualification v4 requires one bounded v3 plan artifact");
  }
  return JSON.parse(await readFile(path, "utf8")) as Lc4QualificationV3PlanArtifact;
}

async function originalInvocationTime(root: string, now: Date): Promise<string> {
  const path = resolve(root, "qualification-v4-invocation.json");
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { invoked_at?: unknown };
    if (typeof value.invoked_at !== "string" || new Date(value.invoked_at).toISOString() !== value.invoked_at) {
      throw new Error("retained qualification v4 invocation time is invalid");
    }
    return value.invoked_at;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return now.toISOString();
    throw error;
  }
}

function configurationSha256(provider: string, model: string, configuration: unknown): string {
  return sha256Hex(`harshas-amazing-call-center/provider-session-configuration/v1\n${canonicalJson({
    provider,
    model,
    configuration,
  })}`);
}

function terminalKeyFingerprint(privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("qualification v4 terminal key is not Ed25519");
  return sha256Hex(createPublicKey(privateKey).export({ format: "der", type: "spki" }));
}

async function productionState(input: Readonly<{
  root: string;
  repositoryRoot: string;
  providerEnvFile: string;
  repoEnvFile: string;
  authorizationPath: string;
  terminalPrivateKeyPath: string;
  trustRootFingerprint: string;
  now: Date;
}>) {
  const [plan, authorization, terminalPrivateKeyPem, source, credentials] = await Promise.all([
    readPlan(input.root),
    loadLc4QualificationV3AuthorizationFile(input.authorizationPath),
    loadLc4QualificationV3PrivateKeyFile(input.terminalPrivateKeyPath, "qualification v4 terminal private key"),
    inspectLc4QualificationV3GitSource(input.repositoryRoot),
    loadLc4QualificationV3ExplicitCredentials({
      providerEnvFile: input.providerEnvFile,
      repoEnvFile: input.repoEnvFile,
    }),
  ]);
  assertLc4QualificationV3PlanArtifact(plan, input.trustRootFingerprint);
  assertLc4QualificationV3Authorization({
    artifact: authorization,
    plan,
    trustRootFingerprint: input.trustRootFingerprint,
    now: input.now,
  });
  if (terminalKeyFingerprint(terminalPrivateKeyPem)
    !== authorization.body.terminal_public_key_fingerprint_sha256) {
    throw new Error("qualification v4 terminal key differs from signed authorization");
  }
  if (canonicalJson(source) !== canonicalJson(plan.body.source)) {
    throw new Error("qualification v4 source differs from signed plan");
  }
  if (credentialSetSha256(credentials) !== plan.body.credential_set_sha256) {
    throw new Error("qualification v4 credentials differ from signed plan");
  }
  const setupTargets = createLc4QualificationV3Targets();
  const paidTargets = paidRoundtripTargets();
  const binding: Lc4QualificationV4Binding = Object.freeze({
    attempt_id: authorization.body.authorization_id,
    authorization_artifact_sha256: authorization.artifact_sha256,
    authorization_maximum_total_micro_usd: authorization.body.maximum_total_micro_usd,
    plan_artifact_sha256: plan.artifact_sha256,
    plan_sha256: plan.body.plan_sha256,
    source_commit: source.source_commit,
    source_tree_sha256: source.source_tree_sha256,
    credential_set_sha256: plan.body.credential_set_sha256,
    provider_profile_manifest_sha256: plan.body.provider_profile_manifest_sha256,
    setup_configuration_matrix_sha256: plan.body.setup_configuration_matrix_sha256,
    paid_configuration_matrix_sha256: plan.body.paid_configuration_matrix_sha256,
    providers: Object.freeze(plan.body.targets.map((planned) => {
      const setup = setupTargets.find((target) => target.provider === planned.provider)!;
      const paid = paidTargets.find((target) => target.provider === planned.provider)!;
      return Object.freeze({
        provider: planned.provider,
        model: planned.model,
        setup_configuration_sha256: configurationSha256(planned.provider, setup.model, setup.configuration),
        paid_configuration_sha256: configurationSha256(planned.provider, paid.model, paid.configuration),
        credential_sha256: credentialIdentity(planned.provider, credentials[planned.provider]).credential_sha256,
        caller_audio_sha256: planned.caller_audio_sha256,
        caller_audio_bytes: planned.caller_audio_bytes,
        audio_delivery_profile_sha256: planned.audio_delivery_profile_sha256,
      });
    })),
  });
  return Object.freeze({ plan, authorization, terminalPrivateKeyPem, source, credentials, setupTargets, paidTargets, binding });
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function fileExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

/** Provider-free loader for terminalized pass/fail/cancel shard unions. */
export async function loadLc4QualificationV4ReplayArtifacts(root: string) {
  const manifest = await readJson<Lc4QualificationV4Manifest>(resolve(root, "qualification-v4-shard-manifest.json"));
  const aggregate = await readJson<Lc4QualificationV4Aggregate>(resolve(root, "qualification-v4-aggregate.json"));
  const shards: Lc4QualificationV4ReplayShard[] = [];
  const evidenceFiles: Lc4QualificationPackageFile[] = [];
  evidenceFiles.push(Object.freeze({
    path: "v4-invocation.json",
    bytes: await readFile(resolve(root, "qualification-v4-invocation.json")),
  }));
  for (const [ordinal, provider] of ["openai", "gemini", "xai"].entries()) {
    const prefix = `${String(ordinal).padStart(2, "0")}-${provider}`;
    const shardRoot = resolve(root, "qualification-v4-shards", `${ordinal}-${provider}`);
    const shardTerminal = await readJson<Lc4QualificationV4ShardTerminal>(resolve(shardRoot, "shard-terminal.json"));
    const setupAdmissionPath = resolve(shardRoot, "setup-admission.json");
    const setupTerminalPath = resolve(shardRoot, "setup-terminal.json");
    const paidAdmissionPath = resolve(shardRoot, "paid-admission.json");
    const paidTerminalPath = resolve(shardRoot, "paid-terminal.json");
    const setupAdmissionExists = await fileExists(setupAdmissionPath);
    const setupTerminalExists = await fileExists(setupTerminalPath);
    const paidAdmissionExists = await fileExists(paidAdmissionPath);
    const paidTerminalExists = await fileExists(paidTerminalPath);
    shards.push(Object.freeze({
      reservation: await readJson<Lc4QualificationV4Reservation>(resolve(shardRoot, "reservation.json")),
      setup_admission: setupAdmissionExists ? await readJson<unknown>(setupAdmissionPath) : null,
      setup_terminal: setupTerminalExists
        ? await readJson<Lc4QualificationV4PhaseTerminal>(setupTerminalPath)
        : null,
      paid_admission: paidAdmissionExists ? await readJson<unknown>(paidAdmissionPath) : null,
      paid_terminal: paidTerminalExists
        ? await readJson<Lc4QualificationV4PhaseTerminal>(paidTerminalPath)
        : null,
      shard_terminal: shardTerminal,
    }));
    for (const [source, target] of [
      [`qualifications/${provider}-qv4-${provider}.json`, `${prefix}-setup-qualification.json`],
      [`${provider}-spoken-roundtrip.json`, `${prefix}-spoken-roundtrip.json`],
      [`${provider}-spoken-roundtrip-wire.jsonl`, `${prefix}-spoken-roundtrip-wire.jsonl`],
      [`${provider}-spoken-roundtrip-usage.jsonl`, `${prefix}-spoken-roundtrip-usage.jsonl`],
    ] as const) {
      const sourcePath = resolve(shardRoot, source);
      if (await fileExists(sourcePath)) {
        evidenceFiles.push(Object.freeze({ path: target, bytes: await readFile(sourcePath) }));
      }
    }
    if (provider === "xai") {
      for (const name of ["xai-server-vad-gate-a-risk.json", "xai-server-vad-gate-b-binding.json"] as const) {
        const sourcePath = resolve(shardRoot, name);
        if (await fileExists(sourcePath)) {
          evidenceFiles.push(Object.freeze({ path: name, bytes: await readFile(sourcePath) }));
        }
      }
    }
  }
  return Object.freeze({ manifest, aggregate, shards: Object.freeze(shards), evidenceFiles: Object.freeze(evidenceFiles) });
}

async function retainPackage(
  root: string,
  attemptId: string,
  status: "passed" | "failed",
  files: readonly Lc4QualificationPackageFile[],
  envelope: unknown,
): Promise<string> {
  const attempts = resolve(root, "attempts");
  await mkdir(attempts, { recursive: true, mode: 0o700 });
  const partial = resolve(attempts, `${attemptId}.v4-package.partial`);
  const terminal = resolve(attempts, status === "passed"
    ? `${attemptId}.v4-package.complete`
    : `${attemptId}.v4-package.sealed-failure`);
  await mkdir(partial, { mode: 0o700 });
  for (const file of files) await writeFile(resolve(partial, file.path), file.bytes, { flag: "wx", mode: 0o400 });
  await writeFile(
    resolve(partial, "qualification-package-envelope.json"),
    `${canonicalJson(envelope)}\n`,
    { flag: "wx", mode: 0o400 },
  );
  await rename(partial, terminal);
  return terminal;
}

const LIVE_FLAGS = Object.freeze([
  "--root",
  "--repository-root",
  "--authorization",
  "--trust-root-fingerprint",
  "--terminal-private-key",
  "--provider-env-file",
  "--repo-env-file",
] as const);

const QUALIFICATION_V4_USAGE = [
  "HACC LC4 three-provider qualification v4",
  "",
  "Commands:",
  "  status",
  "  inspect  --root ABS --repository-root ABS --authorization ABS --trust-root-fingerprint SHA256 --terminal-private-key ABS --provider-env-file ABS --repo-env-file ABS",
  "  continue --root ABS --repository-root ABS --authorization ABS --trust-root-fingerprint SHA256 --terminal-private-key ABS --provider-env-file ABS --repo-env-file ABS",
  "",
  "status and --help make no provider calls. continue is capped at $3, runs OpenAI/Gemini/xAI serially,",
  "reuses completed signed shards, and may continue only an unopened shard or retained setup before paid admission.",
  "An admitted phase without terminal evidence is quarantined permanently: no retry, reconnect, fallback, or replacement.",
].join("\n");

export async function runLc4QualificationV4OperatorCli(
  args: readonly string[],
  io: Io = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    now: () => new Date(),
  },
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.stdout(`${QUALIFICATION_V4_USAGE}\n`);
    return 0;
  }
  try {
    const command = args[0];
    const parsed = flags(args.slice(1));
    if (command === "status") {
      exactFlags(parsed, []);
      io.stdout(`${canonicalJson({
        operator: "HACC-LC4-QUALIFICATION-V4-OPERATOR-v1",
        default: false,
        provider_order: ["openai", "gemini", "xai"],
        resumable_boundaries: ["unopened_provider_shard", "retained_setup_before_paid_admission"],
        admitted_without_terminal: "quarantine_no_retry",
        maximum_total_usd: 3,
        paid_retries: 0,
      })}\n`);
      return 0;
    }
    if (command !== "continue" && command !== "inspect") {
      throw new Error("usage: qualification-v4-operator <status|continue|inspect>");
    }
    exactFlags(parsed, LIVE_FLAGS);
    const root = absolute(parsed["--root"], "qualification v4 root");
    const repositoryRoot = absolute(parsed["--repository-root"], "qualification v4 repository root");
    const now = io.now();
    const state = await productionState({
      root,
      repositoryRoot,
      providerEnvFile: absolute(parsed["--provider-env-file"], "provider environment file"),
      repoEnvFile: absolute(parsed["--repo-env-file"], "repository environment file"),
      authorizationPath: absolute(parsed["--authorization"], "authorization path"),
      terminalPrivateKeyPath: absolute(parsed["--terminal-private-key"], "terminal private key path"),
      trustRootFingerprint: parsed["--trust-root-fingerprint"],
      now,
    });
    if (command === "inspect") {
      io.stdout(`${canonicalJson(await inspectLc4QualificationV4ProviderShards({
        root,
        repository_root: repositoryRoot,
        binding: state.binding,
      }))}\n`);
      return 0;
    }

    const budgetBinding: Lc4QualificationBudgetBinding = Object.freeze({
      attemptId: state.authorization.body.authorization_id,
      authorizationId: state.authorization.body.authorization_id,
      authorizationArtifactSha256: state.authorization.artifact_sha256,
      planSha256: state.plan.body.plan_sha256,
      sourceCommit: state.source.source_commit,
      sourceTreeSha256: state.source.source_tree_sha256,
      credentialSetSha256: state.plan.body.credential_set_sha256,
      providerProfileManifestSha256: state.plan.body.provider_profile_manifest_sha256,
      configurationMatrixSha256: state.plan.body.setup_configuration_matrix_sha256,
      devConfigurationMatrixSha256: state.plan.body.paid_configuration_matrix_sha256,
      providersModels: Object.freeze(Object.fromEntries(state.plan.body.targets.map((target) => [target.provider, target.model])) as Record<"openai" | "gemini" | "xai", string>),
      expiresAt: state.authorization.body.expires_at,
    });
    const budget = await reserveOrResumeLc4QualificationBudget({ root, binding: budgetBinding, now: io.now });
    const aggregate = await runLc4QualificationV4ProviderShards({
      root,
      repository_root: repositoryRoot,
      binding: state.binding,
      invoked_at: await originalInvocationTime(root, now),
      dependencies: {
        async runSetup(context) {
          const target = state.setupTargets.find((candidate) => candidate.provider === context.provider)!;
          const shardRoot = resolve(root, "qualification-v4-shards", `${LC4_QUALIFICATION_V4_PROVIDER_ORDINAL[context.provider]}-${context.provider}`);
          const artifact = await qualifyProviderTargetShard({
            root: shardRoot,
            protocolId: state.plan.body.protocol_id,
            planSha256: state.plan.body.plan_sha256,
            sourceCommit: state.source.source_commit,
            target,
            matrixTargets: state.setupTargets,
            credentials: state.credentials,
            signedCredentialSetSha256: state.plan.body.credential_set_sha256,
            qualificationId: `qv4-${context.provider}`,
            createClient: (candidate, apiKey) => createProductionRealtimeClient(
              candidate.provider,
              candidate.configuration,
              apiKey,
              qualificationClientOptions(candidate.provider),
            ),
            now: io.now,
          });
          const providerResult = artifact.results[0]!;
          const wire = providerResult.setupWireEvidence?.observations
            ?? providerResult.setupFailureEvidence?.observations
            ?? [];
          if (context.provider === "xai") {
            const planned = state.plan.body.targets.find((candidate) => candidate.provider === "xai")!;
            const risk = createXaiServerVadGateARiskArtifact({
              setup: providerResult,
              sourceCommit: state.source.source_commit,
              planSha256: state.plan.body.plan_sha256,
              configurationMatrixSha256: state.plan.body.setup_configuration_matrix_sha256,
              providerProfileManifestSha256: state.plan.body.provider_profile_manifest_sha256,
              productionSessionPayloadSha256: planned.production_session_payload_sha256!,
            });
            assertXaiServerVadGateARiskArtifact(risk);
            await writeFile(
              resolve(shardRoot, "xai-server-vad-gate-a-risk.json"),
              `${canonicalJson(risk)}\n`,
              { flag: "wx", mode: 0o400 },
            );
          }
          return Object.freeze({
            status: providerResult.status,
            failure_class: providerResult.status === "passed" ? "none" : providerResult.code,
            evidence_sha256: artifact.artifactSha256,
            wire_head_sha256: wire.at(-1)?.observationSha256 ?? null,
            wire_observation_count: wire.length,
            reconnect_count: wire.filter((observation) => observation.connectionEpoch !== 1).length,
            usage_event_count: 0,
            usage_evidence_sha256: sha256Hex(canonicalJson([])),
            provider_sessions_opened: 1 as const,
            paid_sessions_opened: 0 as const,
            generation_phases_attempted: 0 as const,
            tool_roundtrips_attempted: 0 as const,
          });
        },
        async runPaid(context) {
          const target = state.paidTargets.find((candidate) => candidate.provider === context.provider)!;
          const planned = state.plan.body.targets.find((candidate) => candidate.provider === context.provider)!;
          const audio = await loadLc4S2sPcm({ root, artifact: state.plan.body.audio_fixture, provider: context.provider });
          const execution = await executeLc4S2sToolRoundtrip({
            provider: context.provider,
            model: target.model,
            client: createProductionRealtimeClient(
              context.provider,
              target.configuration,
              state.credentials[context.provider],
              qualificationClientOptions(context.provider),
            ),
            audio,
            audioObject: state.plan.body.audio_fixture.provider_renditions[context.provider],
            profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
            timeoutMs: 45_000,
            now: io.now,
          });
          assertLc4S2sRoundtripExecution(execution);
          if (execution.audio.sha256 !== planned.caller_audio_sha256
            || execution.audio.byte_length !== planned.caller_audio_bytes
            || execution.tool_schema_sha256 !== LC4_S2S_TOOL_SCHEMA_SHA256) {
            throw new Error(`${context.provider} paid execution differs from signed plan`);
          }
          const shardRoot = resolve(root, "qualification-v4-shards", `${LC4_QUALIFICATION_V4_PROVIDER_ORDINAL[context.provider]}-${context.provider}`);
          await retainRoundtrip(shardRoot, execution);
          if (context.provider === "xai" && execution.status === "passed") {
            const risk = await readJson<Lc4XaiServerVadGateARiskArtifact>(
              resolve(shardRoot, "xai-server-vad-gate-a-risk.json"),
            );
            const expectedTransportParitySha256 = state.plan.body.targets.find(
              (candidate) => candidate.provider === "xai",
            )!.xai_transport_parity_sha256!;
            const gateB = createXaiServerVadGateBBindingArtifact({
              risk,
              execution,
              sourceCommit: state.source.source_commit,
              planSha256: state.plan.body.plan_sha256,
              providerProfileManifestSha256: state.plan.body.provider_profile_manifest_sha256,
              expectedTransportParitySha256,
            });
            assertXaiServerVadGateBBindingArtifact({
              artifact: gateB,
              risk,
              execution,
              expectedTransportParitySha256,
            });
            await writeFile(
              resolve(shardRoot, "xai-server-vad-gate-b-binding.json"),
              `${canonicalJson(gateB)}\n`,
              { flag: "wx", mode: 0o400 },
            );
          }
          return Object.freeze({
            status: execution.status,
            failure_class: execution.status === "passed" ? "none" : execution.failure_class,
            evidence_sha256: execution.evidence_sha256,
            wire_head_sha256: execution.wire_observations.at(-1)?.observationSha256 ?? null,
            wire_observation_count: execution.wire_observations.length,
            reconnect_count: execution.wire_observations.filter((observation) => observation.connectionEpoch !== 1).length,
            usage_event_count: execution.sanitized_usage.length,
            usage_evidence_sha256: sha256Hex(canonicalJson(execution.sanitized_usage)),
            provider_sessions_opened: 1 as const,
            paid_sessions_opened: 1 as const,
            generation_phases_attempted: 2 as const,
            tool_roundtrips_attempted: 1 as const,
          });
        },
      },
    });
    const budgetEvidence = await finalizeLc4QualificationBudget({
      reservation: budget,
      attemptId: state.authorization.body.authorization_id,
      usageEventCount: aggregate.usage_event_count,
      usageEvidenceSha256: aggregate.usage_evidence_sha256,
      outcome: aggregate.status === "passed" ? "completed" : "failed",
      now: io.now,
    });
    const replay = await loadLc4QualificationV4ReplayArtifacts(root);
    const signedPackage = createSignedLc4QualificationV4Package({
      binding: state.binding,
      manifest: replay.manifest,
      aggregate: replay.aggregate,
      shards: replay.shards,
      plan: state.plan,
      authorization: state.authorization,
      budget: budgetEvidence,
      budgetBinding,
      terminalPrivateKeyPem: state.terminalPrivateKeyPem,
      sealedAt: io.now().toISOString(),
      evidenceFiles: replay.evidenceFiles,
    });
    const custody = await verifySignedLc4QualificationV4PackageCustody({
      envelope: signedPackage.envelope,
      files: signedPackage.files,
      expectedTrustRootFingerprintSha256: parsed["--trust-root-fingerprint"],
      expectedBinding: state.binding,
      budgetBinding,
    });
    if (custody.publication_eligible !== false
      || custody.terminal.body.status !== aggregate.status
      || custody.aggregate.status !== aggregate.status) {
      throw new Error("qualification v4 custody package status differs from terminal aggregate");
    }
    if (aggregate.status === "passed") {
      await verifySignedLc4QualificationV4Package({
        envelope: signedPackage.envelope,
        files: signedPackage.files,
        expectedTrustRootFingerprintSha256: parsed["--trust-root-fingerprint"],
        expectedBinding: state.binding,
        budgetBinding,
      });
    }
    const packagePath = await retainPackage(
      root,
      state.authorization.body.authorization_id,
      aggregate.status,
      signedPackage.files,
      signedPackage.envelope,
    );
    io.stdout(`${canonicalJson({
      action: "lc4-qualification-v4-retained",
      status: aggregate.status,
      aggregate_sha256: aggregate.aggregate_sha256,
      ...(aggregate.status === "passed"
        ? { completed_provider_shards: aggregate.shard_terminal_sha256.length }
        : {
          terminalized_provider_shards: aggregate.shard_terminal_sha256.length,
          publication_eligible: false,
        }),
      paid_retries_attempted: 0,
      signed_package_path: packagePath,
      signed_package_envelope_sha256: signedPackage.envelope.artifact_sha256,
    })}\n`);
    return aggregate.status === "passed" ? 0 : 1;
  } catch (error) {
    io.stderr(`${canonicalJson({
      error: "lc4_qualification_v4_operator_refused",
      detail_sha256: sha256Hex(error instanceof Error ? error.message : String(error)),
      provider_calls_retried: 0,
    })}\n`);
    return 1;
  }
}

const LC4_QUALIFICATION_V4_PROVIDER_ORDINAL = Object.freeze({
  openai: 0,
  gemini: 1,
  xai: 2,
} as const);
