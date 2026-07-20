// Author: Harsha Gundala
// datasets/[id] — single dataset read + column operations (add / rename / drop).

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import {
  getDatasetById,
  addColumn,
  renameColumn,
  dropColumn,
  publicDatasetError,
} from "@/lib/datasets";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";

type Params = { params: Promise<{ id: string }> };
const MAX_COLUMN_OPERATION_BODY_BYTES = 8 * 1024;

const PatchSchema = z
  .object({
    add_column: z.object({ key: z.string().max(64).optional(), label: z.string().min(1).max(64) }).strict().optional(),
    rename_column: z.object({ key: z.string().min(1).max(64), label: z.string().min(1).max(64) }).strict().optional(),
    drop_column: z.object({ key: z.string().min(1).max(64) }).strict().optional(),
  })
  .strict()
  .refine((o) => o.add_column || o.rename_column || o.drop_column, { message: "no operation" });

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

export async function GET(_req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const dataset = await getDatasetById(session.orgId, id).catch(() => null);
  if (!dataset) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ dataset });
}

export async function PATCH(req: Request, { params }: Params) {
  let rawBody: Record<string, unknown>;
  try {
    assertSameOriginBrowserMutation(req);
    rawBody = await readPrivateJsonObject(req, MAX_COLUMN_OPERATION_BODY_BYTES);
  } catch (error) {
    return privateRequestError(error);
  }
  const parsed = PatchSchema.safeParse(rawBody);
  if (!parsed.success) return privateJson({ error: "column operation required" }, 400);

  const session = await getSession();
  if (!session) return privateJson({ error: "unauthorized" }, 401);
  const { id } = await params;
  const op = parsed.data;
  try {
    const dataset = op.add_column
      ? await addColumn(session.orgId, id, op.add_column.label, op.add_column.key)
      : op.rename_column
        ? await renameColumn(session.orgId, id, op.rename_column.key, op.rename_column.label)
        : await dropColumn(session.orgId, id, op.drop_column!.key);
    return privateJson({ dataset });
  } catch (error) {
    const projected = publicDatasetError(error);
    return privateJson({ error: projected.message }, projected.status);
  }
}
