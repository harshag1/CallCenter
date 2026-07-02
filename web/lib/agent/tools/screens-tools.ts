// Author: Harsha Gundala
// screens-tools.ts — operator tool: create Notion-like screens from Surface DSL blocks.

import { qOne } from "../../db";
import { SurfaceSchema } from "../../surface-dsl";
import type { OperatorTool } from "../types";

export const createScreen: OperatorTool = {
  name: "create_screen",
  description:
    "Create a persistent screen (a saved page in the workspace) from Surface DSL blocks: stat_row, table, chart, tabs, markdown, form, actions, etc. Use for dashboards or pages the user wants to keep.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      icon: { type: "string", description: "lucide icon name, e.g. layout, bar-chart, users" },
      blocks: { type: "array", items: { type: "object" } },
    },
    required: ["title", "blocks"],
  },
  async execute(args, ctx) {
    const parsed = SurfaceSchema.safeParse({ title: String(args.title), blocks: args.blocks });
    if (!parsed.success) {
      return {
        output: {
          error: `invalid blocks: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        },
      };
    }
    const screen = await qOne<{ id: string }>(
      `INSERT INTO screens (org_id, title, icon, spec, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.orgId, parsed.data.title, String(args.icon ?? "layout"), JSON.stringify({ blocks: parsed.data.blocks }), `operator (${ctx.email})`]
    );
    return {
      output: { ok: true, screen_id: screen!.id },
      surface: parsed.data,
      notice: `Screen "${parsed.data.title}" created`,
    };
  },
};
