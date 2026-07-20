// Author: Harsha Gundala
// screens — Notion-like pages: list and create.

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

const MAX_CREATE_SCREEN_BODY_BYTES = 512 * 1024;

const CreateSchema = z.object({
  title: z.string().min(1).max(120),
  icon: z.string().max(40).optional(),
  spec: z.object({ blocks: z.array(z.record(z.string(), z.unknown())) }).strict().optional(),
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
  let rawBody: Record<string, unknown>;
  try {
    assertSameOriginBrowserMutation(req);
    rawBody = await readPrivateJsonObject(req, MAX_CREATE_SCREEN_BODY_BYTES);
  } catch (error) {
    return privateRequestError(error);
  }
  const parsed = CreateSchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: "title required" }, { status: 400 });

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
