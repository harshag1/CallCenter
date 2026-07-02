// Author: Harsha Gundala
// index.ts — operator tool registry.

import type { OperatorTool } from "../types";
import type { ToolDef } from "../../xai";
import { queryData, manageTable, searchLogs } from "./data";
import { listCalls, getCall, getRecording } from "./calls";
import { listAgents, updateAgent } from "./agents";
import { createTool, testTool, listTools } from "./factory";
import { setEnvVar, listEnvVars, addMcpServer } from "./secrets";
import { scheduleCall, listScheduledCalls, cancelScheduledCall, placeCall, provisionPhoneNumber } from "./telephony";
import { renderSurface, showFlow } from "./ui";
import { webSearch } from "./research";
import { listDatasetsTool, createDatasetTool, queryDataset, writeDataset } from "./datasets";
import { createExperimentTool, stopExperimentTool, experimentResults } from "./experiments-tools";
import { createScreen } from "./screens-tools";
import { listFiles, parseCsv, importCsv, runJs, setHoldMusic } from "./files-tools";

export const OPERATOR_TOOLS: OperatorTool[] = [
  renderSurface, showFlow,
  queryData, manageTable, searchLogs,
  listCalls, getCall, getRecording,
  listAgents, updateAgent,
  createTool, testTool, listTools,
  setEnvVar, listEnvVars, addMcpServer,
  scheduleCall, listScheduledCalls, cancelScheduledCall, placeCall, provisionPhoneNumber,
  webSearch,
  listDatasetsTool, createDatasetTool, queryDataset, writeDataset,
  createExperimentTool, stopExperimentTool, experimentResults,
  createScreen,
  listFiles, parseCsv, importCsv, runJs, setHoldMusic,
];

export const byName = new Map(OPERATOR_TOOLS.map((t) => [t.name, t]));

export const toolDefs: ToolDef[] = OPERATOR_TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));
