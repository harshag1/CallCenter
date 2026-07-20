// Author: Harsha Gundala
// chat — operator-agent endpoint: streams loop events to the client as SSE.

import { getSession } from "@/lib/auth";
import { runOperator } from "@/lib/agent/loop";
import { isUuid } from "@/lib/http";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";
import { requirePublicOrigin } from "@/lib/public-origin";
import { allowsLocalDevelopmentFundedAi } from "@/lib/deployment-funded-ai";

export const maxDuration = 300;

const MAX_CHAT_BODY_BYTES = 64 * 1024;
const MAX_CHAT_MESSAGE_BYTES = 48 * 1024;

type ChatBody = Readonly<{
  message: string;
  threadId: string;
  agentId: string | null;
  openFlow: Readonly<{ id?: string; label?: string }> | null;
}>;

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, {
    status,
    headers: PRIVATE_NO_STORE_HEADERS,
  });
}

function parseOpenFlow(value: unknown): ChatBody["openFlow"] | undefined {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.some((key) => key !== "id" && key !== "label")) return undefined;
  if (
    (candidate.id !== undefined && (
      typeof candidate.id !== "string"
      || candidate.id.length > 256
      || /[\u0000-\u001f\u007f]/.test(candidate.id)
    ))
    || (candidate.label !== undefined && (
      typeof candidate.label !== "string"
      || candidate.label.length > 512
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(candidate.label)
    ))
  ) return undefined;
  return Object.freeze({
    ...(candidate.id !== undefined ? { id: candidate.id } : {}),
    ...(candidate.label !== undefined ? { label: candidate.label } : {}),
  });
}

function parseChatBody(value: Record<string, unknown>): ChatBody | null {
  const keys = Object.keys(value);
  if (
    !Object.prototype.hasOwnProperty.call(value, "message")
    || !Object.prototype.hasOwnProperty.call(value, "threadId")
    || keys.some((key) => !["message", "threadId", "agentId", "openFlow"].includes(key))
    || typeof value.message !== "string"
    || value.message.length === 0
    || new TextEncoder().encode(value.message).byteLength > MAX_CHAT_MESSAGE_BYTES
    || /\u0000/.test(value.message)
    || !isUuid(value.threadId)
    || (value.agentId !== undefined && value.agentId !== null && !isUuid(value.agentId))
  ) return null;
  const openFlow = parseOpenFlow(value.openFlow);
  if (openFlow === undefined) return null;
  return Object.freeze({
    message: value.message,
    threadId: value.threadId,
    agentId: value.agentId == null ? null : value.agentId,
    openFlow,
  });
}

export async function POST(req: Request) {
  try {
    assertSameOriginBrowserMutation(req);
  } catch (error) {
    return jsonError("forbidden", error instanceof PrivateRequestError ? error.status : 403);
  }
  let body: ChatBody | null;
  try {
    body = parseChatBody(await readPrivateJsonObject(req, MAX_CHAT_BODY_BYTES));
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    return jsonError(status === 413 ? "payload_too_large" : "invalid_request", status);
  }
  if (!body) return jsonError("invalid_request", 400);

  const session = await getSession();
  if (!session) return jsonError("unauthorized", 401);
  if (!allowsLocalDevelopmentFundedAi()) {
    return jsonError("deployment_funded_ai_disabled", 503);
  }
  const origin = requirePublicOrigin();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of runOperator(
          session,
          body.threadId,
          body.message,
          body.agentId,
          origin,
          body.openFlow,
        )) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        }
      } catch {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({
            type: "notice",
            text: "Operator request failed.",
            code: "operator_request_failed",
          })}\n\n`)
        );
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      ...PRIVATE_NO_STORE_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
