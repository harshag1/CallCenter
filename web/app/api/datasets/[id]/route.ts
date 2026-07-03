// Author: Harsha Gundala
// datasets/[id] — single dataset read + column operations (add / rename / drop).

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { getDatasetById, addColumn, renameColumn, dropColumn } from "@/lib/datasets";

type Params = { params: Promise<{ id: string }> };

const PatchSchema = z
  .object({
    add_column: z.object({ key: z.string().max(64).optional(), label: z.string().min(1).max(64) }).optional(),
    rename_column: z.object({ key: z.string().min(1).max(64), label: z.string().min(1).max(64) }).optional(),
    drop_column: z.object({ key: z.string().min(1).max(64) }).optional(),
  })
  .refine((o) => o.add_column || o.rename_column || o.drop_column, { message: "no operation" });

export async function GET(_req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const dataset = await getDatasetById(session.orgId, id).catch(() => null);
  if (!dataset) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ dataset });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "column operation required" }, { status: 400 });
  const op = parsed.data;
  try {
    const dataset = op.add_column
      ? await addColumn(session.orgId, id, op.add_column.label, op.add_column.key)
      : op.rename_column
        ? await renameColumn(session.orgId, id, op.rename_column.key, op.rename_column.label)
        : await dropColumn(session.orgId, id, op.drop_column!.key);
    return NextResponse.json({ dataset });
  } catch (e) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg.includes("not found") ? 404 : 409 });
  }
}
