import type {
  BrowserRealtimeConnection,
  RealtimeAudioFormat,
  RealtimeProviderAdapter,
  ServerRealtimeConnection,
  VoiceProviderId,
  VoiceSessionSpec,
} from "../types";
import type {
  RealtimeProviderEventNormalizer,
  RealtimeProviderManifest,
  RealtimeProviderMediaProfile,
  RealtimeProviderNormalizedEvent,
  RealtimeProviderPlugin,
  RealtimeProviderPluginSessionSpec,
  RealtimeProviderSessionValidation,
  RealtimeProviderToolResult,
} from "./types";

export type LegacyRealtimeAdapterPluginOptions = Readonly<{
  adapter: RealtimeProviderAdapter;
  manifest: RealtimeProviderManifest;
  validateSession?: (
    session: RealtimeProviderPluginSessionSpec,
  ) => RealtimeProviderSessionValidation;
  createEventNormalizer(
    mediaProfile: RealtimeProviderMediaProfile,
  ): RealtimeProviderEventNormalizer;
  encodeToolResults(results: readonly RealtimeProviderToolResult[]): unknown;
}>;

function defaultValidation(
  expectedProvider: string,
  session: RealtimeProviderPluginSessionSpec,
): RealtimeProviderSessionValidation {
  const issues = [];
  if (session.providerId !== expectedProvider) {
    issues.push({
      path: "providerId",
      code: "provider_mismatch",
      message: `expected "${expectedProvider}"`,
    });
  }
  for (const field of ["model", "voice", "instructions"] as const) {
    if (!session[field]?.trim()) {
      issues.push({
        path: field,
        code: "required",
        message: `${field} is required`,
      });
    }
  }
  if (!session.toolAuthority.proxyUrl || !session.toolAuthority.proxyToken) {
    issues.push({
      path: "toolAuthority",
      code: "required",
      message: "the scoped local tool authority is required",
    });
  }
  return issues.length
    ? { ok: false, issues: Object.freeze(issues) }
    : { ok: true, session };
}

function legacySession(
  provider: VoiceProviderId,
  session: RealtimeProviderPluginSessionSpec,
): VoiceSessionSpec {
  return {
    provider,
    model: session.model,
    voice: session.voice,
    settings: { ...session.settings },
    instructions: session.instructions,
    mcpServers: session.mcpServers.map((server) => ({ ...server })),
    toolProxyUrl: session.toolAuthority.proxyUrl,
    toolProxyToken: session.toolAuthority.proxyToken,
    ...(session.toolAuthority.rotation
      ? { toolProxyRotation: session.toolAuthority.rotation }
      : {}),
    activeCatalogAuthority: session.toolAuthority.activeCatalog,
  };
}

function legacyAudio(
  profile: RealtimeProviderMediaProfile,
): RealtimeAudioFormat {
  if (
    profile.input.encoding === "pcmu"
    && profile.output.encoding === "pcmu"
    && profile.input.sampleRateHz === 8_000
    && profile.output.sampleRateHz === 8_000
  ) {
    return "pcmu";
  }
  if (
    profile.input.encoding === "pcm-s16le"
    && profile.output.encoding === "pcm-s16le"
    && profile.input.sampleRateHz === 24_000
    && profile.output.sampleRateHz === 24_000
    && profile.input.channels === 1
    && profile.output.channels === 1
  ) {
    return "pcm";
  }
  throw new Error(
    `legacy adapter cannot map asymmetric or encoded media profile "${profile.id}"`,
  );
}

/**
 * Transitional bridge for the existing three adapters. New plugins should
 * implement `RealtimeProviderPlugin` directly so credential access can flow
 * exclusively through the injected factory context.
 */
export function wrapLegacyRealtimeProviderAdapter(
  options: LegacyRealtimeAdapterPluginOptions,
): RealtimeProviderPlugin {
  const adapter = Object.freeze({ ...options.adapter });
  const manifest = deepFreeze(structuredClone(options.manifest));
  const createEventNormalizer = options.createEventNormalizer;
  const encodeToolResults = options.encodeToolResults;
  if (adapter.id !== manifest.id) {
    throw new Error(`legacy adapter "${adapter.id}" cannot register as "${manifest.id}"`);
  }
  const profiles = new Map(manifest.mediaProfiles.map((profile) => [profile.id, profile]));
  const profile = (id: string) => {
    const match = profiles.get(id);
    if (!match) throw new Error(`unknown media profile "${id}"`);
    return match;
  };
  const wrapConnection = (
    mode: "browser" | "server",
    transport: "websocket" | "webrtc" | "webtransport",
    mediaProfileId: string,
    handle: BrowserRealtimeConnection | ServerRealtimeConnection,
  ) => Object.freeze({
    providerId: manifest.id,
    mode,
    transport,
    mediaProfileId,
    handle,
  });

  return {
    manifest,
    validateSession: options.validateSession
      ?? ((session) => defaultValidation(manifest.id, session)),
    ...(manifest.transports.browser.length
      ? {
          browser: {
            async create(request) {
              const handle = await adapter.createBrowserConnection(
                legacySession(adapter.id, request.session),
              );
              return wrapConnection(
                "browser",
                request.transport,
                request.mediaProfileId,
                handle,
              );
            },
          },
        }
      : {}),
    ...(manifest.transports.server.length
      ? {
          server: {
            async create(request) {
              const handle = await adapter.createServerConnection(
                legacySession(adapter.id, request.session),
                legacyAudio(profile(request.mediaProfileId)),
              );
              return wrapConnection(
                "server",
                request.transport,
                request.mediaProfileId,
                handle,
              );
            },
          },
        }
      : {}),
    createEventNormalizer(mediaProfileId) {
      return createEventNormalizer(profile(mediaProfileId));
    },
    encodeToolResults,
  };
}

function deepFreeze<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/** Maps the existing normalized-client event shape into plugin contract v1. */
export function normalizeLegacyClientEvent(
  providerId: string,
  event: unknown,
): RealtimeProviderNormalizedEvent {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("legacy normalized event must be an object");
  }
  const record = event as Record<string, unknown>;
  if (record.provider !== providerId || typeof record.type !== "string") {
    throw new Error(`legacy normalized event does not belong to "${providerId}"`);
  }
  if (typeof record.receivedAtMs !== "number" || typeof record.wireType !== "string") {
    throw new Error("legacy normalized event is missing receipt metadata");
  }
  const responseId = typeof record.responseId === "string"
    ? record.responseId
    : undefined;
  const calls = record.type === "tool.calls" && Array.isArray(record.calls)
    ? Object.freeze(record.calls.map((call) => {
        if (!call || typeof call !== "object") {
          throw new Error("legacy normalized tool call must be an object");
        }
        const value = call as Record<string, unknown>;
        for (const key of ["callId", "responseId", "name", "argumentsText", "terminalWireType"]) {
          if (typeof value[key] !== "string" || !value[key]) {
            throw new Error(`legacy normalized tool call needs ${key}`);
          }
        }
        return Object.freeze({
          callId: value.callId as string,
          responseId: value.responseId as string,
          name: value.name as string,
          argumentsText: value.argumentsText as string,
          argumentsJson: value.argumentsJson ?? null,
          terminalWireType: value.terminalWireType as string,
          ...(typeof value.terminalEventId === "string"
            ? { terminalEventId: value.terminalEventId }
            : {}),
        });
      }))
    : undefined;
  return Object.freeze({
    schemaVersion: 1,
    providerId,
    type: record.type,
    receivedAtMs: record.receivedAtMs,
    wireType: record.wireType,
    ...(responseId ? { responseId } : {}),
    ...(calls ? { toolCalls: calls } : {}),
    data: Object.freeze({ ...record }),
  });
}
