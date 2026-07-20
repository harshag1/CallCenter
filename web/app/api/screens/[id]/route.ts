// Author: Harsha Gundala
// screens/[id] — read, patch (title/icon/spec/position), delete.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";

type Params = { params: Promise<{ id: string }> };
const MAX_PATCH_SCREEN_BODY_BYTES = 512 * 1024;

const PatchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  icon: z.string().max(40).optional(),
  spec: z.object({ blocks: z.array(z.record(z.string(), z.unknown())) }).strict().optional(),
  position: z.number().int().optional(),
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

export async function GET(_req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const screen = await qOne(
    `SELECT id, title, icon, kind, spec, experiment_id, position, created_by, created_at
     FROM screens WHERE id = $1 AND org_id = $2`,
    [id, session.orgId]
  ).catch(() => null);
  if (!screen) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ screen });
}

export async function PATCH(req: Request, { params }: Params) {
  let rawBody: Record<string, unknown>;
  try {
    assertSameOriginBrowserMutation(req);
    rawBody = await readPrivateJsonObject(req, MAX_PATCH_SCREEN_BODY_BYTES);
  } catch (error) {
    return privateRequestError(error);
  }
  const parsed = PatchSchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: "invalid patch" }, { status: 400 });

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const { title, icon, spec, position } = parsed.data;
  const screen = await qOne(
    `UPDATE screens SET
       title = COALESCE($3, title),
       icon = COALESCE($4, icon),
       spec = COALESCE($5, spec),
       position = COALESCE($6, position)
     WHERE id = $1 AND org_id = $2
     RETURNING id, title, icon, kind, spec, experiment_id, position, created_by, created_at`,
    [id, session.orgId, title ?? null, icon ?? null, spec ? JSON.stringify(spec) : null, position ?? null]
  ).catch(() => null);
  if (!screen) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ screen });
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    assertSameOriginBrowserMutation(req);
  } catch (error) {
    return privateRequestError(error);
  }

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const rows = await q("DELETE FROM screens WHERE id = $1 AND org_id = $2 RETURNING id", [id, session.orgId]).catch(() => []);
  return rows.length
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "not found" }, { status: 404 });
}
