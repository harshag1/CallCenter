// Author: Harsha Gundala
// files-tools.ts — operator tools: file listing, CSV parse/import, sandboxed JS over files, hold music.

import Papa from "papaparse";
import { waitUntil } from "@vercel/functions";
import { q, qOne } from "../../db";
import { getDatasetBySlug, createDataset, insertRows, slugify } from "../../datasets";
import { transcodeHoldMusic, extOf } from "../../files";
import { publicReleaseEgressEnabled } from "../../public-release-egress";
import type { OperatorTool } from "../types";

const IMPORT_CAP = 2000;
const RESULT_CAP = 20_000;
const JS_CODE_CAP = 20_000;
const JS_INPUT_CAP = 1024 * 1024;
const JS_RESPONSE_CAP = 256 * 1024;

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

function externalJsSandboxConfig(): Readonly<{ url: string; token: string }> | null {
  const rawUrl = process.env.OPERATOR_JS_SANDBOX_URL;
  const token = process.env.OPERATOR_JS_SANDBOX_TOKEN;
  if (!rawUrl || !token || token.length < 32 || token.length > 4096
      || /[\u0000-\u001f\u007f]/.test(token)) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return Object.freeze({ url: url.toString(), token });
  } catch {
    return null;
  }
}

export function externalJsSandboxConfigured(): boolean {
  return publicReleaseEgressEnabled("operatorJsSandbox")
    && externalJsSandboxConfig() !== null;
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > JS_RESPONSE_CAP) {
    throw new Error("sandbox response exceeds limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > JS_RESPONSE_CAP) {
      await reader.cancel().catch(() => {});
      throw new Error("sandbox response exceeds limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export const runJs: OperatorTool = {
  name: "run_js",
  description:
    "Run JavaScript only through a separately configured external isolation service. This capability is absent when no external sandbox is configured; application-process execution is never used.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      code: { type: "string" },
      document_id: { type: "string" },
    },
    required: ["code"],
  },
  async execute(args, ctx) {
    if (!publicReleaseEgressEnabled("operatorJsSandbox")) {
      return { output: { error: "external JavaScript sandbox egress is disabled" } };
    }
    const config = externalJsSandboxConfig();
    if (!config) return { output: { error: "external JavaScript sandbox is not configured" } };
    const code = typeof args.code === "string" ? args.code : "";
    if (!code.trim() || code.length > JS_CODE_CAP) {
      return { output: { error: `code must contain 1-${JS_CODE_CAP} characters` } };
    }
    let input: Readonly<{ encoding: "utf8" | "base64"; data: string }> | null = null;
    if (args.document_id) {
      const doc = await loadDoc(ctx.orgId, String(args.document_id));
      if (!doc) return { output: { error: "document not found" } };
      if (!doc.data?.length) return { output: { error: "document has no stored bytes" } };
      if (doc.data.byteLength > JS_INPUT_CAP) return { output: { error: "document exceeds the 1 MiB sandbox input limit" } };
      input = doc.kind === "media"
        ? Object.freeze({ encoding: "base64", data: doc.data.toString("base64") })
        : Object.freeze({ encoding: "utf8", data: doc.data.toString("utf8") });
    }
    try {
      const response = await fetch(config.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(6_000),
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ schema_version: 1, code, input, timeout_ms: 5_000 }),
      });
      const text = await boundedResponseText(response);
      if (!response.ok) return { output: { error: `external sandbox rejected the job (${response.status})` } };
      const payload = JSON.parse(text) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid sandbox response");
      const record = payload as Record<string, unknown>;
      if (record.ok !== true || !("result" in record) || !Array.isArray(record.logs)) {
        throw new Error("invalid sandbox response");
      }
      const serialized = JSON.stringify(record.result ?? null) ?? "null";
      const logs = record.logs
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 50)
        .map((entry) => entry.slice(0, 500));
      return {
        output: {
          result: serialized.length > RESULT_CAP ? `${serialized.slice(0, RESULT_CAP)}… (truncated)` : JSON.parse(serialized),
          logs,
        },
      };
    } catch {
      return { output: { error: "external sandbox failed or returned an invalid response" } };
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
