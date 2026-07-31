import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  CallOperationsConfigurationError,
  loadCallOperationsProjection,
} from "@/lib/call-operations-store";
import { normalizePublicCallOperationsStatus } from "@/lib/call-operations-projection";
import { isUuid } from "@/lib/http";
import { PRIVATE_NO_STORE_HEADERS } from "@/lib/private-json-request";

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

/**
 * Read-only, content-free management state for one call. A missing call and a
 * call owned by another tenant are intentionally indistinguishable.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const { id } = await params;
  if (!isUuid(id)) return json({ error: "not_found" }, 404);
  try {
    const operations = await loadCallOperationsProjection({
      callId: id,
      organizationId: session.orgId,
    });
    if (operations === null) return json({ error: "not_found" }, 404);
    const callStatus = normalizePublicCallOperationsStatus(
      operations.freshness.callStatus,
    );
    return json({
      operations: {
        ...operations,
        freshness: {
          ...operations.freshness,
          callStatus,
          active: callStatus === "active" || callStatus === "dialing",
        },
      },
    });
  } catch (error) {
    if (error instanceof CallOperationsConfigurationError) {
      return json({ error: "operations_unavailable" }, 503);
    }
    console.error("call operations projection failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    });
    return json({ error: "operations_unavailable" }, 503);
  }
}
