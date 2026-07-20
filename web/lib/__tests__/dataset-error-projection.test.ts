import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listDatasets: vi.fn(),
  createDataset: vi.fn(),
  getDatasetById: vi.fn(),
  listRows: vi.fn(),
  insertRow: vi.fn(),
  updateRow: vi.fn(),
  deleteRow: vi.fn(),
  addColumn: vi.fn(),
  renameColumn: vi.fn(),
  dropColumn: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/datasets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../datasets")>();
  return {
    ...actual,
    listDatasets: mocks.listDatasets,
    createDataset: mocks.createDataset,
    getDatasetById: mocks.getDatasetById,
    listRows: mocks.listRows,
    insertRow: mocks.insertRow,
    updateRow: mocks.updateRow,
    deleteRow: mocks.deleteRow,
    addColumn: mocks.addColumn,
    renameColumn: mocks.renameColumn,
    dropColumn: mocks.dropColumn,
  };
});
vi.mock("@/lib/public-origin", async () => import("../public-origin"));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));

import { POST as createDataset } from "../../app/api/datasets/route";
import { PATCH as patchDataset } from "../../app/api/datasets/[id]/route";
import { POST as createDatasetRow } from "../../app/api/datasets/[id]/rows/route";
import { DatasetError } from "../datasets";

const APP_ORIGIN = "https://voice.example.test";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const DATASET_ID = "00000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({ id: DATASET_ID }) };

function request(path: string, method: "POST" | "PATCH", body: Record<string, unknown>): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: {
      origin: APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("dataset API error projections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBLIC_ORIGIN", APP_ORIGIN);
    mocks.getSession.mockResolvedValue({
      email: "owner@example.test",
      orgId: ORG_ID,
    });
    mocks.getDatasetById.mockResolvedValue({
      id: DATASET_ID,
      slug: "customers",
      name: "Customers",
      icon: "table",
      columns: [],
      created_by: "owner@example.test",
      created_at: "2026-07-16T00:00:00.000Z",
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("preserves fixed domain-safe 404/409 responses", async () => {
    mocks.createDataset.mockRejectedValueOnce(new DatasetError("already_exists"));
    const duplicate = await createDataset(request("/api/datasets", "POST", {
      name: "Customers",
      columns: [],
    }));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "dataset already exists" });

    mocks.dropColumn.mockRejectedValueOnce(new DatasetError("not_found"));
    const missing = await patchDataset(request(`/api/datasets/${DATASET_ID}`, "PATCH", {
      drop_column: { key: "legacy" },
    }), context);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "dataset not found" });

    mocks.insertRow.mockRejectedValueOnce(new DatasetError("row_cap"));
    const full = await createDatasetRow(request(`/api/datasets/${DATASET_ID}/rows`, "POST", {
      data: { name: "Alice" },
    }), context);
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "row cap reached" });
  });

  it.each([
    {
      label: "create",
      reject: () => mocks.createDataset.mockRejectedValueOnce(new Error("PG duplicate detail: private-schema-value")),
      invoke: () => createDataset(request("/api/datasets", "POST", { name: "Customers", columns: [] })),
    },
    {
      label: "column mutation",
      reject: () => mocks.dropColumn.mockRejectedValueOnce(new Error("PG relation internal_dataset_42 missing")),
      invoke: () => patchDataset(request(`/api/datasets/${DATASET_ID}`, "PATCH", {
        drop_column: { key: "legacy" },
      }), context),
    },
    {
      label: "row insert",
      reject: () => mocks.insertRow.mockRejectedValueOnce(new Error("password authentication failed for private-role")),
      invoke: () => createDatasetRow(request(`/api/datasets/${DATASET_ID}/rows`, "POST", {
        data: { name: "Alice" },
      }), context),
    },
  ])("never reflects an unexpected internal error from $label", async ({ reject, invoke }) => {
    reject();
    const response = await invoke();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const text = await response.text();
    expect(text).toBe('{"error":"dataset operation failed"}');
    expect(text).not.toMatch(/PG|private|password|relation|schema|role/i);
  });
});
