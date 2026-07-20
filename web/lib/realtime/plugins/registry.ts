import {
  REALTIME_PROVIDER_NORMALIZED_EVENT_VERSION,
  REALTIME_PROVIDER_PLUGIN_CONTRACT_VERSION,
  type RealtimeProviderConnection,
  type RealtimeProviderEventNormalizer,
  type RealtimeProviderExecutionMode,
  type RealtimeProviderManifest,
  type RealtimeProviderMediaProfile,
  type RealtimeProviderPlugin,
  type RealtimeProviderPluginSessionSpec,
  type RealtimeProviderRegistryCreateOptions,
  type RealtimeProviderToolCall,
  type RealtimeProviderToolResult,
  type RealtimeProviderTransportDeclaration,
  type RealtimeProviderTransportKind,
} from "./types";

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MEDIA_PROFILE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const LIFECYCLE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VENDOR_MEDIA_ENCODING = /^vendor:[a-z][a-z0-9.-]{0,63}$/;
const MAX_PROVIDERS = 64;
const MAX_TRANSPORTS_PER_MODE = 8;
const MAX_MEDIA_PROFILES = 16;
const MAX_NOTES = 32;
const MAX_TEXT_LENGTH = 8_192;
const MAX_NORMALIZED_EVENTS_PER_FRAME = 1_024;
const MAX_TOOL_ARGUMENT_BYTES = 1024 * 1024;
const MAX_TOOL_RESULTS_PER_BATCH = 128;
const MAX_TOOL_RESULT_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_BYTES = 2 * 1024 * 1024;

export class RealtimeProviderPluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RealtimeProviderPluginError";
  }
}

function pluginError(code: string, message: string): never {
  throw new RealtimeProviderPluginError(code, message);
}

function assertText(value: string, label: string): void {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > MAX_TEXT_LENGTH
    || /[\u0000\u007f]/.test(value)
  ) {
    pluginError("invalid_manifest", `${label} must be non-empty bounded text`);
  }
}

function canonicalStrings(
  values: readonly string[],
  label: string,
  pattern: RegExp,
  maximum: number,
): readonly string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    pluginError("invalid_manifest", `${label} exceeds ${maximum} entries`);
  }
  const detached = [...values];
  for (const value of detached) {
    if (typeof value !== "string" || !pattern.test(value)) {
      pluginError("invalid_manifest", `${label} contains invalid value "${String(value)}"`);
    }
  }
  detached.sort();
  if (detached.some((value, index) => value === detached[index - 1])) {
    pluginError("invalid_manifest", `${label} contains duplicate values`);
  }
  return Object.freeze(detached);
}

function snapshotAudioDirection(
  direction: RealtimeProviderMediaProfile["input"],
  label: string,
): RealtimeProviderMediaProfile["input"] {
  if (
    !direction
    || (
      !["pcm-s16le", "pcmu", "pcma", "opus"].includes(direction.encoding)
      && !VENDOR_MEDIA_ENCODING.test(direction.encoding)
    )
    || !Number.isInteger(direction.sampleRateHz)
    || direction.sampleRateHz < 8_000
    || direction.sampleRateHz > 192_000
    || (direction.channels !== 1 && direction.channels !== 2)
  ) {
    pluginError("invalid_manifest", `${label} has an invalid audio format`);
  }
  return Object.freeze({
    encoding: direction.encoding,
    sampleRateHz: direction.sampleRateHz,
    channels: direction.channels,
  });
}

function snapshotMediaProfiles(
  profiles: readonly RealtimeProviderMediaProfile[],
): readonly RealtimeProviderMediaProfile[] {
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > MAX_MEDIA_PROFILES) {
    pluginError(
      "invalid_manifest",
      `mediaProfiles must contain 1 to ${MAX_MEDIA_PROFILES} entries`,
    );
  }
  const ids = new Set<string>();
  return Object.freeze(profiles.map((profile) => {
    if (!profile || !MEDIA_PROFILE_ID.test(profile.id)) {
      pluginError("invalid_manifest", `invalid media profile id "${String(profile?.id)}"`);
    }
    if (ids.has(profile.id)) {
      pluginError("invalid_manifest", `duplicate media profile "${profile.id}"`);
    }
    ids.add(profile.id);
    return Object.freeze({
      id: profile.id,
      input: snapshotAudioDirection(profile.input, `media profile "${profile.id}" input`),
      output: snapshotAudioDirection(profile.output, `media profile "${profile.id}" output`),
    });
  }));
}

function snapshotTransports(
  declarations: readonly RealtimeProviderTransportDeclaration[],
  mode: RealtimeProviderExecutionMode,
  mediaIds: ReadonlySet<string>,
): readonly RealtimeProviderTransportDeclaration[] {
  if (!Array.isArray(declarations) || declarations.length > MAX_TRANSPORTS_PER_MODE) {
    pluginError(
      "invalid_manifest",
      `${mode} transports exceed ${MAX_TRANSPORTS_PER_MODE} entries`,
    );
  }
  const kinds = new Set<RealtimeProviderTransportKind>();
  return Object.freeze(declarations.map((declaration) => {
    if (
      !declaration
      || !["websocket", "webrtc", "webtransport"].includes(declaration.kind)
    ) {
      pluginError("invalid_manifest", `${mode} has an invalid transport`);
    }
    if (kinds.has(declaration.kind)) {
      pluginError("invalid_manifest", `${mode} repeats ${declaration.kind}`);
    }
    kinds.add(declaration.kind);
    const mediaProfileIds = canonicalStrings(
      declaration.mediaProfileIds,
      `${mode} ${declaration.kind} media profiles`,
      MEDIA_PROFILE_ID,
      MAX_MEDIA_PROFILES,
    );
    if (!mediaProfileIds.length) {
      pluginError(
        "invalid_manifest",
        `${mode} ${declaration.kind} needs a media profile`,
      );
    }
    for (const id of mediaProfileIds) {
      if (!mediaIds.has(id)) {
        pluginError(
          "invalid_manifest",
          `${mode} ${declaration.kind} references unknown media profile "${id}"`,
        );
      }
    }
    return Object.freeze({ kind: declaration.kind, mediaProfileIds });
  }));
}

function snapshotManifest(input: RealtimeProviderManifest): RealtimeProviderManifest {
  if (!input || typeof input !== "object") {
    pluginError("invalid_manifest", "provider manifest is required");
  }
  if (input.contractVersion !== REALTIME_PROVIDER_PLUGIN_CONTRACT_VERSION) {
    pluginError(
      "unsupported_contract",
      `provider contract "${String(input.contractVersion)}" is unsupported`,
    );
  }
  if (!PROVIDER_ID.test(input.id)) {
    pluginError("invalid_manifest", `invalid provider id "${String(input.id)}"`);
  }
  assertText(input.label, `provider "${input.id}" label`);
  assertText(input.defaultModel, `provider "${input.id}" default model`);
  assertText(input.defaultVoice, `provider "${input.id}" default voice`);
  let docsUrl: URL;
  try {
    docsUrl = new URL(input.docsUrl);
  } catch {
    pluginError("invalid_manifest", `provider "${input.id}" docs URL is invalid`);
  }
  if (docsUrl.protocol !== "https:" || docsUrl.username || docsUrl.password) {
    pluginError(
      "invalid_manifest",
      `provider "${input.id}" docs URL must be public HTTPS`,
    );
  }
  const environment = canonicalStrings(
    input.environment,
    `provider "${input.id}" environment`,
    ENVIRONMENT_NAME,
    64,
  );
  if (
    !input.lifecycle
    || !["experimental", "preview", "stable", "deprecated"].includes(input.lifecycle.maturity)
  ) {
    pluginError("invalid_manifest", `provider "${input.id}" maturity is invalid`);
  }
  if (!LIFECYCLE_DATE.test(input.lifecycle.since)) {
    pluginError(
      "invalid_manifest",
      `provider "${input.id}" lifecycle since must be YYYY-MM-DD`,
    );
  }
  if (
    input.lifecycle.replacementProviderId !== undefined
    && !PROVIDER_ID.test(input.lifecycle.replacementProviderId)
  ) {
    pluginError("invalid_manifest", `provider "${input.id}" replacement id is invalid`);
  }
  if (
    input.lifecycle.maturity !== "deprecated"
    && input.lifecycle.replacementProviderId !== undefined
  ) {
    pluginError(
      "invalid_manifest",
      `provider "${input.id}" can name a replacement only when deprecated`,
    );
  }

  const mediaProfiles = snapshotMediaProfiles(input.mediaProfiles);
  const mediaIds = new Set(mediaProfiles.map(({ id }) => id));
  const browser = snapshotTransports(input.transports?.browser, "browser", mediaIds);
  const server = snapshotTransports(input.transports?.server, "server", mediaIds);
  if (!browser.length && !server.length) {
    pluginError("invalid_manifest", `provider "${input.id}" needs a transport`);
  }

  if (
    !input.telephony
    || !["unsupported", "native-media", "transcoding-bridge"].includes(
      input.telephony.support,
    )
  ) {
    pluginError("invalid_manifest", `provider "${input.id}" telephony support is invalid`);
  }
  const telephonyIngressMedia = canonicalStrings(
    input.telephony.ingressMediaProfileIds,
    `provider "${input.id}" telephony ingress media profiles`,
    MEDIA_PROFILE_ID,
    MAX_MEDIA_PROFILES,
  );
  const telephonyProviderMedia = canonicalStrings(
    input.telephony.providerMediaProfileIds,
    `provider "${input.id}" telephony provider media profiles`,
    MEDIA_PROFILE_ID,
    MAX_MEDIA_PROFILES,
  );
  for (const id of [...telephonyIngressMedia, ...telephonyProviderMedia]) {
    if (!mediaIds.has(id)) {
      pluginError(
        "invalid_manifest",
        `provider "${input.id}" telephony references unknown media profile "${id}"`,
      );
    }
  }
  if (
    input.telephony.support === "unsupported"
    && (telephonyIngressMedia.length || telephonyProviderMedia.length)
  ) {
    pluginError(
      "invalid_manifest",
      `provider "${input.id}" unsupported telephony cannot declare media profiles`,
    );
  }
  if (
    input.telephony.support !== "unsupported"
    && (!telephonyIngressMedia.length || !telephonyProviderMedia.length)
  ) {
    pluginError(
      "invalid_manifest",
      `provider "${input.id}" telephony needs a media profile`,
    );
  }
  if (input.telephony.support === "native-media") {
    if (
      JSON.stringify(telephonyIngressMedia)
      !== JSON.stringify(telephonyProviderMedia)
    ) {
      pluginError(
        "invalid_manifest",
        `provider "${input.id}" native telephony must preserve its media profile`,
      );
    }
    const serverMedia = new Set(
      server.flatMap(({ mediaProfileIds }) => mediaProfileIds),
    );
    for (const id of telephonyProviderMedia) {
      if (!serverMedia.has(id)) {
        pluginError(
          "invalid_manifest",
          `provider "${input.id}" native telephony media "${id}" `
          + "needs a server transport",
        );
      }
    }
  }
  if (!Array.isArray(input.telephony.notes) || input.telephony.notes.length > MAX_NOTES) {
    pluginError("invalid_manifest", `provider "${input.id}" has too many telephony notes`);
  }
  const telephonyNotes = Object.freeze(input.telephony.notes.map((note, index) => {
    assertText(note, `provider "${input.id}" telephony note ${index + 1}`);
    return note;
  }));
  const referencedMedia = new Set([
    ...browser.flatMap(({ mediaProfileIds }) => mediaProfileIds),
    ...server.flatMap(({ mediaProfileIds }) => mediaProfileIds),
    ...telephonyIngressMedia,
    ...telephonyProviderMedia,
  ]);
  for (const { id } of mediaProfiles) {
    if (!referencedMedia.has(id)) {
      pluginError(
        "invalid_manifest",
        `provider "${input.id}" has unused media profile "${id}"`,
      );
    }
  }

  if (
    !input.tools
    || !["local-gateway", "provider-native", "both"].includes(input.tools.delivery)
    || input.tools.normalizedCalls !== true
    || typeof input.tools.streamedArguments !== "boolean"
  ) {
    pluginError("invalid_manifest", `provider "${input.id}" tool contract is invalid`);
  }
  if (
    !input.normalization
    || input.normalization.eventSchemaVersion !== REALTIME_PROVIDER_NORMALIZED_EVENT_VERSION
    || !["wire-events", "normalized-client-events"].includes(input.normalization.input)
    || typeof input.normalization.terminalResponseProvenance !== "boolean"
    || !["single", "batch"].includes(input.normalization.toolCallBatching)
  ) {
    pluginError("invalid_manifest", `provider "${input.id}" normalization contract is invalid`);
  }
  if (
    !input.metering
    || !["provider-reported", "client-measured", "mixed", "unavailable"].includes(
      input.metering.usage,
    )
    || typeof input.metering.rawUsageRetained !== "boolean"
    || ![
      "none",
      "wire-observations",
      "provider-receipts",
      "wire-and-provider-receipts",
    ].includes(input.metering.evidence)
  ) {
    pluginError("invalid_manifest", `provider "${input.id}" metering contract is invalid`);
  }

  return Object.freeze({
    contractVersion: REALTIME_PROVIDER_PLUGIN_CONTRACT_VERSION,
    id: input.id,
    label: input.label,
    docsUrl: docsUrl.href,
    defaultModel: input.defaultModel,
    defaultVoice: input.defaultVoice,
    environment,
    lifecycle: Object.freeze({ ...input.lifecycle }),
    transports: Object.freeze({ browser, server }),
    mediaProfiles,
    telephony: Object.freeze({
      support: input.telephony.support,
      ingressMediaProfileIds: telephonyIngressMedia,
      providerMediaProfileIds: telephonyProviderMedia,
      notes: telephonyNotes,
    }),
    tools: Object.freeze({ ...input.tools }),
    normalization: Object.freeze({ ...input.normalization }),
    metering: Object.freeze({ ...input.metering }),
  });
}

/** Validates and detaches all declarative metadata before registration. */
export function defineRealtimeProviderPlugin(
  input: RealtimeProviderPlugin,
): RealtimeProviderPlugin {
  if (!input || typeof input !== "object") {
    pluginError("invalid_plugin", "realtime provider plugin is required");
  }
  const manifest = snapshotManifest(input.manifest);
  if (typeof input.validateSession !== "function") {
    pluginError("invalid_plugin", `provider "${manifest.id}" needs validateSession`);
  }
  if (typeof input.createEventNormalizer !== "function") {
    pluginError("invalid_plugin", `provider "${manifest.id}" needs createEventNormalizer`);
  }
  if (typeof input.encodeToolResults !== "function") {
    pluginError("invalid_plugin", `provider "${manifest.id}" needs encodeToolResults`);
  }
  const hasBrowserFactory = typeof input.browser?.create === "function";
  const hasServerFactory = typeof input.server?.create === "function";
  if (manifest.transports.browser.length > 0 !== hasBrowserFactory) {
    pluginError(
      "invalid_plugin",
      `provider "${manifest.id}" browser transport/factory declarations disagree`,
    );
  }
  if (manifest.transports.server.length > 0 !== hasServerFactory) {
    pluginError(
      "invalid_plugin",
      `provider "${manifest.id}" server transport/factory declarations disagree`,
    );
  }
  return Object.freeze({
    manifest,
    validateSession: input.validateSession,
    ...(hasBrowserFactory
      ? { browser: Object.freeze({ create: input.browser!.create }) }
      : {}),
    ...(hasServerFactory
      ? { server: Object.freeze({ create: input.server!.create }) }
      : {}),
    createEventNormalizer: input.createEventNormalizer,
    encodeToolResults: input.encodeToolResults,
  });
}

function defaultCredentialReader(environmentName: string): Promise<string> {
  return Promise.reject(
    new RealtimeProviderPluginError(
      "credential_reader_required",
      `no credential reader was configured for ${environmentName}`,
    ),
  );
}

function deepFreezeDetached<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreezeDetached(child, seen);
  return Object.freeze(value);
}

function jsonEquivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEquivalent(value, right[index]));
  }
  if (
    typeof left !== "object"
    || left === null
    || typeof right !== "object"
    || right === null
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && jsonEquivalent(leftRecord[key], rightRecord[key])
    ));
}

function snapshotJsonValue(
  providerId: string,
  value: unknown,
  label: string,
): unknown {
  const seen = new WeakSet<object>();
  const validate = (candidate: unknown, depth: number): void => {
    if (depth > 64) {
      pluginError("invalid_tool_results", `provider "${providerId}" ${label} is too deep`);
    }
    if (
      candidate === null
      || typeof candidate === "string"
      || typeof candidate === "boolean"
      || (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return;
    }
    if (typeof candidate !== "object") {
      pluginError(
        "invalid_tool_results",
        `provider "${providerId}" ${label} is not strict JSON`,
      );
    }
    if (seen.has(candidate)) {
      pluginError(
        "invalid_tool_results",
        `provider "${providerId}" ${label} is cyclic`,
      );
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) validate(item, depth + 1);
      return;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (
      (prototype !== Object.prototype && prototype !== null)
      || Object.getOwnPropertySymbols(candidate).length
    ) {
      pluginError(
        "invalid_tool_results",
        `provider "${providerId}" ${label} is not a plain JSON object`,
      );
    }
    for (const child of Object.values(candidate)) validate(child, depth + 1);
  };
  validate(value, 0);
  return deepFreezeDetached(structuredClone(value));
}

function snapshotSession(
  providerId: string,
  value: RealtimeProviderPluginSessionSpec,
): RealtimeProviderPluginSessionSpec {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    pluginError(
      "invalid_session",
      `provider "${providerId}" session is not JSON serializable`,
    );
  }
  if (
    serialized === undefined
    || new TextEncoder().encode(serialized).byteLength > MAX_SESSION_BYTES
  ) {
    pluginError(
      "invalid_session",
      `provider "${providerId}" session exceeds ${MAX_SESSION_BYTES} bytes`,
    );
  }
  const snapshot = JSON.parse(serialized) as RealtimeProviderPluginSessionSpec;
  return deepFreezeDetached(snapshot);
}

export class RealtimeProviderPluginRegistry {
  private readonly plugins = new Map<string, RealtimeProviderPlugin>();

  register(input: RealtimeProviderPlugin): RealtimeProviderPlugin {
    if (this.plugins.size >= MAX_PROVIDERS) {
      pluginError("registry_full", `provider registry exceeds ${MAX_PROVIDERS} entries`);
    }
    const plugin = defineRealtimeProviderPlugin(input);
    if (this.plugins.has(plugin.manifest.id)) {
      pluginError("duplicate_provider", `duplicate provider "${plugin.manifest.id}"`);
    }
    this.plugins.set(plugin.manifest.id, plugin);
    return plugin;
  }

  registerAll(inputs: readonly RealtimeProviderPlugin[]): readonly RealtimeProviderPlugin[] {
    if (!Array.isArray(inputs)) pluginError("invalid_plugin", "provider plugins must be an array");
    const registered: RealtimeProviderPlugin[] = [];
    try {
      for (const input of inputs) registered.push(this.register(input));
      return Object.freeze(registered);
    } catch (error) {
      for (const plugin of registered) this.plugins.delete(plugin.manifest.id);
      throw error;
    }
  }

  get(id: string): RealtimeProviderPlugin {
    const plugin = this.plugins.get(id);
    if (!plugin) pluginError("unknown_provider", `unknown realtime provider "${id}"`);
    return plugin;
  }

  manifests(): readonly RealtimeProviderManifest[] {
    return Object.freeze(
      [...this.plugins.values()]
        .map(({ manifest }) => manifest)
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  }

  createEventNormalizer(
    providerId: string,
    mediaProfileId: string,
  ): RealtimeProviderEventNormalizer {
    const plugin = this.get(providerId);
    if (!plugin.manifest.mediaProfiles.some(({ id }) => id === mediaProfileId)) {
      pluginError(
        "unsupported_media",
        `provider "${providerId}" does not declare media profile "${mediaProfileId}"`,
      );
    }
    const normalizer = plugin.createEventNormalizer(mediaProfileId);
    if (!normalizer || typeof normalizer.push !== "function") {
      pluginError(
        "invalid_normalizer",
        `provider "${providerId}" returned an invalid event normalizer`,
      );
    }
    const settledCallIds = new Set<string>();
    return Object.freeze({
      push(input: unknown) {
        const events = normalizer.push(input);
        if (
          !Array.isArray(events)
          || events.length > MAX_NORMALIZED_EVENTS_PER_FRAME
        ) {
          pluginError(
            "invalid_normalized_event",
            `provider "${providerId}" emitted an invalid event batch`,
          );
        }
        return Object.freeze(events.map((emittedEvent, index) => {
          let event: typeof emittedEvent;
          try {
            event = structuredClone(emittedEvent);
          } catch {
            pluginError(
              "invalid_normalized_event",
              `provider "${providerId}" emitted non-cloneable event ${index + 1}`,
            );
          }
          if (
            !event
            || typeof event !== "object"
            || event.schemaVersion !== REALTIME_PROVIDER_NORMALIZED_EVENT_VERSION
            || event.providerId !== providerId
            || typeof event.type !== "string"
            || !event.type.trim()
            || typeof event.receivedAtMs !== "number"
            || !Number.isFinite(event.receivedAtMs)
            || typeof event.wireType !== "string"
            || !event.wireType.trim()
            || !event.data
            || typeof event.data !== "object"
            || Array.isArray(event.data)
          ) {
            pluginError(
              "invalid_normalized_event",
              `provider "${providerId}" emitted invalid event ${index + 1}`,
            );
          }
          if (
            event.responseId !== undefined
            && (typeof event.responseId !== "string" || !event.responseId)
          ) {
            pluginError(
              "invalid_normalized_event",
              `provider "${providerId}" emitted an invalid response identity`,
            );
          }
          if (event.type === "tool.calls") {
            if (
              !event.responseId
              || !Array.isArray(event.toolCalls)
              || !event.toolCalls.length
            ) {
              pluginError(
                "invalid_normalized_event",
                `provider "${providerId}" tool.calls omitted calls`,
              );
            }
            const callIds = new Set<string>();
            for (const call of event.toolCalls) {
              if (
                !call
                || typeof call.callId !== "string"
                || !call.callId
                || typeof call.responseId !== "string"
                || !call.responseId
                || typeof call.name !== "string"
                || !call.name
                || typeof call.argumentsText !== "string"
                || new TextEncoder().encode(call.argumentsText).byteLength
                  > MAX_TOOL_ARGUMENT_BYTES
                || typeof call.terminalWireType !== "string"
                || !call.terminalWireType
                || call.responseId !== event.responseId
              ) {
                pluginError(
                  "invalid_normalized_event",
                  `provider "${providerId}" emitted an invalid tool call`,
                );
              }
              let parsedArguments: unknown;
              let parsed = true;
              try {
                parsedArguments = JSON.parse(call.argumentsText);
              } catch {
                parsed = false;
              }
              if (
                (parsed && call.argumentsJson === null)
                || (!parsed && call.argumentsJson !== null)
                || (
                  parsed
                  && call.argumentsJson !== null
                  && !jsonEquivalent(parsedArguments, call.argumentsJson)
                )
              ) {
                pluginError(
                  "invalid_normalized_event",
                  `provider "${providerId}" emitted contradictory arguments `
                  + `for tool call "${call.callId}"`,
                );
              }
              if (callIds.has(call.callId)) {
                pluginError(
                  "invalid_normalized_event",
                  `provider "${providerId}" repeated tool call "${call.callId}"`,
                );
              }
              callIds.add(call.callId);
              if (settledCallIds.has(call.callId)) {
                pluginError(
                  "invalid_normalized_event",
                  `provider "${providerId}" replayed tool call "${call.callId}"`,
                );
              }
              if (settledCallIds.size >= 10_000) {
                pluginError(
                  "invalid_normalized_event",
                  `provider "${providerId}" exceeded the tracked tool-call limit`,
                );
              }
              settledCallIds.add(call.callId);
            }
          } else if (event.toolCalls !== undefined) {
            pluginError(
              "invalid_normalized_event",
              `provider "${providerId}" attached tool calls to "${event.type}"`,
            );
          }
          return deepFreezeDetached({
            ...event,
            ...(event.toolCalls
              ? {
                  toolCalls: Object.freeze(
                    event.toolCalls.map(
                      (call: RealtimeProviderToolCall) => Object.freeze({ ...call }),
                    ),
                  ),
                }
              : {}),
            data: { ...event.data },
          });
        }));
      },
      ...(typeof normalizer.reset === "function"
        ? {
            reset: () => {
              settledCallIds.clear();
              normalizer.reset?.();
            },
          }
        : {}),
    });
  }

  encodeToolResults(
    providerId: string,
    results: readonly RealtimeProviderToolResult[],
  ): unknown {
    const plugin = this.get(providerId);
    if (
      !Array.isArray(results)
      || !results.length
      || results.length > MAX_TOOL_RESULTS_PER_BATCH
    ) {
      pluginError(
        "invalid_tool_results",
        `provider "${providerId}" tool result batch must contain 1 to `
        + `${MAX_TOOL_RESULTS_PER_BATCH} results`,
      );
    }
    const callIds = new Set<string>();
    const snapshot = results.map((result) => {
      if (
        !result
        || typeof result !== "object"
        || typeof result.callId !== "string"
        || !result.callId
      ) {
        pluginError(
          "invalid_tool_results",
          `provider "${providerId}" received an invalid tool result`,
        );
      }
      if (callIds.has(result.callId)) {
        pluginError(
          "invalid_tool_results",
          `provider "${providerId}" received duplicate result "${result.callId}"`,
        );
      }
      callIds.add(result.callId);
      const output = snapshotJsonValue(
        providerId,
        result.output,
        `tool result "${result.callId}"`,
      );
      return Object.freeze({ callId: result.callId, output });
    });
    let serialized: string;
    try {
      serialized = JSON.stringify(snapshot);
    } catch {
      pluginError(
        "invalid_tool_results",
        `provider "${providerId}" tool result batch is not JSON serializable`,
      );
    }
    if (
      serialized === undefined
      || new TextEncoder().encode(serialized).byteLength > MAX_TOOL_RESULT_BATCH_BYTES
    ) {
      pluginError(
        "invalid_tool_results",
        `provider "${providerId}" tool result batch exceeds `
        + `${MAX_TOOL_RESULT_BATCH_BYTES} bytes`,
      );
    }
    const encoded = plugin.encodeToolResults(Object.freeze(snapshot));
    try {
      const encodedJson = JSON.stringify(encoded);
      if (
        encodedJson === undefined
        || new TextEncoder().encode(encodedJson).byteLength > MAX_TOOL_RESULT_BATCH_BYTES
      ) {
        pluginError(
          "invalid_tool_results",
          `provider "${providerId}" encoded tool results exceed `
          + `${MAX_TOOL_RESULT_BATCH_BYTES} bytes`,
        );
      }
    } catch (error) {
      if (error instanceof RealtimeProviderPluginError) throw error;
      pluginError(
        "invalid_tool_results",
        `provider "${providerId}" encoded non-JSON tool results`,
      );
    }
    return encoded;
  }

  async createConnection(
    providerId: string,
    mode: RealtimeProviderExecutionMode,
    transport: RealtimeProviderTransportKind,
    mediaProfileId: string,
    session: RealtimeProviderPluginSessionSpec,
    options: RealtimeProviderRegistryCreateOptions = {},
  ): Promise<RealtimeProviderConnection> {
    const plugin = this.get(providerId);

    // Preflight is deliberately first. No plugin-owned validator, credential
    // callback, network callback, or transport factory runs for unsupported I/O.
    const declaration = plugin.manifest.transports[mode]
      .find((candidate) => candidate.kind === transport);
    if (!declaration) {
      pluginError(
        "unsupported_transport",
        `provider "${providerId}" does not support ${mode} ${transport}`,
      );
    }
    if (!declaration.mediaProfileIds.includes(mediaProfileId)) {
      pluginError(
        "unsupported_media",
        `provider "${providerId}" ${mode} ${transport} does not support "${mediaProfileId}"`,
      );
    }
    const factory = plugin[mode];
    if (!factory) {
      pluginError("invalid_plugin", `provider "${providerId}" is missing its ${mode} factory`);
    }

    const validation = plugin.validateSession(snapshotSession(providerId, session));
    if (!validation || validation.ok !== true) {
      const issues = validation && validation.ok === false ? validation.issues : [];
      const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
      pluginError(
        "invalid_session",
        `provider "${providerId}" rejected the session${detail ? ` (${detail})` : ""}`,
      );
    }
    const validatedSession = snapshotSession(providerId, validation.session);
    if (validatedSession.providerId !== providerId) {
      pluginError(
        "invalid_session",
        `provider "${providerId}" validator returned session for "${validatedSession.providerId}"`,
      );
    }

    const allowedCredentials = new Set(plugin.manifest.environment);
    const readCredential = options.readCredential ?? defaultCredentialReader;
    const context = Object.freeze({
      readCredential: async (environmentName: string) => {
        if (!allowedCredentials.has(environmentName)) {
          pluginError(
            "undeclared_credential",
            `provider "${providerId}" attempted undeclared credential "${environmentName}"`,
          );
        }
        return readCredential(environmentName);
      },
      fetch: options.fetch ?? globalThis.fetch,
      now: options.now ?? Date.now,
    });
    if (typeof context.fetch !== "function") {
      pluginError("missing_fetch", "a fetch implementation is required");
    }

    const connection = await factory.create(
      Object.freeze({
        session: validatedSession,
        transport,
        mediaProfileId,
      }),
      context,
    );
    if (
      !connection
      || connection.providerId !== providerId
      || connection.mode !== mode
      || connection.transport !== transport
      || connection.mediaProfileId !== mediaProfileId
    ) {
      pluginError(
        "invalid_connection",
        `provider "${providerId}" returned connection metadata that does not match the request`,
      );
    }
    return Object.freeze({ ...connection });
  }
}

export function createRealtimeProviderPluginRegistry(
  plugins: readonly RealtimeProviderPlugin[] = [],
): RealtimeProviderPluginRegistry {
  const registry = new RealtimeProviderPluginRegistry();
  registry.registerAll(plugins);
  return registry;
}
