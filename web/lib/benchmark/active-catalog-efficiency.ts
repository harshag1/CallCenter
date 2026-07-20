import corpusDocument from "../../../benchmarks/voice-long-horizon/corpora/active-catalog-efficiency-64.v1.json";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  activeCapabilityCatalogInstructions,
  bindActiveCapabilityInvocation,
  buildActiveCapabilityAuthority,
  type ActiveCapabilityCatalogEntry,
  type ActiveCapabilitySource,
} from "../active-capability-catalog";
import { activeFlowContext, activeFlowControlDefinitions } from "../active-capability-flow";
import { AgentFlowSchema, validateAgentFlow, type AgentFlow } from "../flow";
import {
  completeFlowStep,
  createFlowExecutionState,
  enterFlowStep,
  flowCapabilityScope,
  grantedTools,
  selectFlowTopic,
  type FlowExecutionState,
} from "../flow-runtime";
import { assertFlowToolCatalogClosure } from "../flow-tool-catalog";
import type { VoiceToolDefinition } from "../voice-tools/types";
import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";

const BENCHMARK_VERSION = "active-catalog-efficiency.v1" as const;
const RESULT_HASH_DOMAIN = "harshas-amazing-call-center/active-catalog-efficiency-result/v1\n";
const SOURCE_MANIFEST_HASH_DOMAIN = "harshas-amazing-call-center/active-catalog-efficiency-source-manifest/v1\n";
const BUILD_MANIFEST_HASH_DOMAIN = "harshas-amazing-call-center/active-catalog-efficiency-build-manifest/v1\n";
const TOOLCHAIN_MANIFEST_HASH_DOMAIN = "harshas-amazing-call-center/active-catalog-efficiency-toolchain/v1\n";
const EVIDENCE_HASH_DOMAIN = "harshas-amazing-call-center/active-catalog-efficiency-evidence/v1\n";
const SERIALIZER_VERSIONS = Object.freeze({
  logical_entry_array: "benchmark-artifacts.canonical-json.v1",
  full_catalog_json: "json-stringify.active-capability-catalog.v1",
  provider_instruction_block: "active-capability-catalog-instructions.v1",
} as const);
const ESTIMATOR_VERSION = "utf8-ceil-div4.v1" as const;
const FIXED_AT = "2026-07-16T20:00:00.000Z";
const TOOL_NAME = /^[a-z][a-z0-9_.-]{1,63}$/;
const PRIVATE_GRANT_PREFIX = "private-grant-sentinel-v1-";
const PRIVATE_GRANT_VARIANT_PREFIX = "private-grant-sentinel-v2-";
const PRIVATE_EXPIRY = "2030-01-01T00:00:00.000Z";
const PRIVATE_EXPIRY_VARIANT = "2031-01-01T00:00:00.000Z";
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE_PATHS = [
  "benchmarks/voice-long-horizon/corpora/active-catalog-efficiency-64.v1.json",
  "web/lib/active-capability-catalog.ts",
  "web/lib/active-capability-flow.ts",
  "web/lib/benchmark/active-catalog-efficiency.ts",
  "web/lib/benchmark/artifacts.ts",
  "web/lib/flow-runtime.ts",
  "web/lib/flow-tool-catalog.ts",
  "web/lib/flow.ts",
  "web/lib/voice-tools/schema.ts",
] as const;

const CorpusToolSchema = z.object({
  logical_name: z.string().regex(TOOL_NAME),
  description: z.string().min(1).max(2_048),
  effect: z.enum(["read", "write"]),
  schema_template: z.enum([
    "subject_lookup",
    "filtered_list",
    "evidence_check",
    "quote",
    "mutation",
    "delivery",
  ]),
}).strict();

const CorpusSchema = z.object({
  schema_version: z.literal(1),
  corpus_id: z.literal("active-catalog-efficiency-64.v1"),
  description: z.string().min(1),
  groups: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    label: z.string().min(1),
    context: z.string().min(1),
    tools: z.array(CorpusToolSchema).length(8),
  }).strict()).length(8),
}).strict().superRefine((corpus, ctx) => {
  const names = corpus.groups.flatMap((group) => group.tools.map((tool) => tool.logical_name));
  if (new Set(names).size !== 64) {
    ctx.addIssue({ code: "custom", path: ["groups"], message: "corpus must contain 64 unique tools" });
  }
  for (const [index, group] of corpus.groups.entries()) {
    const reads = group.tools.filter((tool) => tool.effect === "read").length;
    const writes = group.tools.filter((tool) => tool.effect === "write").length;
    if (reads !== 4 || writes !== 4) {
      ctx.addIssue({
        code: "custom",
        path: ["groups", index, "tools"],
        message: "each group must contain four read and four write tools",
      });
    }
  }
});

const corpus = CorpusSchema.parse(corpusDocument);
type CorpusTool = z.infer<typeof CorpusToolSchema>;

function readProjectFile(path: string): Buffer {
  return readFileSync(resolve(PROJECT_ROOT, path));
}

function sourceAndToolchainProvenance() {
  const files = SOURCE_PATHS.map((path) => {
    const contents = readProjectFile(path);
    return {
      path,
      bytes: contents.byteLength,
      sha256: sha256Hex(contents),
    };
  });
  const sourceManifest = {
    schema_version: 1,
    benchmark_version: BENCHMARK_VERSION,
    serializer_versions: SERIALIZER_VERSIONS,
    estimator_version: ESTIMATOR_VERSION,
    files,
  } as const;
  const packageJsonBytes = readProjectFile("web/package.json");
  const packageLockBytes = readProjectFile("web/package-lock.json");
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8")) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };
  const packageLock = JSON.parse(packageLockBytes.toString("utf8")) as {
    lockfileVersion?: number;
    packages?: Record<string, { version?: string }>;
  };
  const lockedVersion = (name: string) => {
    const version = packageLock.packages?.[`node_modules/${name}`]?.version;
    if (!version) throw new Error(`package-lock is missing ${name}`);
    return version;
  };
  const installedVersion = (name: string) => {
    const installed = JSON.parse(readProjectFile(`web/node_modules/${name}/package.json`).toString("utf8")) as {
      version?: string;
    };
    if (!installed.version) throw new Error(`installed ${name} package has no version`);
    return installed.version;
  };
  const lockedPackages = {
    tsx: lockedVersion("tsx"),
    typescript: lockedVersion("typescript"),
    vitest: lockedVersion("vitest"),
    zod: lockedVersion("zod"),
  } as const;
  const observedPackages = {
    tsx: installedVersion("tsx"),
    typescript: installedVersion("typescript"),
    vitest: installedVersion("vitest"),
    zod: installedVersion("zod"),
  } as const;
  if (canonicalJson(lockedPackages) !== canonicalJson(observedPackages)) {
    throw new Error("installed benchmark toolchain differs from package-lock");
  }
  const toolchainManifest = {
    schema_version: 1,
    observed_runtime: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      architecture: process.arch,
    },
    declared_node_engine: packageJson.engines?.node ?? null,
    declared_commands: {
      benchmark_active_catalog: packageJson.scripts?.["benchmark:active-catalog"] ?? null,
      db_test_integration: packageJson.scripts?.["db:test-integration"] ?? null,
    },
    package_lock_version: packageLock.lockfileVersion ?? null,
    locked_packages: lockedPackages,
    observed_packages: observedPackages,
    package_json: {
      bytes: packageJsonBytes.byteLength,
      sha256: sha256Hex(packageJsonBytes),
    },
    package_lock: {
      bytes: packageLockBytes.byteLength,
      sha256: sha256Hex(packageLockBytes),
    },
  } as const;
  return {
    source_manifest: sourceManifest,
    source_manifest_sha256: sha256Hex(
      `${SOURCE_MANIFEST_HASH_DOMAIN}${canonicalJson(sourceManifest)}`
    ),
    toolchain_manifest: toolchainManifest,
    toolchain_manifest_sha256: sha256Hex(
      `${TOOLCHAIN_MANIFEST_HASH_DOMAIN}${canonicalJson(toolchainManifest)}`
    ),
  } as const;
}

function inputSchema(tool: CorpusTool): Readonly<Record<string, unknown>> {
  const subject = {
    type: "string",
    minLength: 1,
    maxLength: 128,
    description: "Stable caller or case reference collected in the current flow.",
  };
  const base = {
    type: "object",
    additionalProperties: false,
  } as const;
  switch (tool.schema_template) {
    case "subject_lookup":
      return {
        ...base,
        properties: {
          subject_id: subject,
          locale: { type: "string", minLength: 2, maxLength: 32 },
        },
        required: ["subject_id"],
      };
    case "filtered_list":
      return {
        ...base,
        properties: {
          subject_id: subject,
          filter: { type: "string", minLength: 1, maxLength: 256 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["subject_id"],
      };
    case "evidence_check":
      return {
        ...base,
        properties: {
          subject_id: subject,
          evidence_reference: { type: "string", minLength: 1, maxLength: 256 },
        },
        required: ["subject_id", "evidence_reference"],
      };
    case "quote":
      return {
        ...base,
        properties: {
          subject_id: subject,
          option_id: { type: "string", minLength: 1, maxLength: 128 },
          currency: { type: "string", enum: ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] },
        },
        required: ["subject_id"],
      };
    case "mutation":
      return {
        ...base,
        properties: {
          subject_id: subject,
          requested_change: { type: "string", minLength: 1, maxLength: 512 },
          confirmed: { type: "boolean", const: true },
        },
        required: ["subject_id", "requested_change", "confirmed"],
      };
    case "delivery":
      return {
        ...base,
        properties: {
          subject_id: subject,
          destination: { type: "string", minLength: 1, maxLength: 256 },
          confirmed: { type: "boolean", const: true },
        },
        required: ["subject_id", "destination", "confirmed"],
      };
  }
}

function definition(tool: CorpusTool): VoiceToolDefinition {
  return {
    name: tool.logical_name,
    description: tool.description,
    inputSchema: inputSchema(tool),
    outputSchema: tool.effect === "read"
      ? {
          type: "object",
          additionalProperties: false,
          properties: {
            found: { type: "boolean" },
            records: { type: "array", items: { type: "object" }, maxItems: 20 },
          },
          required: ["found", "records"],
        }
      : {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean" },
            receipt_id: { type: "string", minLength: 1, maxLength: 256 },
          },
          required: ["ok", "receipt_id"],
        },
    effect: tool.effect,
  };
}

function leasedSource(tool: CorpusTool, variant = false): ActiveCapabilitySource {
  return {
    kind: "leased_action",
    definition: definition(tool),
    capabilityGrant: `${variant ? PRIVATE_GRANT_VARIANT_PREFIX : PRIVATE_GRANT_PREFIX}${tool.logical_name}`,
    capabilityExpiresAt: variant ? PRIVATE_EXPIRY_VARIANT : PRIVATE_EXPIRY,
    policy: {
      idempotency: tool.effect === "read" ? "per_arguments" : "per_step",
      max_calls: tool.effect === "read" ? 3 : 1,
    },
  };
}

function buildFlow(): AgentFlow {
  const topicId = "universal_voice";
  return AgentFlowSchema.parse({
    schema_version: 2,
    tool_exposure: "gateway",
    always_tools: [],
    always_action_policies: [],
    max_step_entries: 32,
    nodes: [
      { id: "entry", label: "Incoming call", kind: "incoming_call" },
      {
        id: topicId,
        label: "Universal voice workflow",
        kind: "topic",
        context: "A long, sequential voice workflow spanning eight independently scoped capability groups.",
        steps: corpus.groups.map((group, index) => ({
          id: `phase_${index + 1}_${group.id}`,
          label: group.label,
          context: group.context,
          instructions: `Complete only the ${group.label.toLowerCase()} phase. Use no action from another phase.`,
          entry: index === 0,
          tools: group.tools.map((tool) => tool.logical_name),
          action_policies: group.tools.map((tool) => ({
            tool: tool.logical_name,
            idempotency: tool.effect === "read" ? "per_arguments" : "per_step",
            max_calls: tool.effect === "read" ? 3 : 1,
          })),
          success_criteria: [`The ${group.label.toLowerCase()} goal is resolved or explicitly handed off.`],
          checkpoint: true,
          max_attempts: 3,
          ...(index + 1 < corpus.groups.length
            ? {
                transitions: [{
                  to: `${topicId}.phase_${index + 2}_${corpus.groups[index + 1].id}`,
                  label: `Continue to ${corpus.groups[index + 1].label}`,
                  when: "the current phase is durably complete",
                }],
              }
            : {}),
        })),
      },
    ],
    edges: [{ from: "entry", to: topicId, label: "Begin" }],
  });
}

function buildFlatFlow(flow: AgentFlow): AgentFlow {
  const tools = corpus.groups.flatMap((group) => group.tools);
  return AgentFlowSchema.parse({
    ...flow,
    nodes: flow.nodes.map((node) => node.id !== "universal_voice" ? node : {
      ...node,
      steps: [{
        id: "all_capabilities",
        label: "All capabilities",
        instructions: "Choose from every business action at once.",
        entry: true,
        tools: tools.map((tool) => tool.logical_name),
        action_policies: tools.map((tool) => ({
          tool: tool.logical_name,
          idempotency: tool.effect === "read" ? "per_arguments" : "per_step",
          max_calls: tool.effect === "read" ? 3 : 1,
        })),
      }],
    }),
  });
}

function expectState(value: FlowExecutionState | { error: string }): FlowExecutionState {
  if ("error" in value) throw new Error(value.error);
  return value;
}

function frozenStateCensus(flow: AgentFlow): Array<Readonly<{
  label: string;
  group_id: string | null;
  state: FlowExecutionState;
}>> {
  const snapshots: Array<{ label: string; group_id: string | null; state: FlowExecutionState }> = [];
  let tick = 0;
  const at = () => new Date(Date.parse(FIXED_AT) + tick++ * 1_000).toISOString();
  let state = createFlowExecutionState(at());
  snapshots.push({ label: "routing", group_id: null, state });
  state = expectState(selectFlowTopic(flow, state, "universal_voice", at()));
  snapshots.push({ label: "topic_selected", group_id: null, state });
  for (const [index, group] of corpus.groups.entries()) {
    const path = `universal_voice.phase_${index + 1}_${group.id}`;
    const entered = enterFlowStep(flow, state, path, at());
    if ("error" in entered) throw new Error(entered.error);
    state = entered.state;
    snapshots.push({ label: `active:${group.id}`, group_id: group.id, state });
    const completed = completeFlowStep(flow, state, { path, outputs: {} }, at());
    if ("error" in completed) throw new Error(completed.error);
    state = completed.state;
    snapshots.push({
      label: index + 1 === corpus.groups.length ? "terminal" : `transition:${group.id}`,
      group_id: null,
      state,
    });
  }
  return snapshots;
}

function canonicalEntryArray(entries: readonly ActiveCapabilityCatalogEntry[]) {
  const json = `[${entries.map((entry) => canonicalJson(entry)).join(",")}]`;
  const parsed = JSON.parse(json) as unknown[];
  if (parsed.length !== entries.length || json[0] !== "[" || json.at(-1) !== "]") {
    throw new Error("logical-entry serializer did not produce a literal JSON array");
  }
  return {
    json,
    bytes: Buffer.byteLength(json, "utf8"),
    sha256: sha256Hex(json),
  } as const;
}

function normalizedLogicalEntry(entry: ActiveCapabilityCatalogEntry): unknown {
  return entry.invocation.mode === "host_bound_action"
    ? {
        ...entry,
        invocation: {
          ...entry.invocation,
          lease_scope_digest: "0".repeat(64),
        },
      }
    : entry;
}

function t4(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function reductionPpm(baseline: number, observed: number): number {
  if (baseline <= 0 || observed < 0 || observed > baseline) {
    throw new Error("invalid disclosure reduction operands");
  }
  return Math.round(((baseline - observed) * 1_000_000) / baseline);
}

function median(values: readonly number[]): number {
  if (!values.length) throw new Error("median requires at least one value");
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function summary(values: readonly number[]) {
  if (!values.length) throw new Error("summary requires at least one value");
  return {
    min: Math.min(...values),
    median: median(values),
    max: Math.max(...values),
  };
}

function compilerRejection(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("flat disclosure unexpectedly passed a production reliability guard");
}

function publicCatalogForState(
  flow: AgentFlow,
  state: FlowExecutionState,
  runtimeDigest: string,
  sourcesByName: ReadonlyMap<string, ActiveCapabilitySource>,
  variant = false,
) {
  const controls: ActiveCapabilitySource[] = activeFlowControlDefinitions(flow, state).map((tool) => ({
    kind: "direct",
    definition: tool,
  }));
  const business = grantedTools(flow, state).map((name) => {
    const source = sourcesByName.get(name);
    if (!source || source.kind !== "leased_action") throw new Error(`missing benchmark source ${name}`);
    if (!variant) return source;
    const corpusTool = corpus.groups.flatMap((group) => group.tools)
      .find((tool) => tool.logical_name === name);
    if (!corpusTool) throw new Error(`missing benchmark corpus tool ${name}`);
    return leasedSource(corpusTool, true);
  });
  const scope = flowCapabilityScope(state);
  return buildActiveCapabilityAuthority({
    runtimeDigest,
    state: {
      status: state.status,
      topic: state.nodeId,
      step: scope.step,
      attempt: scope.attempt,
      capabilityEpoch: state.capabilityEpoch,
      stateRevision: state.revision,
    },
    context: activeFlowContext(flow, state),
    sources: variant ? [...business, ...controls].reverse() : [...controls, ...business],
  });
}

/** Deterministic $0 production-serialization evidence; never a model-quality benchmark. */
export function runActiveCatalogEfficiencyBenchmark() {
  const sourceAndToolchain = sourceAndToolchainProvenance();
  const flow = buildFlow();
  const validation = validateAgentFlow(flow);
  const errors = validation.diagnostics.filter((diagnostic) => diagnostic.level === "error");
  if (errors.length) throw new Error(`benchmark flow is invalid: ${errors.map((error) => error.message).join("; ")}`);

  const tools = corpus.groups.flatMap((group) => group.tools);
  const allNames = new Set(tools.map((tool) => tool.logical_name));
  const consequentialNames = new Set(tools.filter((tool) => tool.effect === "write")
    .map((tool) => tool.logical_name));
  assertFlowToolCatalogClosure(flow, allNames, new Set(), consequentialNames);
  const flatFlowRejection = compilerRejection(() =>
    assertFlowToolCatalogClosure(buildFlatFlow(flow), allNames, new Set(), consequentialNames)
  );
  const sources = tools.map((tool) => leasedSource(tool));
  const sourcesByName = new Map(sources.map((source) => [source.definition.name, source]));
  const canonicalCorpus = canonicalJson(corpus);
  const canonicalCorpusSha256 = sha256Hex(canonicalCorpus);
  const corpusSource = sourceAndToolchain.source_manifest.files.find((file) =>
    file.path === "benchmarks/voice-long-horizon/corpora/active-catalog-efficiency-64.v1.json"
  );
  if (!corpusSource) throw new Error("source manifest omitted the corpus");
  const canonicalFlow = canonicalJson(flow);
  const runtimeDigest = sha256Hex(canonicalJson({
    domain: "harshas-amazing-call-center/active-catalog-efficiency-runtime/v1",
    corpus_canonical_json_sha256: canonicalCorpusSha256,
    flow,
  }));
  const buildManifest = {
    schema_version: 1,
    benchmark_version: BENCHMARK_VERSION,
    fixed_at: FIXED_AT,
    corpus: {
      raw_source_file_bytes: corpusSource.bytes,
      raw_source_file_sha256: corpusSource.sha256,
      canonical_json_bytes: Buffer.byteLength(canonicalCorpus, "utf8"),
      canonical_json_sha256: canonicalCorpusSha256,
    },
    flow: {
      canonical_json_bytes: Buffer.byteLength(canonicalFlow, "utf8"),
      canonical_json_sha256: sha256Hex(canonicalFlow),
      runtime_digest: runtimeDigest,
    },
    construction: {
      frozen_state_census: "one preselected eight-phase sequential route; no retries",
      logical_entry_reference: "64 sorted one-source non-dispatchable authorities",
      literal_array_serializer: SERIALIZER_VERSIONS.logical_entry_array,
    },
  } as const;
  const provenance = {
    ...sourceAndToolchain,
    build_manifest: buildManifest,
    build_manifest_sha256: sha256Hex(
      `${BUILD_MANIFEST_HASH_DOMAIN}${canonicalJson(buildManifest)}`
    ),
  } as const;
  const flatCatalogRejection = compilerRejection(() => buildActiveCapabilityAuthority({
    runtimeDigest,
    state: {
      status: "active",
      topic: "universal_voice",
      step: "$flat.all_capabilities",
      attempt: 1,
      capabilityEpoch: 0,
      stateRevision: 0,
    },
    context: { benchmark_projection: "flat_all_64" },
    sources,
  }));

  const referenceEntries = sources.map((source) => buildActiveCapabilityAuthority({
    runtimeDigest,
    state: {
      status: "active",
      topic: "universal_voice",
      step: "$flat.public_entry_reference",
      attempt: 1,
      capabilityEpoch: 0,
      stateRevision: 0,
    },
    context: { benchmark_projection: "single_entry_reference" },
    sources: [source],
  }).catalog.tools[0]).sort((left, right) => left.logical_name.localeCompare(right.logical_name));
  const referenceByName = new Map(referenceEntries.map((entry) => [entry.logical_name, entry]));
  const rawFullEntryArray = canonicalEntryArray(referenceEntries);
  const rawFullEntryArrayBytes = rawFullEntryArray.bytes;
  const rawFullEntryArrayT4 = t4(rawFullEntryArrayBytes);

  const reached = new Map<string, number>();
  let missingTargetCount = 0;
  let crossGroupLeakageCount = 0;
  let privateBindingChecks = 0;
  let exactEntryByteEqualCount = 0;
  let leaseScopeDigestOnlyDifferenceCount = 0;
  const normalizedDefinitionMismatches: string[] = [];
  const activeCensusEntries: ActiveCapabilityCatalogEntry[] = [];
  let forbiddenKeyHits = 0;
  let privateSentinelHits = 0;
  const forbiddenPrivateKeys = [
    '"capabilityGrant"',
    '"capability_grant"',
    '"capabilityExpiresAt"',
    '"capability_expires_at"',
    '"authorization"',
    '"credentials"',
    '"api_key"',
    '"secret"',
  ];

  const snapshots = frozenStateCensus(flow).map(({ label, group_id: groupId, state }, index) => {
    const authority = publicCatalogForState(flow, state, runtimeDigest, sourcesByName);
    const variantAuthority = publicCatalogForState(flow, state, runtimeDigest, sourcesByName, true);
    if (canonicalJson(authority.catalog) !== canonicalJson(variantAuthority.catalog)) {
      throw new Error(`public catalog changed with source order/private lease bytes at ${label}`);
    }
    const catalogJson = JSON.stringify(authority.catalog);
    const providerInstructionBlock = activeCapabilityCatalogInstructions(authority.catalog);
    const serializedPublic = `${catalogJson}\n${providerInstructionBlock}`;
    forbiddenKeyHits += forbiddenPrivateKeys.filter((key) => serializedPublic.includes(key)).length;
    privateSentinelHits += [PRIVATE_GRANT_PREFIX, PRIVATE_GRANT_VARIANT_PREFIX, PRIVATE_EXPIRY, PRIVATE_EXPIRY_VARIANT]
      .filter((sentinel) => serializedPublic.includes(sentinel)).length;

    const businessEntries = authority.catalog.tools
      .filter((entry) => allNames.has(entry.logical_name))
      .sort((left, right) => left.logical_name.localeCompare(right.logical_name));
    const businessNames = businessEntries.map((entry) => entry.logical_name);
    const expectedNames = groupId
      ? corpus.groups.find((group) => group.id === groupId)?.tools.map((tool) => tool.logical_name) ?? []
      : [];
    const expected = new Set(expectedNames);
    missingTargetCount += expectedNames.filter((name) => !businessNames.includes(name)).length;
    crossGroupLeakageCount += businessNames.filter((name) => !expected.has(name)).length;
    for (const name of businessNames) reached.set(name, (reached.get(name) ?? 0) + 1);

    for (const entry of businessEntries) {
      const name = entry.logical_name;
      const reference = referenceByName.get(name);
      if (!reference) throw new Error(`missing raw-full reference entry for ${name}`);
      const referenceJson = canonicalJson(reference);
      const activeJson = canonicalJson(entry);
      const exactByteEqual = referenceJson === activeJson;
      if (exactByteEqual) exactEntryByteEqualCount += 1;
      if (reference.invocation.mode !== "host_bound_action" ||
          entry.invocation.mode !== "host_bound_action" ||
          reference.invocation.lease_scope_digest === entry.invocation.lease_scope_digest) {
        normalizedDefinitionMismatches.push(name);
        continue;
      }
      const normalizedReferenceJson = canonicalJson(normalizedLogicalEntry(reference));
      const normalizedActiveJson = canonicalJson(normalizedLogicalEntry(entry));
      if (normalizedReferenceJson === normalizedActiveJson &&
          Buffer.byteLength(normalizedReferenceJson, "utf8") === Buffer.byteLength(normalizedActiveJson, "utf8")) {
        if (!exactByteEqual) leaseScopeDigestOnlyDifferenceCount += 1;
      } else {
        normalizedDefinitionMismatches.push(name);
      }
      activeCensusEntries.push(entry);

      const bound = bindActiveCapabilityInvocation(
        authority,
        {
          catalog_digest: authority.catalog.catalog_digest,
          capability_epoch: authority.catalog.capability_epoch,
        },
        name,
        { subject_id: "benchmark-subject" },
      );
      if (!bound.ok || bound.targetName !== "run_action" ||
          bound.targetArguments.name !== name ||
          typeof bound.targetArguments.capability_grant !== "string") {
        throw new Error(`private binding failed for ${name} at ${label}`);
      }
      privateBindingChecks += 1;
    }

    const businessEntryArray = canonicalEntryArray(businessEntries);
    const businessEntryArrayBytes = businessEntryArray.bytes;
    const metrics = authority.catalog.active_context.disclosure_metrics as Record<string, unknown>;
    const catalogBytes = Buffer.byteLength(catalogJson, "utf8");
    const providerInstructionBlockBytes = Buffer.byteLength(providerInstructionBlock, "utf8");
    const providerInstructionWrapperBytes = providerInstructionBlockBytes - catalogBytes;
    if (metrics.catalog_bytes !== catalogBytes ||
        metrics.estimated_tokens_at_4_bytes_per_token !== t4(catalogBytes) ||
        metrics.tool_count !== authority.catalog.tools.length ||
        providerInstructionWrapperBytes <= 0) {
      throw new Error(`catalog disclosure metrics disagree with production serialization at ${label}`);
    }
    return {
      index,
      label,
      group_id: groupId,
      status: state.status,
      capability_epoch: state.capabilityEpoch,
      state_revision: state.revision,
      active_business_tools: businessNames,
      active_control_tools: authority.catalog.tools
        .filter((entry) => !allNames.has(entry.logical_name))
        .map((entry) => entry.logical_name),
      active_business_tool_count: businessEntries.length,
      total_logical_tool_count: authority.catalog.tools.length,
      business_tool_count_reduction_ppm: reductionPpm(64, businessEntries.length),
      active_business_entry_array_bytes: businessEntryArrayBytes,
      active_business_entry_array_sha256: businessEntryArray.sha256,
      active_business_entry_array_t4: t4(businessEntryArrayBytes),
      active_business_entry_array_reduction_ppm: reductionPpm(
        rawFullEntryArrayBytes,
        businessEntryArrayBytes
      ),
      active_business_entry_array_t4_reduction_ppm: reductionPpm(
        rawFullEntryArrayT4,
        t4(businessEntryArrayBytes)
      ),
      full_catalog_json_bytes: catalogBytes,
      full_catalog_t4: t4(catalogBytes),
      provider_instruction_block_bytes: providerInstructionBlockBytes,
      provider_instruction_block_t4: t4(providerInstructionBlockBytes),
      provider_instruction_wrapper_bytes: providerInstructionWrapperBytes,
      catalog_digest: authority.catalog.catalog_digest,
    };
  });

  const unreachable = [...allNames].filter((name) => !reached.has(name)).sort();
  const multiplyReached = [...reached.entries()].filter(([, count]) => count !== 1)
    .map(([name]) => name).sort();
  const activeSnapshots = snapshots.filter((snapshot) => snapshot.group_id !== null);
  const normalizedReferenceArray = canonicalEntryArray(
    referenceEntries.map((entry) => normalizedLogicalEntry(entry) as ActiveCapabilityCatalogEntry)
  );
  const normalizedActiveArray = canonicalEntryArray(
    activeCensusEntries
      .sort((left, right) => left.logical_name.localeCompare(right.logical_name))
      .map((entry) => normalizedLogicalEntry(entry) as ActiveCapabilityCatalogEntry)
  );
  if (snapshots.length !== 18 || activeSnapshots.length !== 8 ||
      unreachable.length || multiplyReached.length || missingTargetCount || crossGroupLeakageCount ||
      privateBindingChecks !== 64 || exactEntryByteEqualCount !== 0 ||
      leaseScopeDigestOnlyDifferenceCount !== 64 || normalizedDefinitionMismatches.length ||
      normalizedReferenceArray.json !== normalizedActiveArray.json ||
      forbiddenKeyHits || privateSentinelHits) {
    throw new Error("active catalog census, logical-entry parity, or non-disclosure invariant failed");
  }

  const semanticBody = {
    schema_version: 1,
    benchmark_version: BENCHMARK_VERSION,
    evidence_class: "C1",
    claim_scope: "$0 deterministic production-serialization, compiler-containment, and frozen no-retry catalog-exposure evidence; not invocation success, arbitrary caller-path reachability, provider/model quality, latency, prompt/token savings, or long-conversation superiority.",
    corpus: {
      corpus_id: corpus.corpus_id,
      raw_source_file_bytes: corpusSource.bytes,
      raw_source_file_sha256: corpusSource.sha256,
      canonical_json_bytes: Buffer.byteLength(canonicalCorpus, "utf8"),
      canonical_json_sha256: canonicalCorpusSha256,
      group_count: corpus.groups.length,
      tool_count: tools.length,
      read_tool_count: tools.filter((tool) => tool.effect === "read").length,
      write_tool_count: tools.filter((tool) => tool.effect === "write").length,
      groups: corpus.groups.map((group) => ({
        id: group.id,
        tool_names: group.tools.map((tool) => tool.logical_name),
      })),
    },
    compiler_guards: {
      hierarchical_flow_accepted: true,
      flat_flow_rejected: true,
      flat_flow_rejection: flatFlowRejection,
      flat_64_source_catalog_rejected: true,
      flat_64_source_catalog_rejection: flatCatalogRejection,
    },
    raw_full_logical_entry_array_reference: {
      dispatchable_catalog: false,
      tool_count: referenceEntries.length,
      canonical_json_array_bytes: rawFullEntryArrayBytes,
      canonical_json_array_sha256: rawFullEntryArray.sha256,
      estimated_t4_at_4_bytes_per_token: rawFullEntryArrayT4,
      tool_names: referenceEntries.map((entry) => entry.logical_name),
    },
    logical_entry_parity: {
      compared_tools: referenceEntries.length,
      exact_entry_byte_equal_count: exactEntryByteEqualCount,
      lease_scope_digest_only_difference_count: leaseScopeDigestOnlyDifferenceCount,
      normalized_entry_byte_equal_count: referenceEntries.length - normalizedDefinitionMismatches.length,
      normalized_definition_mismatch_tools: normalizedDefinitionMismatches,
      normalized_definition_and_byte_shape_match: normalizedDefinitionMismatches.length === 0,
      normalized_reference_array_bytes: normalizedReferenceArray.bytes,
      normalized_reference_array_sha256: normalizedReferenceArray.sha256,
      normalized_active_census_array_bytes: normalizedActiveArray.bytes,
      normalized_active_census_array_sha256: normalizedActiveArray.sha256,
      normalized_array_byte_equal: normalizedReferenceArray.json === normalizedActiveArray.json,
      normalization: "replace only host_bound_action.invocation.lease_scope_digest with 64 ASCII zeroes",
    },
    progressive_state_census: {
      weighting: "unweighted frozen 18-state sequential no-retry flow census",
      snapshot_count: snapshots.length,
      active_phase_count: activeSnapshots.length,
      routing_snapshot_count: snapshots.filter((snapshot) => snapshot.label === "routing").length,
      transition_snapshot_count: snapshots.filter((snapshot) =>
        snapshot.label === "topic_selected" || snapshot.label.startsWith("transition:")
      ).length,
      terminal_snapshot_count: snapshots.filter((snapshot) => snapshot.label === "terminal").length,
      peak_total_logical_tool_count: Math.max(...snapshots.map((snapshot) => snapshot.total_logical_tool_count)),
      active_business_tool_count: summary(activeSnapshots.map((snapshot) => snapshot.active_business_tool_count)),
      active_total_logical_tool_count: summary(activeSnapshots.map((snapshot) => snapshot.total_logical_tool_count)),
      active_business_entry_array_bytes: summary(activeSnapshots.map((snapshot) =>
        snapshot.active_business_entry_array_bytes
      )),
      active_business_entry_array_t4: summary(activeSnapshots.map((snapshot) =>
        snapshot.active_business_entry_array_t4
      )),
      active_business_tool_count_reduction_ppm: summary(activeSnapshots.map((snapshot) =>
        snapshot.business_tool_count_reduction_ppm
      )),
      active_business_entry_array_reduction_ppm: summary(activeSnapshots.map((snapshot) =>
        snapshot.active_business_entry_array_reduction_ppm
      )),
      active_business_entry_array_t4_reduction_ppm: summary(activeSnapshots.map((snapshot) =>
        snapshot.active_business_entry_array_t4_reduction_ppm
      )),
      all_state_business_entry_array_reduction_ppm: summary(snapshots.map((snapshot) =>
        snapshot.active_business_entry_array_reduction_ppm
      )),
      active_full_catalog_json_bytes: summary(activeSnapshots.map((snapshot) => snapshot.full_catalog_json_bytes)),
      active_full_catalog_t4: summary(activeSnapshots.map((snapshot) => snapshot.full_catalog_t4)),
      full_catalog_json_bytes: summary(snapshots.map((snapshot) => snapshot.full_catalog_json_bytes)),
      full_catalog_t4: summary(snapshots.map((snapshot) => snapshot.full_catalog_t4)),
      active_provider_instruction_block_bytes: summary(activeSnapshots.map((snapshot) =>
        snapshot.provider_instruction_block_bytes
      )),
      active_provider_instruction_block_t4: summary(activeSnapshots.map((snapshot) =>
        snapshot.provider_instruction_block_t4
      )),
      active_provider_instruction_wrapper_bytes: summary(activeSnapshots.map((snapshot) =>
        snapshot.provider_instruction_wrapper_bytes
      )),
      provider_instruction_block_bytes: summary(snapshots.map((snapshot) =>
        snapshot.provider_instruction_block_bytes
      )),
      provider_instruction_block_t4: summary(snapshots.map((snapshot) =>
        snapshot.provider_instruction_block_t4
      )),
      snapshots,
    },
    catalog_exposure_and_non_disclosure: {
      target_tools_catalog_exposed_in_frozen_census: reached.size,
      target_tools_total: allNames.size,
      target_tools_catalog_exposed_once_in_frozen_no_retry_census: multiplyReached.length === 0,
      tools_not_catalog_exposed_in_frozen_census: unreachable,
      tools_catalog_exposed_more_or_less_than_once: multiplyReached,
      missing_target_count: missingTargetCount,
      cross_group_business_tool_leakage_count: crossGroupLeakageCount,
      private_binding_checks: privateBindingChecks,
      public_forbidden_private_key_hits: forbiddenKeyHits,
      public_private_sentinel_hits: privateSentinelHits,
      public_catalog_invariant_to_private_grant_expiry_and_source_order: true,
    },
    serializer_note: "Logical-entry arrays use canonical JSON; full catalogs and provider instruction blocks use the exact production JSON.stringify serializers exercised by activeCapabilityCatalogInstructions.",
    estimator_note: "T4 is ceil(UTF-8 bytes / 4), a rough cross-provider sizing estimate only; it is not provider-reported tokenizer usage, prompt savings, billed usage, or cumulative session cost.",
  } as const;
  const resultHash = sha256Hex(`${RESULT_HASH_DOMAIN}${canonicalJson(semanticBody)}`);
  const evidenceHash = sha256Hex(`${EVIDENCE_HASH_DOMAIN}${canonicalJson({
    result_hash: resultHash,
    source_manifest_sha256: provenance.source_manifest_sha256,
    build_manifest_sha256: provenance.build_manifest_sha256,
    toolchain_manifest_sha256: provenance.toolchain_manifest_sha256,
  })}`);
  const report = {
    ...semanticBody,
    provenance,
    result_hash: resultHash,
    evidence_hash: evidenceHash,
  } as const;
  const publicArtifact = canonicalJson(report);
  if (forbiddenPrivateKeys.some((key) => publicArtifact.includes(key)) ||
      [PRIVATE_GRANT_PREFIX, PRIVATE_GRANT_VARIANT_PREFIX, PRIVATE_EXPIRY, PRIVATE_EXPIRY_VARIANT]
        .some((sentinel) => publicArtifact.includes(sentinel))) {
    throw new Error("private source material leaked into the benchmark artifact");
  }
  return immutableJson(report) as unknown as typeof report;
}

export type ActiveCatalogEfficiencyReport = ReturnType<typeof runActiveCatalogEfficiencyBenchmark>;
