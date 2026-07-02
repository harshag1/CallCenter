// Author: Harsha Gundala
// files-tools.ts — operator tools: file listing, CSV parse/import, sandboxed JS over files, hold music.

import vm from "node:vm";
import Papa from "papaparse";
import { waitUntil } from "@vercel/functions";
import { q, qOne } from "../../db";
import { getDatasetBySlug, createDataset, insertRows, slugify } from "../../datasets";
import { transcodeHoldMusic, extOf } from "../../files";
import type { OperatorTool } from "../types";

const IMPORT_CAP = 2000;
const RESULT_CAP = 20_000;

type DocRow = { id: string; filename: string; kind: string; data: Buffer | null };

async function loadDoc(orgId: string, documentId: string): Promise<DocRow | null> {
  return qOne<DocRow>(
    "SELECT id, filename, kind, data FROM documents WHERE id = $1 AND org_id = $2",
    [documentId, orgId]
  ).catch(() => null);
}

function parseCsvDoc(doc: DocRow): { headers: string[]; rows: Record<string, string>[] } {
  if (!doc.data?.length) throw new Error("document has no stored bytes (re-upload as a data file)");
  const parsed = Papa.parse<Record<string, string>>(doc.data.toString("utf8"), {
    header: true,
    skipEmptyLines: true,
  });
  const headers = parsed.meta.fields ?? [];
  if (!headers.length) throw new Error("no CSV headers found");
  return { headers, rows: parsed.data };
}

export const listFiles: OperatorTool = {
  name: "list_files",
  description: "List uploaded files (knowledge docs, media/audio, csv/json data) with kind, status, and hold-music flag.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    const rows = await q(
      `SELECT id, filename, mime, kind, size_bytes, status,
              (meta->>'hold_music' = 'true') AS hold_music, created_at
       FROM documents WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [ctx.orgId]
    );
    return { output: rows };
  },
};

export const parseCsv: OperatorTool = {
  name: "parse_csv",
  description: "Parse an uploaded CSV document and return its headers plus preview rows.",
  parameters: {
    type: "object",
    properties: {
      document_id: { type: "string" },
      preview_rows: { type: "number", default: 10 },
    },
    required: ["document_id"],
  },
  async execute(args, ctx) {
    const doc = await loadDoc(ctx.orgId, String(args.document_id));
    if (!doc) return { output: { error: "document not found" } };
    try {
      const { headers, rows } = parseCsvDoc(doc);
      const n = Math.min(Math.max(Number(args.preview_rows) || 10, 1), 50);
      return { output: { filename: doc.filename, headers, row_count: rows.length, preview: rows.slice(0, n) } };
    } catch (e) {
      return { output: { error: (e as Error).message } };
    }
  },
};

export const importCsv: OperatorTool = {
  name: "import_csv",
  description:
    `Import an uploaded CSV into a data table (created from the CSV headers if missing). Optional column_map renames {"csv header": "dataset_column_key"}. Caps at ${IMPORT_CAP} rows per import.`,
  parameters: {
    type: "object",
    properties: {
      document_id: { type: "string" },
      table: { type: "string" },
      column_map: { type: "object" },
    },
    required: ["document_id", "table"],
  },
  async execute(args, ctx) {
    const doc = await loadDoc(ctx.orgId, String(args.document_id));
    if (!doc) return { output: { error: "document not found" } };
    try {
      const { headers, rows } = parseCsvDoc(doc);
      const map = (args.column_map as Record<string, string>) ?? {};
      const keyFor = (h: string) => slugify(map[h] ?? h);

      let dataset = await getDatasetBySlug(ctx.orgId, String(args.table));
      dataset ??= await createDataset(ctx.orgId, String(args.table), headers.map((h) => keyFor(h)), `operator (${ctx.email})`);

      const mapped = rows.slice(0, IMPORT_CAP).map((r) => {
        const out: Record<string, unknown> = {};
        for (const h of headers) out[keyFor(h)] = r[h] ?? null;
        return out;
      });
      const inserted = await insertRows(ctx.orgId, dataset.id, mapped);
      return {
        output: { ok: true, table: dataset.slug, inserted, skipped: rows.length - inserted },
        notice: `${inserted} rows imported into "${dataset.slug}"`,
      };
    } catch (e) {
      return { output: { error: (e as Error).message } };
    }
  },
};

export const runJs: OperatorTool = {
  name: "run_js",
  description:
    "Run a JavaScript snippet in a 5s sandbox for ad-hoc transforms/analysis. If document_id is given, the file is available as `input` (utf8 string for text/data files, Buffer for media). The final expression's value is returned; console.log output is captured.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string" },
      document_id: { type: "string" },
    },
    required: ["code"],
  },
  async execute(args, ctx) {
    let input: unknown = null;
    if (args.document_id) {
      const doc = await loadDoc(ctx.orgId, String(args.document_id));
      if (!doc) return { output: { error: "document not found" } };
      if (!doc.data?.length) return { output: { error: "document has no stored bytes" } };
      input = doc.kind === "media" ? doc.data : doc.data.toString("utf8");
    }
    const logs: string[] = [];
    const capture = (...a: unknown[]) =>
      logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ").slice(0, 500));
    try {
      let result = vm.runInNewContext(
        String(args.code),
        { input, console: { log: capture, warn: capture, error: capture } },
        { timeout: 5000 }
      );
      if (result && typeof (result as Promise<unknown>).then === "function") {
        result = await Promise.race([
          result,
          new Promise((_, rej) => setTimeout(() => rej(new Error("async result timed out (5s)")), 5000)),
        ]);
      }
      const serialized = JSON.stringify(result ?? null) ?? "null";
      return {
        output: {
          result: serialized.length > RESULT_CAP ? `${serialized.slice(0, RESULT_CAP)}… (truncated)` : JSON.parse(serialized),
          logs: logs.slice(0, 50),
        },
      };
    } catch (e) {
      return { output: { error: (e as Error).message, logs: logs.slice(0, 50) } };
    }
  },
};

export const setHoldMusic: OperatorTool = {
  name: "set_hold_music",
  description: "Set an uploaded audio file (mp3) as the org's hold music — transcodes it for telephony in the background.",
  parameters: { type: "object", properties: { document_id: { type: "string" } }, required: ["document_id"] },
  async execute(args, ctx) {
    const doc = await loadDoc(ctx.orgId, String(args.document_id));
    if (!doc) return { output: { error: "document not found" } };
    if (doc.kind !== "media") return { output: { error: "not an audio file — upload an mp3 first" } };
    await q("UPDATE documents SET meta = meta - 'hold_music' WHERE org_id = $1 AND meta ? 'hold_music'", [ctx.orgId]);
    await q(`UPDATE documents SET meta = jsonb_set(meta, '{hold_music}', 'true') WHERE id = $1 AND org_id = $2`, [doc.id, ctx.orgId]);
    waitUntil(transcodeHoldMusic(doc.id));
    const note = extOf(doc.filename) === "mp3" ? "" : " (note: only mp3 transcodes for phone lines today)";
    return { output: { ok: true, document_id: doc.id, transcoding: true }, notice: `Hold music set to ${doc.filename}${note}` };
  },
};
