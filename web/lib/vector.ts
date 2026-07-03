// Author: Harsha Gundala
// vector.ts — TurboPuffer vector store client (fetch-based, v2 HTTP API; no SDK).

const DEFAULT_REGION = "gcp-us-central1";

export type TpufRow = { id: string; vector: number[]; attributes: Record<string, unknown> };
export type TpufHit = { id: string; score: number; attributes: Record<string, unknown> };

export function tpufEnabled(): boolean {
  return !!process.env.TURBOPUFFER_API_KEY;
}

function baseUrl(): string {
  // TURBOPUFFER_BASE_URL overrides the region host (integration tests point it at a local stub).
  if (process.env.TURBOPUFFER_BASE_URL) return `${process.env.TURBOPUFFER_BASE_URL}/v2/namespaces`;
  const region = process.env.TURBOPUFFER_REGION || DEFAULT_REGION;
  return `https://${region}.turbopuffer.com/v2/namespaces`;
}

async function tpuf(method: string, path: string, body?: unknown): Promise<Response> {
  const key = process.env.TURBOPUFFER_API_KEY;
  if (!key) throw new Error("TURBOPUFFER_API_KEY not set");
  return fetch(`${baseUrl()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function fail(op: string, res: Response): Promise<never> {
  throw new Error(`turbopuffer ${op} ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Upsert rows into a namespace. Namespace is created on first write (cosine space). */
export async function tpufUpsert(namespace: string, rows: TpufRow[]): Promise<void> {
  if (!rows.length) return;
  const res = await tpuf("POST", `/${encodeURIComponent(namespace)}`, {
    upsert_rows: rows.map((r) => ({ id: r.id, vector: r.vector, ...r.attributes })),
    distance_metric: "cosine_distance",
  });
  if (!res.ok) await fail("upsert", res);
}

/** ANN query; score is cosine similarity (1 − $dist) to match the pgvector path's convention. */
export async function tpufQuery(namespace: string, vector: number[], topK: number): Promise<TpufHit[]> {
  const res = await tpuf("POST", `/${encodeURIComponent(namespace)}/query`, {
    rank_by: ["vector", "ANN", vector],
    limit: topK,
    include_attributes: true,
  });
  if (res.status === 404) return []; // namespace not yet created — no documents ingested
  if (!res.ok) await fail("query", res);
  const json = (await res.json()) as { rows?: Record<string, unknown>[] };
  return (json.rows ?? []).map((row) => {
    const { id, $dist, vector: _v, ...attributes } = row as { id: string; $dist: number; vector?: unknown };
    return { id: String(id), score: 1 - Number($dist ?? 1), attributes };
  });
}

/** Drop a namespace and all its vectors (called when an org's knowledge is purged). */
export async function tpufDeleteNamespace(namespace: string): Promise<void> {
  const res = await tpuf("DELETE", `/${encodeURIComponent(namespace)}`);
  if (!res.ok && res.status !== 404) await fail("delete namespace", res);
}
