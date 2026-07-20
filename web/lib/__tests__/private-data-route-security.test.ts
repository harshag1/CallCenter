import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
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
vi.mock("@/lib/db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("@/lib/datasets", () => ({
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
}));
vi.mock("@/lib/public-origin", async () => import("../public-origin"));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));

import { POST as editAgentFlowNode } from "../../app/api/agents/[id]/flow-node/route";
import { POST as createDataset } from "../../app/api/datasets/route";
import { PATCH as patchDataset } from "../../app/api/datasets/[id]/route";
import {
  DELETE as deleteDatasetRow,
  PATCH as patchDatasetRow,
  POST as createDatasetRow,
} from "../../app/api/datasets/[id]/rows/route";
import { PATCH as editNamedFlowNode } from "../../app/api/flows/[id]/route";
import { POST as createScreen } from "../../app/api/screens/route";
import { DELETE as deleteScreen, PATCH as patchScreen } from "../../app/api/screens/[id]/route";
import { POST as updateInternetSettings } from "../../app/api/settings/internet/route";

const APP_ORIGIN = "https://voice.example.test";
const RESOURCE_ID = "00000000-0000-4000-8000-000000000001";
const ROW_ID = "00000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({ id: RESOURCE_ID }) };

type MutationCase = Readonly<{
  label: string;
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body: Record<string, unknown>;
  invoke(request: Request): Promise<Response>;
}>;

const bodyMutations: readonly MutationCase[] = [
  {
    label: "agent flow-node POST",
    path: `/api/agents/${RESOURCE_ID}/flow-node`,
    method: "POST",
    body: { instructions: "Keep the caller on the verified path." },
    invoke: (request) => editAgentFlowNode(request, context),
  },
  {
    label: "dataset POST",
    path: "/api/datasets",
    method: "POST",
    body: { name: "Customers", columns: [] },
    invoke: (request) => createDataset(request),
  },
  {
    label: "dataset PATCH",
    path: `/api/datasets/${RESOURCE_ID}`,
    method: "PATCH",
    body: { drop_column: { key: "old_column" } },
    invoke: (request) => patchDataset(request, context),
  },
  {
    label: "dataset row POST",
    path: `/api/datasets/${RESOURCE_ID}/rows`,
    method: "POST",
    body: { data: { name: "Alice" } },
    invoke: (request) => createDatasetRow(request, context),
  },
  {
    label: "dataset row PATCH",
    path: `/api/datasets/${RESOURCE_ID}/rows`,
    method: "PATCH",
    body: { id: ROW_ID, data: { name: "Alice" } },
    invoke: (request) => patchDatasetRow(request, context),
  },
  {
    label: "dataset row DELETE",
    path: `/api/datasets/${RESOURCE_ID}/rows`,
    method: "DELETE",
    body: { id: ROW_ID },
    invoke: (request) => deleteDatasetRow(request, context),
  },
  {
    label: "named flow PATCH",
    path: `/api/flows/${RESOURCE_ID}`,
    method: "PATCH",
    body: { node: { id: "membership", label: "Membership", kind: "topic" } },
    invoke: (request) => editNamedFlowNode(request, context),
  },
  {
    label: "screen POST",
    path: "/api/screens",
    method: "POST",
    body: { title: "Call notes", spec: { blocks: [] } },
    invoke: (request) => createScreen(request),
  },
  {
    label: "screen PATCH",
    path: `/api/screens/${RESOURCE_ID}`,
    method: "PATCH",
    body: { title: "Updated call notes" },
    invoke: (request) => patchScreen(request, context),
  },
  {
    label: "internet settings POST",
    path: "/api/settings/internet",
    method: "POST",
    body: { enabled: true },
    invoke: (request) => updateInternetSettings(request),
  },
];

function requestFor(
  route: MutationCase,
  options: Readonly<{
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  }> = {},
): Request {
  return new Request(`${APP_ORIGIN}${route.path}`, {
    method: route.method,
    headers: {
      origin: APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify(options.body ?? route.body),
  });
}

function screenDeleteRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${APP_ORIGIN}/api/screens/${RESOURCE_ID}`, {
    method: "DELETE",
    headers: {
      origin: APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      ...headers,
    },
  });
}

function expectNoAuthenticationOrDataAccess(): void {
  expect(mocks.getSession).not.toHaveBeenCalled();
  expect(mocks.q).not.toHaveBeenCalled();
  expect(mocks.qOne).not.toHaveBeenCalled();
  expect(mocks.listDatasets).not.toHaveBeenCalled();
  expect(mocks.createDataset).not.toHaveBeenCalled();
  expect(mocks.getDatasetById).not.toHaveBeenCalled();
  expect(mocks.listRows).not.toHaveBeenCalled();
  expect(mocks.insertRow).not.toHaveBeenCalled();
  expect(mocks.updateRow).not.toHaveBeenCalled();
  expect(mocks.deleteRow).not.toHaveBeenCalled();
  expect(mocks.addColumn).not.toHaveBeenCalled();
  expect(mocks.renameColumn).not.toHaveBeenCalled();
  expect(mocks.dropColumn).not.toHaveBeenCalled();
}

describe("private data mutation route boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBLIC_ORIGIN", APP_ORIGIN);
    mocks.getSession.mockResolvedValue(null);
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each(bodyMutations)("rejects hostile browser metadata and text/plain before authority access: $label", async (route) => {
    const hostileRequests = [
      requestFor(route, { headers: { origin: "" } }),
      requestFor(route, { headers: { "sec-fetch-site": "same-site" } }),
      requestFor(route, { headers: { "content-type": "text/plain" } }),
    ];

    for (const [index, request] of hostileRequests.entries()) {
      const response = await route.invoke(request);
      expect(response.status).toBe(index === 2 ? 415 : 403);
      expectNoAuthenticationOrDataAccess();
    }
  });

  it.each(bodyMutations)("rejects an undeclared top-level key before authority access: $label", async (route) => {
    const response = await route.invoke(requestFor(route, {
      body: { ...route.body, undeclared_authority: true },
    }));

    expect(response.status).toBe(400);
    expectNoAuthenticationOrDataAccess();
  });

  it.each(bodyMutations)("admits the exact request shape to the authentication boundary: $label", async (route) => {
    const response = await route.invoke(requestFor(route));

    expect(response.status).toBe(401);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.getDatasetById).not.toHaveBeenCalled();
  });

  it("guards the bodyless screen DELETE before authentication or database access", async () => {
    const hostileHeaders: Record<string, string>[] = [
      { origin: "" },
      { "sec-fetch-site": "same-site" },
    ];
    for (const headers of hostileHeaders) {
      const response = await deleteScreen(screenDeleteRequest(headers), context);
      expect(response.status).toBe(403);
      expectNoAuthenticationOrDataAccess();
    }
  });

  it("allows a same-origin bodyless screen DELETE to reach authentication without requiring JSON", async () => {
    const response = await deleteScreen(screenDeleteRequest(), context);

    expect(response.status).toBe(401);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.q).not.toHaveBeenCalled();
  });
});
