// Author: Harsha Gundala
// datasets/[id]/rows — paginated reads and row CRUD for one dataset.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import {
  getDatasetById,
  listRows,
  insertRow,
  updateRow,
  deleteRow,
  publicDatasetError,
} from "@/lib/datasets";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";

type Params = { params: Promise<{ id: string }> };
const MAX_ROW_MUTATION_BODY_BYTES = 256 * 1024;

const InsertRowSchema = z.object({
  data: z.record(z.string(), z.unknown()),
}).strict();

const UpdateRowSchema = z.object({
  id: z.uuid(),
  data: z.record(z.string(), z.unknown()),
}).strict();

const DeleteRowSchema = z.object({
  id: z.uuid(),
}).strict();

function privateRequestError(error: unknown): NextResponse {
  const status = error instanceof PrivateRequestError ? error.status : 400;
  const message = status === 403
    ? "forbidden"
    : status === 413
      ? "payload too large"
      : status === 415
        ? "unsupported media type"
        : "invalid request";
  return NextResponse.json({ error: message }, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

function privateJson(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

async function privateBody(req: Request): Promise<Record<string, unknown> | NextResponse> {
  try {
    assertSameOriginBrowserMutation(req);
    return await readPrivateJsonObject(req, MAX_ROW_MUTATION_BODY_BYTES);
  } catch (error) {
    return privateRequestError(error);
  }
}

async function scoped(id: string, privateResponse = false) {
  const session = await getSession();
  if (!session) {
    return {
      error: privateResponse
        ? privateJson({ error: "unauthorized" }, 401)
        : NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  const dataset = await getDatasetById(session.orgId, id).catch(() => null);
  if (!dataset) {
    return {
      error: privateResponse
        ? privateJson({ error: "not found" }, 404)
        : NextResponse.json({ error: "not found" }, { status: 404 }),
    };
  }
  return { session, dataset };
}

export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const ctx = await scoped(id);
  if (ctx.error) return ctx.error;
  const url = new URL(req.url);
  const rows = await listRows(
    ctx.session.orgId, ctx.dataset.id,
    Number(url.searchParams.get("limit")) || 100,
    Number(url.searchParams.get("offset")) || 0
  );
  return NextResponse.json({ dataset: ctx.dataset, rows });
}

export async function POST(req: Request, { params }: Params) {
  const rawBody = await privateBody(req);
  if (rawBody instanceof NextResponse) return rawBody;
  const body = InsertRowSchema.safeParse(rawBody);
  if (!body.success) return privateJson({ error: "data object required" }, 400);

  const { id } = await params;
  const ctx = await scoped(id, true);
  if (ctx.error) return ctx.error;
  try {
    return privateJson({ row: await insertRow(ctx.session.orgId, ctx.dataset.id, body.data.data) }, 201);
  } catch (error) {
    const projected = publicDatasetError(error);
    return privateJson({ error: projected.message }, projected.status);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  const rawBody = await privateBody(req);
  if (rawBody instanceof NextResponse) return rawBody;
  const body = UpdateRowSchema.safeParse(rawBody);
  if (!body.success) return privateJson({ error: "id and data required" }, 400);

  const { id } = await params;
  const ctx = await scoped(id, true);
  if (ctx.error) return ctx.error;
  const row = await updateRow(ctx.session.orgId, ctx.dataset.id, body.data.id, body.data.data);
  if (!row) return privateJson({ error: "row not found" }, 404);
  return privateJson({ row });
}

export async function DELETE(req: Request, { params }: Params) {
  const rawBody = await privateBody(req);
  if (rawBody instanceof NextResponse) return rawBody;
  const body = DeleteRowSchema.safeParse(rawBody);
  if (!body.success) return privateJson({ error: "id required" }, 400);

  const { id } = await params;
  const ctx = await scoped(id, true);
  if (ctx.error) return ctx.error;
  const ok = await deleteRow(ctx.session.orgId, ctx.dataset.id, body.data.id);
  return ok ? privateJson({ ok: true }) : privateJson({ error: "row not found" }, 404);
}
