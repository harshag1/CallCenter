// Author: Harsha Gundala
// datasets — list (with row counts) and create; tables exist only when the user makes them.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { listDatasets, createDataset } from "@/lib/datasets";

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  columns: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).max(32).default([]),
});

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ datasets: await listDatasets(session.orgId) });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "name required" }, { status: 400 });
  try {
    const dataset = await createDataset(session.orgId, parsed.data.name, parsed.data.columns, session.email);
    return NextResponse.json({ dataset }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}
