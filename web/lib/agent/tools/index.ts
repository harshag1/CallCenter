// Author: Harsha Gundala
// index.ts — context-authorized operator tool registry.

import Ajv, { type ValidateFunction } from "ajv";
import type { OperatorTool, ToolCtx } from "../types";
import type { ToolDef } from "../../xai";
import { queryData, searchLogs } from "./data";
import { listCalls, getCall, getRecording } from "./calls";
import { listAgents, updateAgent } from "./agents";
import { testTool, listTools } from "./factory";
import { setEnvVar, listEnvVars, addMcpServer } from "./secrets";
import { scheduleCall, listScheduledCalls, cancelScheduledCall, placeCall, provisionPhoneNumber } from "./telephony";
import { renderSurface, showFlow } from "./ui";
import { webSearch } from "./research";
import { listDatasetsTool, createDatasetTool, queryDataset, writeDataset } from "./datasets";
import { createExperimentTool, stopExperimentTool, experimentResults } from "./experiments-tools";
import { createScreen } from "./screens-tools";
import { listFiles, parseCsv, importCsv, runJs, setHoldMusic, externalJsSandboxConfigured } from "./files-tools";
import { sendEmailTool, sendSmsTool } from "./comms";
import { createFlowTool, updateFlowTool, openFlowTool, listFlowsTool, previewCampaignTool, runCampaignTool, listCampaignsTool, cancelCampaignTool, getRecallPolicy } from "./flows-tools";
import { OPERATOR_TOOL_EXTENSIONS } from "./extensions";
import { listIntegrations } from "./integrations";
import { testFlowScenario, validateFlowTool } from "./flow-testing";
import {
  discoverFundedOperatorCapabilities,
  type FundedOperatorCapability,
} from "./operator-capability-policy";
import { publicReleaseEgressEnabled } from "../../public-release-egress";

const ajv = new Ajv({ allErrors: true, strict: false });
const FUNDED_BY_TOOL: Readonly<Record<string, FundedOperatorCapability>> = Object.freeze({
  send_email: "send_email",
  send_sms: "send_sms",
  place_call: "place_call",
  schedule_call: "schedule_call",
  provision_phone_number: "provision_phone_number",
  run_campaign: "run_campaign",
});

type AnnotatedExtension = OperatorTool & Readonly<{
  security?: Readonly<{
    effect: "read" | "internal_write";
    tenant_scoped: true;
  }>;
}>;

/** Extensions without explicit non-external, tenant-scoped effect metadata are
 * not admitted. This keeps extensibility without treating source registration
 * as authority to spend or contact third parties. */
function admittedExtensions(): OperatorTool[] {
  return OPERATOR_TOOL_EXTENSIONS.filter((tool) => {
    const security = (tool as AnnotatedExtension).security;
    return security?.tenant_scoped === true
      && (security.effect === "read" || security.effect === "internal_write");
  });
}

const DECLARED_TOOLS: OperatorTool[] = [
  renderSurface, showFlow,
  queryData, searchLogs,
  listCalls, getCall, getRecording,
  listAgents, updateAgent,
  testTool, listTools,
  setEnvVar, listEnvVars, addMcpServer,
  scheduleCall, listScheduledCalls, cancelScheduledCall, placeCall, provisionPhoneNumber,
  webSearch,
  listDatasetsTool, createDatasetTool, queryDataset, writeDataset,
  createExperimentTool, stopExperimentTool, experimentResults,
  createScreen,
  listFiles, parseCsv, importCsv, runJs, setHoldMusic,
  sendEmailTool, sendSmsTool,
  createFlowTool, updateFlowTool, openFlowTool, listFlowsTool, previewCampaignTool, runCampaignTool, listCampaignsTool, cancelCampaignTool, getRecallPolicy,
  listIntegrations,
  validateFlowTool, testFlowScenario,
  ...admittedExtensions(),
];

const duplicateNames = DECLARED_TOOLS
  .map((tool) => tool.name)
  .filter((name, index, names) => names.indexOf(name) !== index);
if (duplicateNames.length) throw new Error(`duplicate operator tools: ${[...new Set(duplicateNames)].join(", ")}`);

const validators = new Map<string, ValidateFunction>();
const schemaValidTools: OperatorTool[] = [];
for (const tool of DECLARED_TOOLS) {
  try {
    validators.set(tool.name, ajv.compile(tool.parameters));
    schemaValidTools.push(tool);
  } catch {
    // Invalid extension/builtin schemas fail closed at registration.
  }
}

function executionWrapped(tool: OperatorTool): OperatorTool {
  return Object.freeze({
    ...tool,
    async execute(args, ctx) {
      const validate = validators.get(tool.name);
      if (!validate || !validate(args)) {
        return { output: { error: "tool arguments do not match the registered schema" } };
      }
      return tool.execute(args, ctx);
    },
  });
}

const WRAPPED_TOOLS = Object.freeze(schemaValidTools.map(executionWrapped));

function safeWithoutContext(tool: OperatorTool): boolean {
  return !(tool.name in FUNDED_BY_TOOL)
    && tool.name !== "run_js"
    && tool.name !== "web_search";
}

function asToolDef(tool: OperatorTool): ToolDef {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

export type OperatorToolCatalog = Readonly<{
  tools: readonly ToolDef[];
  byName: ReadonlyMap<string, OperatorTool>;
}>;

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #inner: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#inner = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#inner.size; }
  get(key: K): V | undefined { return this.#inner.get(key); }
  has(key: K): boolean { return this.#inner.has(key); }
  entries(): MapIterator<[K, V]> { return this.#inner.entries(); }
  keys(): MapIterator<K> { return this.#inner.keys(); }
  values(): MapIterator<V> { return this.#inner.values(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#inner[Symbol.iterator](); }
  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown
  ): void {
    this.#inner.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
}

/** One immutable snapshot controls both provider exposure and dispatch. Live
 * execution checks inside every funded tool may revoke authority, never widen
 * this snapshot after the model has seen it. */
export async function operatorToolCatalog(ctx: ToolCtx): Promise<OperatorToolCatalog> {
  const funded = await discoverFundedOperatorCapabilities(ctx);
  const available = WRAPPED_TOOLS.filter((tool) => {
    const capability = FUNDED_BY_TOOL[tool.name];
    if (capability) return funded.has(capability);
    if (tool.name === "run_js") {
      return publicReleaseEgressEnabled("operatorJsSandbox")
        && externalJsSandboxConfigured();
    }
    if (tool.name === "web_search") {
      return publicReleaseEgressEnabled("operatorWebSearch");
    }
    return true;
  });
  return Object.freeze({
    tools: Object.freeze(available.map(asToolDef)),
    byName: new ImmutableMap(available.map((tool) => [tool.name, tool] as const)),
  });
}

/** Compatibility exports are deliberately the least-authority public catalog:
 * no funded action and no in-process/externally unconfigured code execution. */
const DEFAULT_SAFE_TOOLS = Object.freeze(WRAPPED_TOOLS.filter(safeWithoutContext));
export const OPERATOR_TOOLS: readonly OperatorTool[] = DEFAULT_SAFE_TOOLS;
export const byName: ReadonlyMap<string, OperatorTool> = new ImmutableMap(
  DEFAULT_SAFE_TOOLS.map((tool) => [tool.name, tool] as const)
);
export const toolDefs: readonly ToolDef[] = Object.freeze(DEFAULT_SAFE_TOOLS.map(asToolDef));
