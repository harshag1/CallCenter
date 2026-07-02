// Author: Harsha Gundala
// screens/[id] — read, patch (title/icon/spec/position), delete.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  icon: z.string().max(40).optional(),
  spec: z.object({ blocks: z.array(z.record(z.string(), z.unknown())) }).optional(),
  position: z.number().int().optional(),
});

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
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid patch" }, { status: 400 });
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

export async function DELETE(_req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const rows = await q("DELETE FROM screens WHERE id = $1 AND org_id = $2 RETURNING id", [id, session.orgId]).catch(() => []);
  return rows.length
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "not found" }, { status: 404 });
}
