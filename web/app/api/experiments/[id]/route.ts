// Author: Harsha Gundala
// experiments/[id] — detail with metrics; DELETE stops the experiment.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { experimentMetrics, stopExperiment } from "@/lib/experiments";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const metrics = await experimentMetrics(session.orgId, id).catch(() => null);
  if (!metrics) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(metrics);
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const experiment = await stopExperiment(session.orgId, id).catch(() => null);
  if (!experiment) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ experiment });
}
