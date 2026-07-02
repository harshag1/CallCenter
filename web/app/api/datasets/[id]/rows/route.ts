// Author: Harsha Gundala
// datasets/[id]/rows — paginated reads and row CRUD for one dataset.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { getDatasetById, listRows, insertRow, updateRow, deleteRow } from "@/lib/datasets";

type Params = { params: Promise<{ id: string }> };

async function scoped(id: string) {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const dataset = await getDatasetById(session.orgId, id).catch(() => null);
  if (!dataset) return { error: NextResponse.json({ error: "not found" }, { status: 404 }) };
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
  const { id } = await params;
  const ctx = await scoped(id);
  if (ctx.error) return ctx.error;
  const body = z.object({ data: z.record(z.string(), z.unknown()) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "data object required" }, { status: 400 });
  try {
    return NextResponse.json({ row: await insertRow(ctx.session.orgId, ctx.dataset.id, body.data.data) }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const ctx = await scoped(id);
  if (ctx.error) return ctx.error;
  const body = z
    .object({ id: z.uuid(), data: z.record(z.string(), z.unknown()) })
    .safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "id and data required" }, { status: 400 });
  const row = await updateRow(ctx.session.orgId, ctx.dataset.id, body.data.id, body.data.data);
  if (!row) return NextResponse.json({ error: "row not found" }, { status: 404 });
  return NextResponse.json({ row });
}

export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  const ctx = await scoped(id);
  if (ctx.error) return ctx.error;
  const body = z.object({ id: z.uuid() }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "id required" }, { status: 400 });
  const ok = await deleteRow(ctx.session.orgId, ctx.dataset.id, body.data.id);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "row not found" }, { status: 404 });
}
