import {
  createBrowserRealtimeConnection,
  type RegisteredVoiceSessionSpec,
} from "../realtime/registry";
import type {
  BrowserProviderRootCredential,
  LocalDeploymentBrowserFundingAuthority,
} from "../realtime/types";

declare const openaiSession: RegisteredVoiceSessionSpec<"openai">;
declare const openaiByok: BrowserProviderRootCredential<"openai">;
declare const xaiByok: BrowserProviderRootCredential<"xai">;
declare const openaiLocal: LocalDeploymentBrowserFundingAuthority<"openai">;
declare const geminiSession: RegisteredVoiceSessionSpec<"gemini">;
declare const geminiLocal: LocalDeploymentBrowserFundingAuthority<"gemini">;

void createBrowserRealtimeConnection(openaiSession, openaiByok);
void createBrowserRealtimeConnection(openaiSession, openaiLocal);
void createBrowserRealtimeConnection(geminiSession, geminiLocal);

// @ts-expect-error Browser realtime creation requires a funding authority.
void createBrowserRealtimeConnection(openaiSession);
// @ts-expect-error Undefined is not a funding authority.
void createBrowserRealtimeConnection(openaiSession, undefined);
// @ts-expect-error Funding authority must match the session provider.
void createBrowserRealtimeConnection(openaiSession, xaiByok);
// @ts-expect-error Local authority is opaque and cannot be structurally forged.
void createBrowserRealtimeConnection(openaiSession, { source: "local_deployment_authorized", provider: "openai" });
// @ts-expect-error This release has no production Gemini tenant-BYOK browser path.
void createBrowserRealtimeConnection(geminiSession, openaiByok);
