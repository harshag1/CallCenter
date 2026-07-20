// Author: Harsha Gundala
// ui.ts — operator tools: render dynamic surfaces and drive the flow panel.

import { q } from "../../db";
import { containsCredentialForm, SurfaceSchema, FlowSchema } from "../../surface-dsl";
import type { OperatorTool } from "../types";

const DSL_DOC = `Blocks: stat_row{stats:[{label,value,delta?}]}, table{columns:[{key,label}],rows:[{...}],rowAction?:{prompt}}, chart{type:line|bar|area|donut,series:[{name,points:[{x,y}]}]}, tabs{tabs:[{label,blocks}]}, transcript{callId}, audio{src}, code{language,source}, form{fields:[{name,label,type,options?}],submit:{label?,prompt}}, markdown{body}, actions{actions:[{label,prompt}]}.
Action prompts are sent back to you verbatim when clicked — template row values with {{column_key}} in rowAction prompts.`;

export const renderSurface: OperatorTool = {
  name: "render_surface",
  description: `Render a UI in the main panel (the primary way you show anything: dashboards, tables, call detail, forms, charts). ${DSL_DOC}`,
  parameters: {
    type: "object",
    properties: {
      surface: {
        type: "object",
        description: "{title, blocks:[Block]}",
        properties: {
          title: { type: "string" },
          blocks: { type: "array", items: { type: "object" } },
        },
        required: ["title", "blocks"],
      },
      pin: { type: "boolean", description: "Persist this surface so it survives reloads." },
    },
    required: ["surface"],
  },
  async execute(args, ctx) {
    const parsed = SurfaceSchema.safeParse(args.surface);
    if (!parsed.success) {
      return { output: { error: `invalid surface: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` } };
    }
    if (containsCredentialForm(parsed.data)) {
      return {
        output: {
          error: "credential forms can only be issued by trusted credential tools and cannot be rendered generically",
        },
      };
    }
    if (args.pin) {
      await q(
        "INSERT INTO surfaces (org_id, title, spec, pinned) VALUES ($1,$2,$3,true)",
        [ctx.orgId, parsed.data.title, JSON.stringify(parsed.data)]
      );
    }
    return { output: { ok: true, rendered: parsed.data.title }, surface: parsed.data };
  },
};

export const showFlow: OperatorTool = {
  name: "show_flow",
  description:
    "Update the flow panel (top-right) with a call-flow graph — a bot's logic or the path a specific call took. {nodes:[{id,label,kind:start|state|tool|decision|end,active?}],edges:[{from,to,label?}]}",
  parameters: {
    type: "object",
    properties: { flow: { type: "object" } },
    required: ["flow"],
  },
  async execute(args) {
    const parsed = FlowSchema.safeParse(args.flow);
    if (!parsed.success) return { output: { error: `invalid flow: ${parsed.error.message.slice(0, 200)}` } };
    return { output: { ok: true }, flow: parsed.data };
  },
};
