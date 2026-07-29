import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { allowsLocalDevelopmentFundedAi } from "@/lib/deployment-funded-ai";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";
import { providerCatalog } from "@/lib/realtime/registry";
import {
  deleteVoiceProviderCredential,
  isTenantBrowserVoiceProvider,
  isValidVoiceProviderCredential,
  replaceVoiceProviderCredential,
  VoiceProviderCredentialError,
  voiceProviderCredentialStatuses,
} from "@/lib/voice-provider-credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROVIDER_CREDENTIAL_REQUEST_BYTES = 8 * 1024;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: PRIVATE_NO_STORE_HEADERS,
  });
}

function mutationError(error: unknown): NextResponse {
  if (error instanceof PrivateRequestError) {
    if (error.status === 403) return json({ error: "forbidden" }, 403);
    const label = error.status === 413
      ? "payload_too_large"
      : error.status === 415
        ? "unsupported_media_type"
        : "invalid_request";
    return json({ error: label }, error.status);
  }
  if (error instanceof VoiceProviderCredentialError) {
    return json(
      { error: error.code === "invalid_input" ? "invalid_request" : "credential_store_unavailable" },
      error.code === "invalid_input" ? 400 : 503,
    );
  }
  return json({ error: "credential_store_unavailable" }, 503);
}

function parseProvider(value: unknown): "xai" | "openai" {
  if (!isTenantBrowserVoiceProvider(value)) {
    throw new PrivateRequestError(400);
  }
  return value;
}

export async function GET() {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  try {
    const tenantStatuses = new Map(
      (await voiceProviderCredentialStatuses(session.orgId))
        .map((status) => [status.provider, status]),
    );
    const localFunding = allowsLocalDevelopmentFundedAi();
    return json({
      providers: providerCatalog().map((provider) => {
        const tenant = isTenantBrowserVoiceProvider(provider.id)
          ? tenantStatuses.get(provider.id)
          : undefined;
        const localConfigured = localFunding
          && provider.env.every((name) =>
            isValidVoiceProviderCredential(process.env[name])
          );
        const credentialSource = localFunding
          ? localConfigured
            ? "local_deployment"
            : null
          : tenant?.configured
            ? "tenant_byok"
            : null;
        return {
          ...provider,
          configured: credentialSource !== null,
          credentialSource,
          credentialUpdatedAt: credentialSource === "tenant_byok"
            ? tenant?.updatedAt ?? null
            : null,
          // Environment names are setup hints only for the explicit local path.
          missingEnv: localFunding
            ? provider.env.filter((name) =>
                !isValidVoiceProviderCredential(process.env[name])
              )
            : [],
        };
      }),
    });
  } catch {
    return json({ error: "credential_store_unavailable" }, 503);
  }
}

/** Store or rotate one tenant-owned root without ever echoing it. */
export async function POST(request: Request) {
  try {
    assertSameOriginBrowserMutation(request);
    const body = await readPrivateJsonObject(
      request,
      MAX_PROVIDER_CREDENTIAL_REQUEST_BYTES,
    );
    if (
      Object.keys(body).length !== 2
      || !Object.prototype.hasOwnProperty.call(body, "provider")
      || !Object.prototype.hasOwnProperty.call(body, "credential")
      || !isValidVoiceProviderCredential(body.credential)
    ) {
      throw new PrivateRequestError(400);
    }
    const provider = parseProvider(body.provider);
    const session = await getSession();
    if (!session) return json({ error: "unauthorized" }, 401);
    const status = await replaceVoiceProviderCredential({
      orgId: session.orgId,
      provider,
      credential: body.credential,
    });
    return json({ ok: true, provider: status.provider, configured: true }, 200);
  } catch (error) {
    // Provider plaintext and vault exceptions must never enter logs or responses.
    return mutationError(error);
  }
}

/** Idempotently remove one tenant-owned provider root. */
export async function DELETE(request: Request) {
  try {
    assertSameOriginBrowserMutation(request);
    const body = await readPrivateJsonObject(
      request,
      MAX_PROVIDER_CREDENTIAL_REQUEST_BYTES,
    );
    if (
      Object.keys(body).length !== 1
      || !Object.prototype.hasOwnProperty.call(body, "provider")
    ) {
      throw new PrivateRequestError(400);
    }
    const provider = parseProvider(body.provider);
    const session = await getSession();
    if (!session) return json({ error: "unauthorized" }, 401);
    const removed = await deleteVoiceProviderCredential({
      orgId: session.orgId,
      provider,
    });
    return json({ ok: true, provider, configured: false, removed }, 200);
  } catch (error) {
    return mutationError(error);
  }
}
