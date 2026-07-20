import {
  RealtimeProviderPluginError,
  createRealtimeProviderPluginRegistry,
  defineRealtimeProviderPlugin,
} from "./registry";
import type {
  RealtimeProviderConnectionRequest,
  RealtimeProviderExecutionMode,
  RealtimeProviderPlugin,
  RealtimeProviderPluginSessionSpec,
  RealtimeProviderToolResult,
  RealtimeProviderTransportKind,
} from "./types";

export type RealtimeProviderConformanceConnectionFixture = Readonly<{
  mode: RealtimeProviderExecutionMode;
  transport: RealtimeProviderTransportKind;
  mediaProfileId: string;
}>;

export type RealtimeProviderConformanceFixture = Readonly<{
  validSession: RealtimeProviderPluginSessionSpec;
  invalidSession: RealtimeProviderPluginSessionSpec;
  supportedConnection: RealtimeProviderConformanceConnectionFixture;
  unsupportedConnection: RealtimeProviderConformanceConnectionFixture;
  normalization: Readonly<{
    mediaProfileId: string;
    inputEvents: readonly unknown[];
    expectedEventTypes: readonly string[];
  }>;
  toolResults: readonly RealtimeProviderToolResult[];
}>;

export type RealtimeProviderConformanceCheck = Readonly<{
  name: string;
  passed: boolean;
  detail?: string;
}>;

export type RealtimeProviderConformanceReport = Readonly<{
  contractVersion: "1.0";
  providerId: string;
  passed: boolean;
  checks: readonly RealtimeProviderConformanceCheck[];
}>;

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonSerializable(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Dependency-free executable kit for provider authors. It blocks the injected
 * network path, supplies only fake declared credentials, and verifies the
 * registry's preflight ordering in addition to plugin behavior. It is not a
 * sandbox: untrusted plugins must still run in an isolated process.
 */
export async function runRealtimeProviderPluginConformance(
  input: RealtimeProviderPlugin,
  fixture: RealtimeProviderConformanceFixture,
): Promise<RealtimeProviderConformanceReport> {
  const checks: RealtimeProviderConformanceCheck[] = [];
  const check = async (name: string, operation: () => void | Promise<void>) => {
    try {
      await operation();
      checks.push(Object.freeze({ name, passed: true }));
    } catch (error) {
      checks.push(Object.freeze({ name, passed: false, detail: errorDetail(error) }));
    }
  };

  let plugin: RealtimeProviderPlugin;
  try {
    plugin = defineRealtimeProviderPlugin(input);
  } catch (error) {
    return Object.freeze({
      contractVersion: "1.0",
      providerId: input?.manifest?.id ?? "invalid",
      passed: false,
      checks: Object.freeze([{
        name: "manifest",
        passed: false,
        detail: errorDetail(error),
      }]),
    });
  }
  const registry = createRealtimeProviderPluginRegistry([plugin]);
  const providerId = plugin.manifest.id;

  await check("valid session and supported transport", async () => {
    const connection = await registry.createConnection(
      providerId,
      fixture.supportedConnection.mode,
      fixture.supportedConnection.transport,
      fixture.supportedConnection.mediaProfileId,
      fixture.validSession,
      {
        readCredential: async (name) => `conformance-only:${name}`,
        fetch: async () => {
          throw new Error("conformance kit blocked a network request");
        },
        now: () => 1_700_000_000_000,
      },
    );
    if (connection.providerId !== providerId) {
      throw new Error("supported factory returned a different provider");
    }
  });

  await check("invalid session fails before credentials and factory", async () => {
    let credentialReads = 0;
    try {
      await registry.createConnection(
        providerId,
        fixture.supportedConnection.mode,
        fixture.supportedConnection.transport,
        fixture.supportedConnection.mediaProfileId,
        fixture.invalidSession,
        {
          readCredential: async () => {
            credentialReads += 1;
            return "must-not-be-read";
          },
        },
      );
      throw new Error("invalid session was accepted");
    } catch (error) {
      if (
        !(error instanceof RealtimeProviderPluginError)
        || error.code !== "invalid_session"
      ) {
        throw error;
      }
    }
    if (credentialReads !== 0) throw new Error("invalid session read credentials");
  });

  await check("unsupported transport fails before plugin code", async () => {
    let credentialReads = 0;
    try {
      await registry.createConnection(
        providerId,
        fixture.unsupportedConnection.mode,
        fixture.unsupportedConnection.transport,
        fixture.unsupportedConnection.mediaProfileId,
        fixture.validSession,
        {
          readCredential: async () => {
            credentialReads += 1;
            return "must-not-be-read";
          },
          fetch: async () => {
            throw new Error("unsupported transport attempted network");
          },
        },
      );
      throw new Error("unsupported transport was accepted");
    } catch (error) {
      if (
        !(error instanceof RealtimeProviderPluginError)
        || !["unsupported_transport", "unsupported_media"].includes(error.code)
      ) {
        throw error;
      }
    }
    if (credentialReads !== 0) throw new Error("unsupported transport read credentials");
  });

  await check("normalized event contract", () => {
    const normalizer = registry.createEventNormalizer(
      providerId,
      fixture.normalization.mediaProfileId,
    );
    const events = fixture.normalization.inputEvents
      .flatMap((event) => normalizer.push(event));
    if (
      events.some((event) => (
        event.schemaVersion !== 1
        || event.providerId !== providerId
        || !event.type
        || !Number.isFinite(event.receivedAtMs)
        || !event.wireType
      ))
    ) {
      throw new Error("normalizer emitted an invalid provider-neutral event");
    }
    const types = events.map(({ type }) => type);
    if (JSON.stringify(types) !== JSON.stringify(fixture.normalization.expectedEventTypes)) {
      throw new Error(
        `normalized event types ${JSON.stringify(types)} did not match `
        + JSON.stringify(fixture.normalization.expectedEventTypes),
      );
    }
    for (const event of events.filter(({ type }) => type === "tool.calls")) {
      if (!event.toolCalls?.length) {
        throw new Error("tool.calls event omitted normalized calls");
      }
      if (event.toolCalls.some((call) => !call.callId || !call.responseId || !call.name)) {
        throw new Error("normalized tool call omitted stable identity");
      }
    }
  });

  await check("tool result encoder", () => {
    const encoded = registry.encodeToolResults(providerId, fixture.toolResults);
    if (!jsonSerializable(encoded)) {
      throw new Error("tool result encoder returned a non-JSON value");
    }
  });

  return Object.freeze({
    contractVersion: "1.0",
    providerId,
    passed: checks.every(({ passed }) => passed),
    checks: Object.freeze(checks),
  });
}

/** Narrow helper for plugin author tests without exposing registry internals. */
export function connectionFixture(
  request: Pick<
    RealtimeProviderConnectionRequest,
    "transport" | "mediaProfileId"
  > & { mode: RealtimeProviderExecutionMode },
): RealtimeProviderConformanceConnectionFixture {
  return Object.freeze({
    mode: request.mode,
    transport: request.transport,
    mediaProfileId: request.mediaProfileId,
  });
}
