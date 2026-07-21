import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, sha256Hex } from "./artifacts";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import type { TrialSessionConfiguration } from "./orchestrator";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  SessionConfigurationAcknowledgement,
} from "../realtime/client/types";

export const PROVIDER_QUALIFICATION_SCHEMA_VERSION = 1 as const;
export const PROVIDER_QUALIFICATION_MAX_AGE_MS = 30 * 60_000;
const MAX_CLOCK_SKEW_MS = 2 * 60_000;
const QUALIFICATION_HASH_DOMAIN = "harshas-amazing-call-center/provider-qualification/v1";
const MATRIX_HASH_DOMAIN = "harshas-amazing-call-center/provider-qualification-matrix/v1";

export type ProviderQualificationTarget = Readonly<{
  provider: LiveStsProvider;
  model: string;
  configuration: TrialSessionConfiguration;
}>;

export type ProviderQualificationCode =
  | "configuration_echo_verified"
  | "configuration_accepted_partial_echo"
  | "setup_accepted_without_field_echo"
  | "credential_missing"
  | "unauthenticated"
  | "quota_blocked"
  | "configuration_rejected"
  | "acknowledgement_missing"
  | "acknowledgement_incomplete"
  | "provider_identity_mismatch"
  | "timeout"
  | "handshake_failed";

export type ProviderQualificationResult = Readonly<{
  provider: LiveStsProvider;
  model: string;
  requestedConfigurationSha256: string;
  attemptedAt: string;
  completedAt: string;
  status: "passed" | "failed";
  code: ProviderQualificationCode;
  acknowledgementMode: "exact_provider_echo" | "partial_provider_echo" | "setup_complete_no_field_echo" | "none";
  acknowledgementSha256: string | null;
}>;

export type ProviderQualificationArtifact = Readonly<{
  schemaVersion: typeof PROVIDER_QUALIFICATION_SCHEMA_VERSION;
  qualificationId: string;
  protocolId: string;
  planSha256: string;
  sourceCommit: string;
  configurationMatrixSha256: string;
  credentialSetSha256: string;
  probeScope: "session_handshake_and_configuration_acknowledgement_no_audio_no_generation";
  attemptedAt: string;
  completedAt: string;
  status: "passed" | "failed";
  results: readonly ProviderQualificationResult[];
  artifactSha256: string;
}>;

type QualifyInput = Readonly<{
  root: string;
  protocolId: string;
  planSha256: string;
  sourceCommit: string;
  targets: readonly ProviderQualificationTarget[];
  credentials: Readonly<Partial<Record<LiveStsProvider, string>>>;
  createClient: (
    target: ProviderQualificationTarget,
    apiKey: string,
  ) => NormalizedRealtimeClient | Promise<NormalizedRealtimeClient>;
  now?: () => Date;
  qualificationId?: string;
}>;

type GateInput = Readonly<{
  root: string;
  protocolId: string;
  planSha256: string;
  sourceCommit: string;
  targets: readonly ProviderQualificationTarget[];
  credentials: Readonly<Partial<Record<LiveStsProvider, string>>>;
  now?: () => Date;
}>;

function configurationSha256(target: ProviderQualificationTarget): string {
  return sha256Hex(`harshas-amazing-call-center/provider-session-configuration/v1\n${canonicalJson({
    provider: target.provider,
    model: target.model,
    configuration: target.configuration,
  })}`);
}

function normalizedMatrix(targets: readonly ProviderQualificationTarget[]) {
  for (const target of targets) {
    if (target.configuration.provider !== target.provider || target.configuration.model !== target.model) {
      throw new Error("provider qualification target identity differs from its session configuration");
    }
  }
  const entries = targets.map((target) => Object.freeze({
    provider: target.provider,
    model: target.model,
    requestedConfigurationSha256: configurationSha256(target),
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const unique = new Set(entries.map((entry) => canonicalJson(entry)));
  if (unique.size !== entries.length) throw new Error("provider qualification targets contain a duplicate configuration");
  if (entries.length === 0) throw new Error("provider qualification requires at least one target");
  const providers = new Set(entries.map((entry) => entry.provider));
  if (["openai", "gemini", "xai"].some((provider) => !providers.has(provider as LiveStsProvider))) {
    throw new Error("provider qualification matrix must include OpenAI, Gemini, and xAI");
  }
  return Object.freeze(entries);
}

export function providerQualificationMatrixSha256(
  targets: readonly ProviderQualificationTarget[],
): string {
  return sha256Hex(`${MATRIX_HASH_DOMAIN}\n${canonicalJson(normalizedMatrix(targets))}`);
}

function providerCredentialSetSha256(
  credentials: Readonly<Partial<Record<LiveStsProvider, string>>>,
): string {
  return sha256Hex(`harshas-amazing-call-center/provider-credential-set/v1\n${canonicalJson(
    (["openai", "gemini", "xai"] as const).map((provider) => ({
      provider,
      credentialSha256: credentials[provider]
        ? sha256Hex(`harshas-amazing-call-center/provider-credential/v1\n${credentials[provider]}`)
        : null,
    })),
  )}`);
}

function acknowledgementSha256(value: SessionConfigurationAcknowledgement): string {
  return sha256Hex(`harshas-amazing-call-center/provider-configuration-acknowledgement/v1\n${canonicalJson(value)}`);
}

function acknowledgementResult(
  target: ProviderQualificationTarget,
  readyEvent: Extract<NormalizedRealtimeEvent, { type: "session.ready" }> | null,
  fallback: SessionConfigurationAcknowledgement | null | undefined,
): Pick<ProviderQualificationResult, "status" | "code" | "acknowledgementMode" | "acknowledgementSha256"> {
  if (readyEvent?.provider !== target.provider) {
    return { status: "failed", code: "provider_identity_mismatch", acknowledgementMode: "none", acknowledgementSha256: null };
  }
  const acknowledgement = readyEvent.configuration ?? fallback ?? null;
  if (!acknowledgement) {
    return { status: "failed", code: "acknowledgement_missing", acknowledgementMode: "none", acknowledgementSha256: null };
  }
  const digest = acknowledgementSha256(acknowledgement);
  const fields = Object.values(acknowledgement.fields);
  if (fields.some((field) => field.status === "mismatch")) {
    return { status: "failed", code: "configuration_rejected", acknowledgementMode: "none", acknowledgementSha256: digest };
  }
  if (target.provider === "gemini") {
    const allowed = fields.every((field) => field.status === "unverifiable" || field.status === "not_requested");
    if (
      readyEvent.wireType !== "setupComplete"
      || acknowledgement.strictParityVerified
      || acknowledgement.paidBenchmarkReady
      || !allowed
    ) {
      return { status: "failed", code: "acknowledgement_incomplete", acknowledgementMode: "none", acknowledgementSha256: digest };
    }
    return {
      status: "passed",
      code: "setup_accepted_without_field_echo",
      acknowledgementMode: "setup_complete_no_field_echo",
      acknowledgementSha256: digest,
    };
  }
  if (target.provider === "xai" && (!acknowledgement.strictParityVerified || !acknowledgement.paidBenchmarkReady)) {
    const requiredEchoes = [
      acknowledgement.fields.model,
      acknowledgement.fields.instructions,
      acknowledgement.fields.tool_choice,
      acknowledgement.fields.output_audio,
      acknowledgement.fields.turn_detection,
    ];
    const acceptedStatuses = fields.every((field) => (
      field.status === "verified" || field.status === "unverifiable" || field.status === "not_requested"
    ));
    if (
      readyEvent.wireType !== "session.updated"
      || requiredEchoes.some((field) => field.status !== "verified")
      || !acceptedStatuses
      || (acknowledgement.session?.status !== "verified" && acknowledgement.session?.status !== "unverifiable")
    ) {
      return { status: "failed", code: "acknowledgement_incomplete", acknowledgementMode: "none", acknowledgementSha256: digest };
    }
    return {
      status: "passed",
      code: "configuration_accepted_partial_echo",
      acknowledgementMode: "partial_provider_echo",
      acknowledgementSha256: digest,
    };
  }
  if (!acknowledgement.strictParityVerified || !acknowledgement.paidBenchmarkReady) {
    return { status: "failed", code: "acknowledgement_incomplete", acknowledgementMode: "none", acknowledgementSha256: digest };
  }
  return {
    status: "passed",
    code: "configuration_echo_verified",
    acknowledgementMode: "exact_provider_echo",
    acknowledgementSha256: digest,
  };
}

function classifiedFailure(error: unknown): ProviderQualificationCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/quota|rate.?limit|resource.?exhausted|insufficient.?quota|billing|\b429\b/i.test(message)) return "quota_blocked";
  if (/unauth|authentication|api.?key|permission.?denied|forbidden|\b401\b|\b403\b/i.test(message)) return "unauthenticated";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/config|setup|model|voice|tool|invalid.?argument|unsupported|\b400\b|\b404\b|\b422\b/i.test(message)) {
    return "configuration_rejected";
  }
  return "handshake_failed";
}

async function qualifyTarget(
  target: ProviderQualificationTarget,
  apiKey: string | undefined,
  createClient: QualifyInput["createClient"],
  now: () => Date,
): Promise<ProviderQualificationResult> {
  const attemptedAt = now().toISOString();
  const requestedConfigurationSha256 = configurationSha256(target);
  if (!apiKey || apiKey.length < 12) {
    return Object.freeze({
      provider: target.provider,
      model: target.model,
      requestedConfigurationSha256,
      attemptedAt,
      completedAt: now().toISOString(),
      status: "failed",
      code: "credential_missing",
      acknowledgementMode: "none",
      acknowledgementSha256: null,
    });
  }
  let client: NormalizedRealtimeClient | null = null;
  let readyEvent: Extract<NormalizedRealtimeEvent, { type: "session.ready" }> | null = null;
  let unsubscribe: (() => void) | undefined;
  try {
    client = await createClient(target, apiKey);
    unsubscribe = client.onEvent((event) => {
      if (event.type === "session.ready") readyEvent = event;
    });
    await client.connect();
    if (client.state !== "ready") {
      return Object.freeze({
        provider: target.provider,
        model: target.model,
        requestedConfigurationSha256,
        attemptedAt,
        completedAt: now().toISOString(),
        status: "failed",
        code: "handshake_failed",
        acknowledgementMode: "none",
        acknowledgementSha256: null,
      });
    }
    const outcome = acknowledgementResult(target, readyEvent, client.sessionConfigurationAcknowledgement);
    return Object.freeze({
      provider: target.provider,
      model: target.model,
      requestedConfigurationSha256,
      attemptedAt,
      completedAt: now().toISOString(),
      ...outcome,
    });
  } catch (error) {
    return Object.freeze({
      provider: target.provider,
      model: target.model,
      requestedConfigurationSha256,
      attemptedAt,
      completedAt: now().toISOString(),
      status: "failed",
      code: classifiedFailure(error),
      acknowledgementMode: "none",
      acknowledgementSha256: null,
    });
  } finally {
    unsubscribe?.();
    client?.close(1000, "qualification complete");
  }
}

function qualificationArtifactSha256(body: Omit<ProviderQualificationArtifact, "artifactSha256">): string {
  return sha256Hex(`${QUALIFICATION_HASH_DOMAIN}\n${canonicalJson(body)}`);
}

export function assertProviderQualificationArtifactIntegrity(
  artifact: ProviderQualificationArtifact,
): void {
  if (artifact.schemaVersion !== PROVIDER_QUALIFICATION_SCHEMA_VERSION) throw new Error("unsupported provider qualification schema");
  const { artifactSha256, ...body } = artifact;
  if (qualificationArtifactSha256(body) !== artifactSha256) throw new Error("provider qualification artifact hash mismatch");
  if (!artifact.results.length) throw new Error("provider qualification artifact has no results");
  if (artifact.status === "passed" !== artifact.results.every((result) => result.status === "passed")) {
    throw new Error("provider qualification aggregate status is inconsistent");
  }
}

export async function qualifyProviders(input: QualifyInput): Promise<ProviderQualificationArtifact> {
  const now = input.now ?? (() => new Date());
  const attemptedAt = now().toISOString();
  const qualificationId = input.qualificationId ?? randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(qualificationId)) {
    throw new Error("provider qualification ID must be a safe opaque identifier");
  }
  const targetsByProvider = new Map<LiveStsProvider, ProviderQualificationTarget[]>();
  for (const target of input.targets) {
    const list = targetsByProvider.get(target.provider) ?? [];
    list.push(target);
    targetsByProvider.set(target.provider, list);
  }
  const providerResults = await Promise.all([...targetsByProvider.entries()].map(async ([provider, targets]) => {
    const results: ProviderQualificationResult[] = [];
    for (const target of targets) {
      results.push(await qualifyTarget(target, input.credentials[provider], input.createClient, now));
    }
    return results;
  }));
  const results = Object.freeze(providerResults.flat().sort((left, right) => (
    left.provider.localeCompare(right.provider)
    || left.model.localeCompare(right.model)
    || left.requestedConfigurationSha256.localeCompare(right.requestedConfigurationSha256)
  )));
  const body = Object.freeze({
    schemaVersion: PROVIDER_QUALIFICATION_SCHEMA_VERSION,
    qualificationId,
    protocolId: input.protocolId,
    planSha256: input.planSha256,
    sourceCommit: input.sourceCommit,
    configurationMatrixSha256: providerQualificationMatrixSha256(input.targets),
    credentialSetSha256: providerCredentialSetSha256(input.credentials),
    probeScope: "session_handshake_and_configuration_acknowledgement_no_audio_no_generation" as const,
    attemptedAt,
    completedAt: now().toISOString(),
    status: results.every((result) => result.status === "passed") ? "passed" as const : "failed" as const,
    results,
  });
  const artifact: ProviderQualificationArtifact = Object.freeze({
    ...body,
    artifactSha256: qualificationArtifactSha256(body),
  });
  const directory = resolve(input.root, "qualifications");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timestamp = attemptedAt.replace(/[:.]/g, "-");
  const path = resolve(directory, `${timestamp}-${artifact.qualificationId}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${canonicalJson(artifact)}\n`, { flag: "wx", mode: 0o600 });
  try {
    // Hard-link publication is atomic and fails rather than replacing an earlier immutable attempt.
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return artifact;
}

export async function assertRecentPassingProviderQualification(input: GateInput): Promise<ProviderQualificationArtifact> {
  const directory = resolve(input.root, "qualifications");
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const expectedMatrix = providerQualificationMatrixSha256(input.targets);
  const expectedCredentials = providerCredentialSetSha256(input.credentials);
  const nowMs = (input.now ?? (() => new Date()))().getTime();
  const passing: ProviderQualificationArtifact[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    let artifact: ProviderQualificationArtifact;
    try {
      artifact = JSON.parse(await readFile(resolve(directory, name), "utf8")) as ProviderQualificationArtifact;
      assertProviderQualificationArtifactIntegrity(artifact);
    } catch (error) {
      throw new Error(`provider qualification artifact ${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (
      artifact.status !== "passed"
      || artifact.protocolId !== input.protocolId
      || artifact.planSha256 !== input.planSha256
      || artifact.sourceCommit !== input.sourceCommit
      || artifact.configurationMatrixSha256 !== expectedMatrix
      || artifact.credentialSetSha256 !== expectedCredentials
      || artifact.probeScope !== "session_handshake_and_configuration_acknowledgement_no_audio_no_generation"
    ) continue;
    const completedAtMs = Date.parse(artifact.completedAt);
    if (
      Number.isFinite(completedAtMs)
      && completedAtMs <= nowMs + MAX_CLOCK_SKEW_MS
      && nowMs - completedAtMs <= PROVIDER_QUALIFICATION_MAX_AGE_MS
    ) passing.push(artifact);
  }
  const latest = passing.sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
  if (!latest) throw new Error("paid run requires a recent passing provider qualification bound to this exact plan and configuration matrix");
  return latest;
}
