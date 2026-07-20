import "server-only";

import type {
  IntegrationDefinition,
  IntegrationEnvironment,
  IntegrationRegistry,
  IntegrationStatus,
} from "./types";

const INTEGRATION_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const CAPABILITY = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_INTEGRATIONS = 256;
const MAX_ENV_NAMES = 64;
const MAX_CAPABILITIES = 64;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertBoundedText(value: string, label: string): void {
  if (!value.trim() || /[\u0000\u007f]/.test(value) ||
      Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`${label} must be non-empty bounded text`);
  }
}

function canonicalNames(
  values: readonly string[] | undefined,
  label: string,
  pattern: RegExp,
  maximum: number
): readonly string[] {
  const detached = [...(values ?? [])];
  if (detached.length > maximum) throw new Error(`${label} exceeds ${maximum} entries`);
  for (const value of detached) {
    if (!pattern.test(value)) throw new Error(`${label} contains invalid value "${value}"`);
  }
  detached.sort(compareCodeUnits);
  if (detached.some((value, index) => value === detached[index - 1])) {
    throw new Error(`${label} contains duplicate values`);
  }
  return Object.freeze(detached);
}

/** Validates and detaches one declarative integration before it enters the public catalog. */
export function defineIntegration(input: IntegrationDefinition): IntegrationDefinition {
  if (!input || typeof input !== "object") throw new Error("integration definition is required");
  if (!INTEGRATION_ID.test(input.id)) throw new Error(`invalid integration id "${input.id}"`);
  assertBoundedText(input.label, `integration "${input.id}" label`);
  assertBoundedText(input.description, `integration "${input.id}" description`);
  let docsUrl: URL;
  try {
    docsUrl = new URL(input.docsUrl);
  } catch {
    throw new Error(`integration "${input.id}" docs URL is invalid`);
  }
  if (docsUrl.protocol !== "https:" || docsUrl.username || docsUrl.password) {
    throw new Error(`integration "${input.id}" docs URL must be public HTTPS`);
  }
  const requiredEnv = canonicalNames(
    input.requiredEnv,
    `integration "${input.id}" required environment`,
    ENV_NAME,
    MAX_ENV_NAMES
  );
  const optionalEnv = canonicalNames(
    input.optionalEnv,
    `integration "${input.id}" optional environment`,
    ENV_NAME,
    MAX_ENV_NAMES
  );
  const capabilities = canonicalNames(
    input.capabilities,
    `integration "${input.id}" capabilities`,
    CAPABILITY,
    MAX_CAPABILITIES
  );
  if (!capabilities.length) throw new Error(`integration "${input.id}" needs a capability`);
  const alternatives = [...(input.alternativeEnv ?? [])];
  if (alternatives.length > MAX_ENV_NAMES) {
    throw new Error(`integration "${input.id}" has too many environment alternatives`);
  }
  const alternativeEnv = Object.freeze(alternatives.map((group, index) => {
    const normalized = canonicalNames(
      group,
      `integration "${input.id}" alternative ${index + 1}`,
      ENV_NAME,
      MAX_ENV_NAMES
    );
    if (!normalized.length) {
      throw new Error(`integration "${input.id}" alternative ${index + 1} is empty`);
    }
    return normalized;
  }));
  const directNames = new Set([...requiredEnv, ...optionalEnv]);
  if (directNames.size !== requiredEnv.length + optionalEnv.length) {
    throw new Error(`integration "${input.id}" repeats a required and optional environment name`);
  }
  return Object.freeze({
    id: input.id,
    label: input.label,
    category: input.category,
    description: input.description,
    docsUrl: docsUrl.href,
    requiredEnv,
    ...(alternativeEnv.length ? { alternativeEnv } : {}),
    ...(optionalEnv.length ? { optionalEnv } : {}),
    capabilities,
  });
}

function present(environment: IntegrationEnvironment, name: string): boolean {
  return Boolean(environment[name]?.trim());
}

function statusesFor(
  definitions: readonly IntegrationDefinition[],
  environment: IntegrationEnvironment
): readonly IntegrationStatus[] {
  return Object.freeze(definitions.map((integration) => {
    const missingEnv = Object.freeze(
      integration.requiredEnv.filter((name) => !present(environment, name))
    );
    const alternatives = integration.alternativeEnv ?? [];
    const hasAlternative = !alternatives.length ||
      alternatives.some((group) => group.every((name) => present(environment, name)));
    const missingAlternatives = hasAlternative
      ? Object.freeze([] as (readonly string[])[])
      : Object.freeze(alternatives.map((group) =>
          Object.freeze(group.filter((name) => !present(environment, name)))
        ));
    return Object.freeze({
      ...integration,
      configured: missingEnv.length === 0 && hasAlternative,
      missingEnv,
      missingAlternatives,
    });
  }));
}

/**
 * Composes built-in and third-party integration manifests into one immutable registry.
 * The injected environment makes configuration checks deterministic in CLIs and tests without
 * copying secret values into the registry or its returned status objects.
 */
export function createIntegrationRegistry(
  inputs: readonly IntegrationDefinition[]
): IntegrationRegistry {
  if (!Array.isArray(inputs) || inputs.length > MAX_INTEGRATIONS) {
    throw new Error(`integration registry exceeds ${MAX_INTEGRATIONS} entries`);
  }
  const definitions = Object.freeze(inputs.map(defineIntegration));
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) throw new Error(`duplicate integration "${definition.id}"`);
    ids.add(definition.id);
  }
  return Object.freeze({
    definitions,
    statuses(environment: IntegrationEnvironment = process.env) {
      return statusesFor(definitions, environment);
    },
  });
}

const BUILT_IN_INTEGRATIONS: readonly IntegrationDefinition[] = [
  {
    id: "xai",
    label: "xAI Voice",
    category: "voice",
    description: "Realtime speech-to-speech over WebSocket with one local capability gateway and native telephony codecs.",
    docsUrl: "https://docs.x.ai/developers/model-capabilities/audio/voice-agent",
    requiredEnv: ["XAI_API_KEY"],
    optionalEnv: ["XAI_SIP_SIGNING_SECRET"],
    capabilities: ["browser", "twilio-bridge", "sip", "capability-gateway"],
  },
  {
    id: "openai",
    label: "OpenAI Realtime",
    category: "voice",
    description: "Realtime speech-to-speech over WebRTC or the PCMU bridge with one local capability gateway.",
    docsUrl: "https://developers.openai.com/api/docs/guides/realtime",
    requiredEnv: ["OPENAI_API_KEY"],
    capabilities: ["browser", "twilio-bridge", "capability-gateway"],
  },
  {
    id: "gemini",
    label: "Gemini Live",
    category: "voice",
    description: "Native-audio Live API over ephemeral WebSockets with blocking local-gateway function dispatch.",
    docsUrl: "https://ai.google.dev/gemini-api/docs/live-api/get-started-sdk",
    requiredEnv: ["GEMINI_API_KEY"],
    capabilities: ["browser", "function-calling", "capability-gateway", "application-checkpoints"],
  },
  {
    id: "twilio",
    label: "Twilio Voice & SMS",
    category: "telephony",
    description: "Signature-verified inbound PSTN plus authority-gated outbound calls, Media Streams, number assignment, transfer, and SMS.",
    docsUrl: "https://www.twilio.com/docs/voice/media-streams",
    requiredEnv: [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_API_KEY_TYPE",
      "TWILIO_API_KEY_ACCOUNT_SID",
      "TWILIO_API_KEY_SID",
      "TWILIO_API_KEY_SECRET",
      "TWILIO_PHONE_NUMBER",
      "BRIDGE_WS_URL",
      "TELEPHONY_RECEIPT_SECRET",
    ],
    capabilities: ["pstn", "media-streams", "sms", "operator-approved-number-assignment"],
  },
  {
    id: "resend",
    label: "Resend",
    category: "email",
    description: "OTP authentication and operator-approved transactional email; API acceptance is not inbox delivery.",
    docsUrl: "https://resend.com/docs",
    requiredEnv: ["RESEND_API_KEY", "EMAIL_FROM"],
    capabilities: ["otp", "transactional-email"],
  },
  {
    id: "supabase",
    label: "Postgres / Supabase",
    category: "data",
    description: "Durable agent versions, flows, datasets, call events, browser-recording storage, and checkpoints.",
    docsUrl: "https://supabase.com/docs/guides/database/connecting-to-postgres",
    requiredEnv: [],
    alternativeEnv: [["DATABASE_URL"], ["SUPABASE_DB_URL"]],
    capabilities: ["postgres", "pgvector", "browser-recordings", "realtime-events"],
  },
  {
    id: "vercel-tools",
    label: "Vercel Tool Factory",
    category: "deployment",
    description: "Optional isolated deployment target for reviewed generated tools; builder creation remains approval-gated.",
    docsUrl: "https://vercel.com/docs/rest-api",
    requiredEnv: ["VERCEL_TOKEN"],
    optionalEnv: ["VERCEL_TEAM_ID", "VERCEL_TOOLS_PROJECT", "ENABLE_TOOL_FACTORY"],
    capabilities: ["tool-deployment", "encrypted-env", "preview-isolation"],
  },
];

export const integrationRegistry = createIntegrationRegistry(BUILT_IN_INTEGRATIONS);
export const INTEGRATIONS = integrationRegistry.definitions;

export function integrationStatuses(
  environment: IntegrationEnvironment = process.env
): readonly IntegrationStatus[] {
  return integrationRegistry.statuses(environment);
}
