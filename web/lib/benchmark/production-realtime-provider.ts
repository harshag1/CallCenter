import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TrialSessionConfiguration } from "./orchestrator";
import {
  LIVE_STS_PROVIDER_SPECS,
  type LiveStsProvider,
} from "./live-sts-development-experiment";
import { GeminiLiveClient } from "../realtime/client/gemini-live";
import {
  createOpenAIRealtimeClient,
  createXaiRealtimeClient,
  withManualPcmSession,
  withXaiServerVadPcmSession,
} from "../realtime/client/openai-compatible";
import type { NormalizedRealtimeClient } from "../realtime/client/types";
import { LC4_XAI_SERVER_VAD } from "./xai-server-vad";
import { canonicalJson, sha256Hex } from "./artifacts";

export type XaiRealtimeTurnBoundary =
  | "manual_commit"
  | "provider_native_server_vad";

function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export async function loadProductionRealtimeCredentials(
  repositoryRoot: string,
): Promise<Readonly<Record<LiveStsProvider, string>>> {
  const required = await loadProductionRealtimeCredentialCandidates(repositoryRoot);
  for (const [provider, key] of Object.entries(required)) {
    if (!key || key.length < 12) throw new Error(`missing ${provider} provider credential`);
  }
  return Object.freeze(required as Record<LiveStsProvider, string>);
}

/** Qualification needs to retain one sanitized result per provider, including missing credentials. */
export async function loadProductionRealtimeCredentialCandidates(
  repositoryRoot: string,
): Promise<Readonly<Partial<Record<LiveStsProvider, string>>>> {
  const candidates = [
    resolve(repositoryRoot, "web/.env.local"),
    process.env.BENCHMARK_PROVIDER_ENV_FILE,
  ].filter((path): path is string => Boolean(path));
  const merged: Record<string, string> = {};
  for (const path of candidates) {
    try {
      Object.assign(merged, parseEnv(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[name] = value;
  }
  const required = {
    openai: merged.OPENAI_API_KEY,
    gemini: merged.GEMINI_API_KEY,
    xai: merged.XAI_API_KEY,
  };
  return Object.freeze(required);
}

export function createProductionRealtimeClient(
  provider: LiveStsProvider,
  configuration: TrialSessionConfiguration,
  apiKey: string,
  options: Readonly<{
    geminiMaxDynamicControlBytes?: number;
    xaiTurnBoundary?: XaiRealtimeTurnBoundary;
  }> = {},
): NormalizedRealtimeClient {
  const spec = LIVE_STS_PROVIDER_SPECS[provider];
  if (configuration.provider !== provider) {
    throw new Error("realtime provider differs from the qualified session configuration");
  }
  if (configuration.model !== spec.model) {
    throw new Error("realtime model differs from the pinned provider specification");
  }
  if (provider === "gemini") {
    return new GeminiLiveClient({
      apiKey,
      model: spec.model,
      voice: spec.voice,
      instructions: configuration.instructions,
      tools: configuration.providerTools,
      ...(configuration.initialConversationHistoryHydrationRequired === true
        ? { enableInitialHistoryHydration: true }
        : {}),
      connectTimeoutMs: 15_000,
      maximumSessionDurationMs: 10 * 60_000,
      ...(options.geminiMaxDynamicControlBytes === undefined
        ? {}
        : { maxDynamicControlBytes: options.geminiMaxDynamicControlBytes }),
    });
  }
  const xaiTurnBoundary = options.xaiTurnBoundary ?? "provider_native_server_vad";
  const sessionUpdate = productionOpenAiCompatibleSessionUpdate(
    provider,
    configuration,
    provider === "xai" ? xaiTurnBoundary : undefined,
  );
  return provider === "openai"
    ? createOpenAIRealtimeClient({
        apiKey,
        model: spec.model,
        sessionUpdate,
        connectTimeoutMs: 15_000,
        requireStrictSessionConfigurationParity: true,
      })
    : createXaiRealtimeClient({
        apiKey,
        model: spec.model,
        sessionUpdate,
        connectTimeoutMs: 15_000,
        enableResumption: false,
        requireStrictSessionConfigurationParity: false,
        // xAI can emit speech_started/speech_stopped as non-authoritative
        // telemetry even when turn_detection.type is null. Manual authority is
        // proven separately by commit -> committed -> response.create ->
        // response.created wire causality; telemetry must never trigger either
        // the commit or the response.
        unexpectedManualTurnDetectionPolicy: "diagnose",
      });
}

export function productionOpenAiCompatibleSessionUpdate(
  provider: Exclude<LiveStsProvider, "gemini">,
  configuration: TrialSessionConfiguration,
  xaiTurnBoundary: XaiRealtimeTurnBoundary = "provider_native_server_vad",
): Readonly<Record<string, unknown>> {
  if (configuration.provider !== provider) throw new Error("realtime provider differs from the session payload configuration");
  const spec = LIVE_STS_PROVIDER_SPECS[provider];
  return provider === "openai"
    ? {
        type: "session.update",
        session: {
          type: "realtime",
          model: spec.model,
          instructions: configuration.instructions,
          audio: { input: { transcription: null, turn_detection: null }, output: { voice: spec.voice } },
          tools: configuration.providerTools,
          tool_choice: "auto",
        },
      }
    : {
        type: "session.update",
        session: {
          voice: spec.voice,
          instructions: configuration.instructions,
          turn_detection: xaiTurnBoundary === "manual_commit"
            ? { type: null }
            : LC4_XAI_SERVER_VAD,
          audio: { input: {}, output: {} },
          tools: configuration.providerTools,
          tool_choice: "auto",
        },
      };
}

export function productionSessionPayloadParitySha256(
  provider: Exclude<LiveStsProvider, "gemini">,
  configuration: TrialSessionConfiguration,
  xaiTurnBoundary: XaiRealtimeTurnBoundary = "provider_native_server_vad",
): string {
  const base = productionOpenAiCompatibleSessionUpdate(provider, configuration, xaiTurnBoundary);
  const compiled = provider === "xai"
    ? xaiTurnBoundary === "manual_commit"
      ? withManualPcmSession("xai", base)
      : withXaiServerVadPcmSession(base)
    : withManualPcmSession("openai", base);
  return sha256Hex(
    `harshas-amazing-call-center/production-realtime-session-payload/v2\n${canonicalJson({
      provider,
      model: configuration.model,
      turnBoundary: provider === "xai" ? xaiTurnBoundary : "manual_commit",
      sessionUpdate: compiled,
    })}`,
  );
}

/**
 * Non-treatment transport commitment for finite prerecorded xAI turns.
 * Instructions are deliberately excluded: Native and HACC vary their context
 * construction by design, while model, voice, manual boundary, PCM, tool
 * frontier, and resumption policy must remain identical within the pair.
 */
export function xaiFiniteManualTransportParitySha256(
  configuration: TrialSessionConfiguration,
): string {
  const compiled = withManualPcmSession(
    "xai",
    productionOpenAiCompatibleSessionUpdate(
      "xai",
      configuration,
      "manual_commit",
    ),
  );
  const session = compiled.session as Record<string, unknown>;
  return sha256Hex(
    `harshas-amazing-call-center/xai-finite-manual-transport-parity/v1\n${canonicalJson({
      provider: "xai",
      model: configuration.model,
      voice: session.voice ?? null,
      turn_detection: session.turn_detection ?? null,
      audio: session.audio ?? null,
      tool_choice: session.tool_choice ?? null,
      tools: Array.isArray(session.tools) ? session.tools : [],
      resumption: session.resumption ?? null,
    })}`,
  );
}
