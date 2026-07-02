// Author: Harsha Gundala
// experiments/[id]/metrics — contract alias for per-variant metrics (same payload as the detail GET).

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { experimentMetrics } from "@/lib/experiments";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const metrics = await experimentMetrics(session.orgId, id).catch(() => null);
  if (!metrics) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(metrics);
}
