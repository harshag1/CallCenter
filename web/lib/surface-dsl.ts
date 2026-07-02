// Author: Harsha Gundala
// surface-dsl.ts — validated JSON DSL the operator agent emits to render UIs in the left column.

import { z } from "zod";

const Action = z.object({ label: z.string().optional(), prompt: z.string() });

const Stat = z.object({ label: z.string(), value: z.string(), delta: z.string().optional() });

const Column = z.object({ key: z.string(), label: z.string() });

const Series = z.object({
  name: z.string(),
  points: z.array(z.object({ x: z.union([z.string(), z.number()]), y: z.number() })),
});

const Field = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(["text", "number", "select", "textarea"]).default("text"),
  options: z.array(z.string()).optional(),
});

export type Block = {
  kind: string;
  [key: string]: unknown;
};

const BlockSchema: z.ZodType<Block> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("stat_row"), stats: z.array(Stat) }),
    z.object({
      kind: z.literal("table"),
      columns: z.array(Column),
      rows: z.array(z.record(z.string(), z.unknown())),
      rowAction: Action.optional(),
    }),
    z.object({
      kind: z.literal("chart"),
      type: z.enum(["line", "bar", "area", "donut"]),
      series: z.array(Series),
    }),
    z.object({
      kind: z.literal("tabs"),
      tabs: z.array(z.object({ label: z.string(), blocks: z.array(BlockSchema) })),
    }),
    z.object({ kind: z.literal("transcript"), callId: z.string() }),
    z.object({ kind: z.literal("audio"), src: z.string() }),
    z.object({ kind: z.literal("code"), language: z.string().default("typescript"), source: z.string() }),
    z.object({ kind: z.literal("form"), fields: z.array(Field), submit: Action }),
    z.object({ kind: z.literal("markdown"), body: z.string() }),
    z.object({ kind: z.literal("actions"), actions: z.array(Action) }),
  ]) as z.ZodType<Block>
);

export const SurfaceSchema = z.object({
  title: z.string(),
  blocks: z.array(BlockSchema),
});

export type Surface = z.infer<typeof SurfaceSchema>;

export const FlowSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(["start", "state", "tool", "decision", "end"]).default("state"),
      active: z.boolean().optional(),
    })
  ),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })),
});

export type Flow = z.infer<typeof FlowSchema>;
