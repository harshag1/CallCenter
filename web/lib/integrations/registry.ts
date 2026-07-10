import "server-only";

import type { IntegrationDefinition, IntegrationStatus } from "./types";

export const INTEGRATIONS: IntegrationDefinition[] = [
  {
    id: "xai",
    label: "xAI Voice",
    category: "voice",
    description: "Realtime speech-to-speech over WebSocket with remote MCP and native telephony codecs.",
    docsUrl: "https://docs.x.ai/developers/model-capabilities/audio/voice-agent",
    requiredEnv: ["XAI_API_KEY"],
    optionalEnv: ["XAI_SIP_SIGNING_SECRET"],
    capabilities: ["browser", "twilio-bridge", "sip", "remote-mcp"],
  },
  {
    id: "openai",
    label: "OpenAI Realtime",
    category: "voice",
    description: "Realtime speech-to-speech over WebRTC, WebSocket, or SIP with remote MCP.",
    docsUrl: "https://developers.openai.com/api/docs/guides/realtime",
    requiredEnv: ["OPENAI_API_KEY"],
    capabilities: ["browser", "twilio-bridge", "sip", "remote-mcp"],
  },
  {
    id: "gemini",
    label: "Gemini Live",
    category: "voice",
    description: "Native-audio Live API over ephemeral WebSockets with client-side function dispatch.",
    docsUrl: "https://ai.google.dev/gemini-api/docs/live-api",
    requiredEnv: ["GEMINI_API_KEY"],
    capabilities: ["browser", "function-calling", "session-resumption"],
  },
  {
    id: "twilio",
    label: "Twilio Voice & SMS",
    category: "telephony",
    description: "Inbound/outbound PSTN, bidirectional Media Streams, number provisioning, transfer, and SMS.",
    docsUrl: "https://www.twilio.com/docs/voice/media-streams",
    requiredEnv: ["TWILIO_ACCOUNT_SID", "TWILIO_PHONE_NUMBER", "BRIDGE_WS_URL"],
    alternativeEnv: [["TWILIO_AUTH_TOKEN"], ["TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET"]],
    capabilities: ["pstn", "media-streams", "sms", "number-provisioning"],
  },
  {
    id: "resend",
    label: "Resend",
    category: "email",
    description: "OTP authentication and voice-agent transactional email.",
    docsUrl: "https://resend.com/docs",
    requiredEnv: ["RESEND_API_KEY", "EMAIL_FROM"],
    capabilities: ["otp", "transactional-email"],
  },
  {
    id: "supabase",
    label: "Postgres / Supabase",
    category: "data",
    description: "Durable agent versions, flows, datasets, call events, recordings, and checkpoints.",
    docsUrl: "https://supabase.com/docs/guides/database/connecting-to-postgres",
    requiredEnv: [],
    alternativeEnv: [["DATABASE_URL"], ["SUPABASE_DB_URL"]],
    capabilities: ["postgres", "pgvector", "recordings", "realtime-events"],
  },
  {
    id: "vercel-tools",
    label: "Vercel Tool Factory",
    category: "deployment",
    description: "Optional isolated deployment target for tools created by the builder agent.",
    docsUrl: "https://vercel.com/docs/rest-api",
    requiredEnv: ["VERCEL_TOKEN"],
    optionalEnv: ["VERCEL_TEAM_ID", "VERCEL_TOOLS_PROJECT", "ENABLE_TOOL_FACTORY"],
    capabilities: ["tool-deployment", "encrypted-env", "preview-isolation"],
  },
];

function present(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}
export function integrationStatuses(): IntegrationStatus[] {
  return INTEGRATIONS.map((integration) => {
    const missingEnv = integration.requiredEnv.filter((name) => !present(name));
    const alternatives = integration.alternativeEnv ?? [];
    const hasAlternative = !alternatives.length || alternatives.some((group) => group.every(present));
    return {
      ...integration,
      configured: missingEnv.length === 0 && hasAlternative,
      missingEnv,
      missingAlternatives: hasAlternative ? [] : alternatives,
    };
  });
}
