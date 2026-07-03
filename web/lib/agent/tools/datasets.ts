// Author: Harsha Gundala
// datasets.ts — operator tools: list/create datasets, query and write rows.

import { listDatasets, createDataset, queryRows, upsertRow } from "../../datasets";
import type { OperatorTool } from "../types";

export const listDatasetsTool: OperatorTool = {
  name: "list_datasets",
  description: "List the org's data tables (datasets) with columns and row counts.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    return { output: await listDatasets(ctx.orgId) };
  },
};

export const createDatasetTool: OperatorTool = {
  name: "create_dataset",
  description:
    "Create a new data table (dataset). ALWAYS use this — never manage_table — when the user asks for a table: datasets appear in their Tables page and are readable by voice bots. Columns can be plain names or {key,label,type:text|number|phone|date}.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      columns: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object" }] } },
    },
    required: ["name", "columns"],
  },
  async execute(args, ctx) {
    try {
      const dataset = await createDataset(ctx.orgId, String(args.name), args.columns as unknown[], `operator (${ctx.email})`);
      return { output: { ok: true, dataset }, notice: `Table "${dataset.slug}" created` };
    } catch (e) {
      return { output: { error: (e as Error).message } };
    }
  },
};

export const queryDataset: OperatorTool = {
  name: "query_dataset",
  description: "Read rows from a data table by slug. Filter is exact-match column equality, e.g. {\"phone\": \"+15551234567\"}.",
  parameters: {
    type: "object",
    properties: {
      table: { type: "string" },
      filter: { type: "object" },
      limit: { type: "number", default: 50 },
    },
    required: ["table"],
  },
  async execute(args, ctx) {
    const res = await queryRows(
      ctx.orgId, String(args.table),
      (args.filter as Record<string, unknown>) ?? undefined,
      Math.min(Number(args.limit) || 50, 200)
    );
    if (!res) return { output: { error: `unknown table "${args.table}" — use list_datasets` } };
    return { output: { table: res.dataset.slug, count: res.rows.length, rows: res.rows.map((r) => ({ id: r.id, ...r.data })) } };
  },
};

export const writeDataset: OperatorTool = {
  name: "write_dataset",
  description: "Insert or update a row in a data table. Provide match (column equality) to update instead of insert.",
  parameters: {
    type: "object",
    properties: {
      table: { type: "string" },
      row: { type: "object" },
      match: { type: "object" },
    },
    required: ["table", "row"],
  },
  async execute(args, ctx) {
    try {
      const res = await upsertRow(
        ctx.orgId, String(args.table),
        (args.row as Record<string, unknown>) ?? {},
        (args.match as Record<string, unknown>) ?? undefined
      );
      return { output: { ok: true, id: res.id, updated: res.updated } };
    } catch (e) {
      return { output: { error: (e as Error).message } };
    }
  },
};
