// Author: Harsha Gundala
// experiments/[id] — detail with metrics; DELETE stops the experiment.

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { experimentMetrics, stopExperiment } from "@/lib/experiments";
import {
  assertEmptyPrivateRequest,
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
} from "@/lib/private-json-request";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const metrics = await experimentMetrics(session.orgId, id).catch(() => null);
  if (!metrics) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(metrics);
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    assertSameOriginBrowserMutation(req);
    await assertEmptyPrivateRequest(req);
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : "invalid request" },
      { status, headers: PRIVATE_NO_STORE_HEADERS },
    );
  }
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: PRIVATE_NO_STORE_HEADERS },
    );
  }
  const { id } = await params;
  const experiment = await stopExperiment(session.orgId, id).catch(() => null);
  if (!experiment) {
    return NextResponse.json(
      { error: "not found" },
      { status: 404, headers: PRIVATE_NO_STORE_HEADERS },
    );
  }
  return NextResponse.json({ experiment }, { headers: PRIVATE_NO_STORE_HEADERS });
}
