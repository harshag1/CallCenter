// Author: Harsha Gundala
// screens — Notion-like pages: list and create.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { q, qOne } from "@/lib/db";

const CreateSchema = z.object({
  title: z.string().min(1).max(120),
  icon: z.string().max(40).optional(),
  spec: z.object({ blocks: z.array(z.record(z.string(), z.unknown())) }).optional(),
});

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const screens = await q(
    `SELECT id, title, icon, kind, spec, experiment_id, position, created_by, created_at
     FROM screens WHERE org_id = $1 ORDER BY position, created_at`,
    [session.orgId]
  );
  return NextResponse.json({ screens });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "title required" }, { status: 400 });
  const screen = await qOne(
    `INSERT INTO screens (org_id, title, icon, spec, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, title, icon, kind, spec, experiment_id, position, created_by, created_at`,
    [
      session.orgId, parsed.data.title, parsed.data.icon ?? "layout",
      JSON.stringify(parsed.data.spec ?? { blocks: [] }), session.email,
    ]
  );
  return NextResponse.json({ screen }, { status: 201 });
}
