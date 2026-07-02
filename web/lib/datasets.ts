// Author: Harsha Gundala
// datasets.ts — org-scoped structured tables (CRM-lite): defaults, CRUD, upsert-by-match, caps.

import { q, qOne } from "./db";

export const ROW_CAP = 5000;

export type DatasetColumn = { key: string; label: string; type: "text" | "number" | "phone" | "date" };

export type DatasetRow = { id: string; data: Record<string, unknown>; created_at: string; updated_at: string };

export type Dataset = {
  id: string;
  slug: string;
  name: string;
  icon: string;
  columns: DatasetColumn[];
  created_by: string;
  created_at: string;
};

export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
}

export function phoneDigits(value: string): string {
  return String(value ?? "").replace(/\D/g, "");
}

/** Accepts ["name","phone"] or [{key,label,type}] and returns normalized columns. */
export function normalizeColumns(input: unknown[]): DatasetColumn[] {
  const types = new Set(["text", "number", "phone", "date"]);
  return input
    .map((c) => {
      if (typeof c === "string") return { key: slugify(c), label: c, type: "text" as const };
      const o = c as Partial<DatasetColumn> & { name?: string };
      const key = slugify(String(o.key ?? o.name ?? o.label ?? ""));
      if (!key) return null;
      return {
        key,
        label: String(o.label ?? o.key ?? key),
        type: (types.has(String(o.type)) ? o.type : "text") as DatasetColumn["type"],
      };
    })
    .filter((c): c is DatasetColumn => !!c)
    .slice(0, 32);
}

const DEFAULTS: { slug: string; name: string; icon: string; columns: DatasetColumn[] }[] = [
  {
    slug: "customers",
    name: "Customers",
    icon: "users",
    columns: [
      { key: "name", label: "Name", type: "text" },
      { key: "phone", label: "Phone", type: "phone" },
      { key: "email", label: "Email", type: "text" },
      { key: "notes", label: "Notes", type: "text" },
    ],
  },
  {
    slug: "feedback",
    name: "Feedback",
    icon: "message-square",
    columns: [
      { key: "phone", label: "Phone", type: "phone" },
      { key: "rating", label: "Rating", type: "number" },
      { key: "comment", label: "Comment", type: "text" },
    ],
  },
];

/** Seeds the customers + feedback datasets once per org (idempotent). */
export async function ensureDefaults(orgId: string): Promise<void> {
  for (const d of DEFAULTS) {
    await q(
      `INSERT INTO datasets (org_id, slug, name, icon, columns, created_by)
       VALUES ($1,$2,$3,$4,$5,'system') ON CONFLICT (org_id, slug) DO NOTHING`,
      [orgId, d.slug, d.name, d.icon, JSON.stringify(d.columns)]
    );
  }
}

export async function listDatasets(orgId: string): Promise<(Dataset & { row_count: number })[]> {
  return q<Dataset & { row_count: number }>(
    `SELECT d.id, d.slug, d.name, d.icon, d.columns, d.created_by, d.created_at,
            (SELECT count(*) FROM dataset_rows r WHERE r.dataset_id = d.id)::int AS row_count
     FROM datasets d WHERE d.org_id = $1 ORDER BY d.created_at`,
    [orgId]
  );
}

export async function createDataset(
  orgId: string,
  name: string,
  columns: unknown[],
  createdBy = "operator"
): Promise<Dataset> {
  const slug = slugify(name);
  if (!slug) throw new Error("dataset name required");
  const cols = normalizeColumns(columns);
  if (!cols.length) throw new Error("at least one column required");
  const row = await qOne<Dataset>(
    `INSERT INTO datasets (org_id, slug, name, icon, columns, created_by)
     VALUES ($1,$2,$3,'table',$4,$5)
     ON CONFLICT (org_id, slug) DO NOTHING
     RETURNING id, slug, name, icon, columns, created_by, created_at`,
    [orgId, slug, name, JSON.stringify(cols), createdBy]
  );
  if (!row) throw new Error(`dataset "${slug}" already exists`);
  return row;
}

export async function getDatasetById(orgId: string, id: string): Promise<Dataset | null> {
  return qOne<Dataset>(
    "SELECT id, slug, name, icon, columns, created_by, created_at FROM datasets WHERE org_id = $1 AND id = $2",
    [orgId, id]
  );
}

export async function getDatasetBySlug(orgId: string, slug: string): Promise<Dataset | null> {
  return qOne<Dataset>(
    "SELECT id, slug, name, icon, columns, created_by, created_at FROM datasets WHERE org_id = $1 AND slug = $2",
    [orgId, slugify(slug)]
  );
}

export async function listRows(orgId: string, datasetId: string, limit = 100, offset = 0): Promise<DatasetRow[]> {
  return q<DatasetRow>(
    `SELECT id, data, created_at, updated_at FROM dataset_rows
     WHERE org_id = $1 AND dataset_id = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [orgId, datasetId, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0)]
  );
}

/** Equality-filtered read by slug (voice/operator path). Filter is jsonb containment. */
export async function queryRows(
  orgId: string,
  slug: string,
  filter?: Record<string, unknown>,
  limit = 50
): Promise<{ dataset: Dataset; rows: DatasetRow[] } | null> {
  const dataset = await getDatasetBySlug(orgId, slug);
  if (!dataset) return null;
  const rows = await q<DatasetRow>(
    `SELECT id, data, created_at, updated_at FROM dataset_rows
     WHERE dataset_id = $1 AND ($2::jsonb IS NULL OR data @> $2::jsonb)
     ORDER BY created_at DESC LIMIT $3`,
    [dataset.id, filter && Object.keys(filter).length ? JSON.stringify(filter) : null, Math.min(Math.max(limit, 1), 200)]
  );
  return { dataset, rows };
}

async function assertCap(datasetId: string): Promise<void> {
  const c = await qOne<{ n: number }>("SELECT count(*)::int AS n FROM dataset_rows WHERE dataset_id = $1", [datasetId]);
  if ((c?.n ?? 0) >= ROW_CAP) throw new Error(`row cap of ${ROW_CAP} reached`);
}

export async function insertRow(orgId: string, datasetId: string, data: Record<string, unknown>): Promise<DatasetRow> {
  await assertCap(datasetId);
  const row = await qOne<DatasetRow>(
    `INSERT INTO dataset_rows (dataset_id, org_id, data)
     SELECT d.id, d.org_id, $3 FROM datasets d WHERE d.id = $1 AND d.org_id = $2
     RETURNING id, data, created_at, updated_at`,
    [datasetId, orgId, JSON.stringify(data)]
  );
  if (!row) throw new Error("dataset not found");
  return row;
}

/** Multi-row insert for imports; respects ROW_CAP, batches of 200. Returns inserted count. */
export async function insertRows(orgId: string, datasetId: string, rows: Record<string, unknown>[]): Promise<number> {
  const c = await qOne<{ n: number }>("SELECT count(*)::int AS n FROM dataset_rows WHERE dataset_id = $1", [datasetId]);
  const room = ROW_CAP - (c?.n ?? 0);
  const batch = rows.slice(0, Math.max(room, 0));
  for (let i = 0; i < batch.length; i += 200) {
    const slice = batch.slice(i, i + 200);
    const values = slice.map((_, j) => `($1,$2,$${j + 3})`).join(",");
    await q(`INSERT INTO dataset_rows (dataset_id, org_id, data) VALUES ${values}`, [
      datasetId, orgId, ...slice.map((r) => JSON.stringify(r)),
    ]);
  }
  return batch.length;
}

export async function updateRow(
  orgId: string,
  datasetId: string,
  rowId: string,
  patch: Record<string, unknown>
): Promise<DatasetRow | null> {
  return qOne<DatasetRow>(
    `UPDATE dataset_rows SET data = data || $4::jsonb, updated_at = now()
     WHERE id = $3 AND dataset_id = $2 AND org_id = $1
     RETURNING id, data, created_at, updated_at`,
    [orgId, datasetId, rowId, JSON.stringify(patch)]
  );
}

export async function deleteRow(orgId: string, datasetId: string, rowId: string): Promise<boolean> {
  const r = await qOne<{ id: string }>(
    "DELETE FROM dataset_rows WHERE id = $3 AND dataset_id = $2 AND org_id = $1 RETURNING id",
    [orgId, datasetId, rowId]
  );
  return !!r;
}

/** Upsert by slug: with match, merge into the oldest matching row; else insert (match keys folded in). */
export async function upsertRow(
  orgId: string,
  slug: string,
  data: Record<string, unknown>,
  match?: Record<string, unknown>
): Promise<{ id: string; data: Record<string, unknown>; updated: boolean }> {
  const dataset = await getDatasetBySlug(orgId, slug);
  if (!dataset) throw new Error(`unknown table "${slug}"`);
  if (match && Object.keys(match).length) {
    const updated = await qOne<{ id: string; data: Record<string, unknown> }>(
      `UPDATE dataset_rows SET data = data || $3::jsonb, updated_at = now()
       WHERE id = (SELECT id FROM dataset_rows WHERE dataset_id = $1 AND data @> $2::jsonb ORDER BY created_at LIMIT 1)
       RETURNING id, data`,
      [dataset.id, JSON.stringify(match), JSON.stringify(data)]
    );
    if (updated) return { ...updated, updated: true };
  }
  const row = await insertRow(orgId, dataset.id, { ...(match ?? {}), ...data });
  return { id: row.id, data: row.data, updated: false };
}

/** Loose phone lookup in the customers dataset (last-10-digit match). */
export async function findCustomerByPhone(orgId: string, phone: string): Promise<Record<string, unknown> | null> {
  const digits = phoneDigits(phone);
  if (digits.length < 7) return null;
  const row = await qOne<{ data: Record<string, unknown> }>(
    `SELECT r.data FROM dataset_rows r JOIN datasets d ON d.id = r.dataset_id
     WHERE d.org_id = $1 AND d.slug = 'customers'
       AND RIGHT(regexp_replace(COALESCE(r.data->>'phone',''), '\\D', '', 'g'), 10) = RIGHT($2, 10)
     ORDER BY r.updated_at DESC LIMIT 1`,
    [orgId, digits]
  );
  return row?.data ?? null;
}
