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
} from "../realtime/client/openai-compatible";
import type { NormalizedRealtimeClient } from "../realtime/client/types";

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
  const candidates = [
    resolve(repositoryRoot, "web/.env.local"),
    process.env.BENCHMARK_PROVIDER_ENV_FILE,
  ].filter((path): path is string => Boolean(path));
  const merged: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const path of candidates) {
    try {
      Object.assign(merged, parseEnv(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const required = {
    openai: merged.OPENAI_API_KEY,
    gemini: merged.GEMINI_API_KEY,
    xai: merged.XAI_API_KEY,
  };
  for (const [provider, key] of Object.entries(required)) {
    if (!key || key.length < 12) throw new Error(`missing ${provider} provider credential`);
  }
  return Object.freeze(required as Record<LiveStsProvider, string>);
}

export function createProductionRealtimeClient(
  provider: LiveStsProvider,
  configuration: TrialSessionConfiguration,
  apiKey: string,
): NormalizedRealtimeClient {
  const spec = LIVE_STS_PROVIDER_SPECS[provider];
  if (provider === "gemini") {
    return new GeminiLiveClient({
      apiKey,
      model: spec.model,
      voice: spec.voice,
      instructions: configuration.instructions,
      tools: configuration.providerTools,
      connectTimeoutMs: 15_000,
      maximumSessionDurationMs: 10 * 60_000,
    });
  }
  const sessionUpdate = provider === "openai"
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
          turn_detection: { type: null },
          audio: { input: { transcription: null }, output: {} },
          tools: configuration.providerTools,
          tool_choice: "auto",
        },
      };
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
      });
}
