// Author: Harsha Gundala
// datasets — list (with row counts) and create; tables exist only when the user makes them.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { listDatasets, createDataset, publicDatasetError } from "@/lib/datasets";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";

const MAX_CREATE_DATASET_BODY_BYTES = 64 * 1024;

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  columns: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).max(32).default([]),
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

function privateJson(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ datasets: await listDatasets(session.orgId) });
}

export async function POST(req: Request) {
  let rawBody: Record<string, unknown>;
  try {
    assertSameOriginBrowserMutation(req);
    rawBody = await readPrivateJsonObject(req, MAX_CREATE_DATASET_BODY_BYTES);
  } catch (error) {
    return privateRequestError(error);
  }
  const parsed = CreateSchema.safeParse(rawBody);
  if (!parsed.success) return privateJson({ error: "name required" }, 400);

  const session = await getSession();
  if (!session) return privateJson({ error: "unauthorized" }, 401);
  try {
    const dataset = await createDataset(session.orgId, parsed.data.name, parsed.data.columns, session.email);
    return privateJson({ dataset }, 201);
  } catch (error) {
    const projected = publicDatasetError(error);
    return privateJson({ error: projected.message }, projected.status);
  }
}
