import "server-only";

import { geminiAdapter } from "./providers/gemini";
import { openaiAdapter } from "./providers/openai";
import { xaiAdapter } from "./providers/xai";
import { isAuthorizedLocalDeploymentBrowserFunding } from "./browser-funding-authority";
import type {
  BrowserProviderFundingAuthority,
  BrowserRealtimeConnection,
  LocalDeploymentBrowserFundingAuthority,
  ProviderCapabilities,
  ProviderDefinition,
  RealtimeAudioFormat,
  RealtimeProviderAdapter,
  ServerRealtimeConnection,
  VoiceProviderId,
  VoiceSessionSpec,
} from "./types";

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_PROVIDERS = 64;
const MAX_ENVIRONMENT_NAMES = 32;
const MAX_NOTES = 32;
const MAX_TEXT_LENGTH = 8_192;

export type RegisteredVoiceSessionSpec<Id extends string = string> =
  Omit<VoiceSessionSpec, "provider" | "experimentalProviderNativeResumption"> & {
    provider: Id;
    experimentalProviderNativeResumption?: Omit<
      NonNullable<VoiceSessionSpec["experimentalProviderNativeResumption"]>,
      "provider"
    > & { provider: Id };
  };

export type RegisteredBrowserRealtimeConnection<Id extends string = string> = {
  provider: Id;
  model: string;
  voice: string;
  transport: "websocket" | "webrtc";
  [key: string]: unknown;
};

export type RegisteredBrowserProviderRootCredential<Id extends string = string> =
  Readonly<{
    source: "tenant_byok";
    provider: Id;
    apiKey: string;
  }>;

export type RegisteredBrowserFundingAuthority<Id extends string = string> =
  | RegisteredBrowserProviderRootCredential<Id>
  | (
      Id extends VoiceProviderId
        ? LocalDeploymentBrowserFundingAuthority<Id>
        : never
    );

type AnyRegisteredBrowserFundingAuthority =
  | RegisteredBrowserProviderRootCredential<string>
  | LocalDeploymentBrowserFundingAuthority;

export type RegisteredServerRealtimeConnection<Id extends string = string> = {
  provider: Id;
  model: string;
  voice: string;
  wsUrl: string;
  headers: Record<string, string>;
  sessionUpdate: Record<string, unknown>;
  wireProtocol: "openai-realtime";
};

export type RegisteredServerRealtimeEndpoint<Id extends string = string> = {
  provider: Id;
  wsUrl: string;
};

/**
 * Server-side adapter contract for a self-hosted provider extension.
 *
 * An extension can use its own string-literal provider ID without widening the
 * built-in `VoiceProviderId` union. The application still owns how that ID is
 * selected and how its browser connection payload is consumed.
 */
export type RealtimeProviderRegistration<Id extends string = string> = {
  id: Id;
  label: string;
  defaultModel: string;
  defaultVoice: string;
  env: readonly string[];
  capabilities: ProviderCapabilities;
  createBrowserConnection(
    spec: RegisteredVoiceSessionSpec<Id>,
    fundingAuthority: RegisteredBrowserFundingAuthority<Id>,
  ): Promise<RegisteredBrowserRealtimeConnection<Id>>;
  createServerConnection(
    spec: RegisteredVoiceSessionSpec<Id>,
    audio: RealtimeAudioFormat,
  ): Promise<RegisteredServerRealtimeConnection<Id>>;
  buildSessionUpdate(
    spec: RegisteredVoiceSessionSpec<Id>,
    audio: RealtimeAudioFormat,
  ): Record<string, unknown>;
  /**
   * Direct PCM μ-law telephony endpoint. It is required exactly when the
   * manifest advertises `native-pcmu`; transcoding providers must omit it.
   */
  serverRealtimeEndpoint?(
    spec: RegisteredVoiceSessionSpec<Id>,
  ): RegisteredServerRealtimeEndpoint<Id>;
};

export type RegisteredProviderDefinition<Id extends string = string> =
  Omit<ProviderDefinition, "id" | "env"> & {
    id: Id;
    env: readonly string[];
  };

export class RealtimeProviderRegistryError extends Error {
  constructor(
    readonly code:
      | "builtin_provider"
      | "capability_mismatch"
      | "duplicate_provider"
      | "invalid_adapter"
      | "registry_full"
      | "unknown_provider",
    message: string,
  ) {
    super(message);
    this.name = "RealtimeProviderRegistryError";
  }
}

function registryError(
  code: RealtimeProviderRegistryError["code"],
  message: string,
): never {
  throw new RealtimeProviderRegistryError(code, message);
}

function assertText(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > MAX_TEXT_LENGTH
    || /[\u0000\u007f]/.test(value)
  ) {
    registryError("invalid_adapter", `${label} must be non-empty bounded text`);
  }
}

function snapshotCapabilities(
  id: string,
  value: ProviderCapabilities,
): ProviderCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    registryError("invalid_adapter", `provider "${id}" capabilities are required`);
  }
  if (value.browser !== "websocket" && value.browser !== "webrtc") {
    registryError("invalid_adapter", `provider "${id}" has an invalid browser transport`);
  }
  if (
    value.telephony !== "native-pcmu"
    && value.telephony !== "requires-transcoding"
  ) {
    registryError("invalid_adapter", `provider "${id}" has an invalid telephony capability`);
  }
  if (typeof value.remoteMcp !== "boolean" || typeof value.clientFunctions !== "boolean") {
    registryError("invalid_adapter", `provider "${id}" has invalid tool capabilities`);
  }
  if (
    !value.sessionResumption
    || typeof value.sessionResumption !== "object"
    || typeof value.sessionResumption.supported !== "boolean"
    || typeof value.sessionResumption.enabledByDefault !== "boolean"
  ) {
    registryError("invalid_adapter", `provider "${id}" has invalid resumption capabilities`);
  }
  if (
    value.sessionResumption.enabledByDefault
    && !value.sessionResumption.supported
  ) {
    registryError(
      "capability_mismatch",
      `provider "${id}" enables session resumption without supporting it`,
    );
  }
  if (!Array.isArray(value.notes) || value.notes.length > MAX_NOTES) {
    registryError("invalid_adapter", `provider "${id}" capability notes are invalid`);
  }
  const notes = [...value.notes];
  for (const [index, note] of notes.entries()) {
    assertText(note, `provider "${id}" capability note ${index + 1}`);
  }
  return Object.freeze({
    browser: value.browser,
    telephony: value.telephony,
    remoteMcp: value.remoteMcp,
    clientFunctions: value.clientFunctions,
    sessionResumption: Object.freeze({ ...value.sessionResumption }),
    notes: Object.freeze(notes),
  });
}

function isPublicWssEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "wss:"
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && !url.hash;
  } catch {
    return false;
  }
}

function snapshotAdapter<Id extends string>(
  input: RealtimeProviderRegistration<Id>,
): Readonly<RealtimeProviderRegistration<Id>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    registryError("invalid_adapter", "realtime provider adapter is required");
  }
  if (typeof input.id !== "string" || !PROVIDER_ID.test(input.id)) {
    registryError("invalid_adapter", `invalid provider ID "${String(input.id)}"`);
  }
  assertText(input.label, `provider "${input.id}" label`);
  assertText(input.defaultModel, `provider "${input.id}" default model`);
  assertText(input.defaultVoice, `provider "${input.id}" default voice`);
  if (!Array.isArray(input.env) || input.env.length > MAX_ENVIRONMENT_NAMES) {
    registryError("invalid_adapter", `provider "${input.id}" environment must be an array`);
  }
  const env = [...input.env].sort();
  if (
    env.some((name) => typeof name !== "string" || !ENVIRONMENT_NAME.test(name))
    || env.some((name, index) => name === env[index - 1])
  ) {
    registryError(
      "invalid_adapter",
      `provider "${input.id}" environment names must be unique uppercase identifiers`,
    );
  }
  for (const hook of [
    "createBrowserConnection",
    "createServerConnection",
    "buildSessionUpdate",
  ] as const) {
    if (typeof input[hook] !== "function") {
      registryError("invalid_adapter", `provider "${input.id}" is missing ${hook}`);
    }
  }
  if (
    input.serverRealtimeEndpoint !== undefined
    && typeof input.serverRealtimeEndpoint !== "function"
  ) {
    registryError(
      "invalid_adapter",
      `provider "${input.id}" has an invalid serverRealtimeEndpoint`,
    );
  }
  const capabilities = snapshotCapabilities(input.id, input.capabilities);
  if (
    capabilities.telephony === "native-pcmu"
    && !input.serverRealtimeEndpoint
  ) {
    registryError(
      "capability_mismatch",
      `provider "${input.id}" advertises native-pcmu without a direct endpoint`,
    );
  }
  if (
    capabilities.telephony === "requires-transcoding"
    && input.serverRealtimeEndpoint
  ) {
    registryError(
      "capability_mismatch",
      `provider "${input.id}" requires transcoding and cannot advertise a direct PCM μ-law endpoint`,
    );
  }
  return Object.freeze({
    ...input,
    env: Object.freeze(env),
    capabilities,
  });
}

function assertSessionProvider(
  expectedId: string,
  spec: RegisteredVoiceSessionSpec,
): void {
  if (!spec || spec.provider !== expectedId) {
    registryError(
      "capability_mismatch",
      `provider "${expectedId}" received a session for "${String(spec?.provider)}"`,
    );
  }
}

function assertBrowserConnection<Id extends string>(
  adapter: Readonly<RealtimeProviderRegistration<Id>>,
  spec: RegisteredVoiceSessionSpec<Id>,
  connection: RegisteredBrowserRealtimeConnection<Id>,
): void {
  if (
    !connection
    || typeof connection !== "object"
    || connection.provider !== adapter.id
    || connection.model !== spec.model
    || connection.voice !== spec.voice
    || connection.transport !== adapter.capabilities.browser
  ) {
    registryError(
      "capability_mismatch",
      `provider "${adapter.id}" returned browser metadata outside its registered capabilities`,
    );
  }
}

function assertBrowserFundingAuthority<Id extends string>(
  spec: RegisteredVoiceSessionSpec<Id>,
  authority: AnyRegisteredBrowserFundingAuthority,
): void {
  if (authority?.source === "tenant_byok") {
    if (
      authority.provider === spec.provider
      && spec.provider !== "gemini"
      && typeof authority.apiKey === "string"
      && Buffer.byteLength(authority.apiKey, "utf8") >= 16
      && Buffer.byteLength(authority.apiKey, "utf8") <= 4 * 1024
      && authority.apiKey.trim() === authority.apiKey
      && !/[\u0000-\u001f\u007f]/.test(authority.apiKey)
    ) return;
    registryError(
      "capability_mismatch",
      `provider "${spec.provider}" received an invalid browser funding authority`,
    );
  }
  if (
    (spec.provider === "xai"
      || spec.provider === "openai"
      || spec.provider === "gemini")
    && isAuthorizedLocalDeploymentBrowserFunding(
      authority,
      spec.provider as VoiceProviderId,
    )
  ) return;
  registryError(
    "capability_mismatch",
    `provider "${spec.provider}" received an invalid browser funding authority`,
  );
}

function assertServerConnection<Id extends string>(
  adapter: Readonly<RealtimeProviderRegistration<Id>>,
  spec: RegisteredVoiceSessionSpec<Id>,
  connection: RegisteredServerRealtimeConnection<Id>,
): void {
  if (
    !connection
    || typeof connection !== "object"
    || connection.provider !== adapter.id
    || connection.model !== spec.model
    || connection.voice !== spec.voice
    || connection.wireProtocol !== "openai-realtime"
    || !isPublicWssEndpoint(connection.wsUrl)
    || !connection.headers
    || typeof connection.headers !== "object"
    || Array.isArray(connection.headers)
    || Object.values(connection.headers).some((value) => typeof value !== "string")
    || !connection.sessionUpdate
    || typeof connection.sessionUpdate !== "object"
    || Array.isArray(connection.sessionUpdate)
  ) {
    registryError(
      "capability_mismatch",
      `provider "${adapter.id}" returned an invalid server connection`,
    );
  }
}

export class RealtimeProviderRegistry {
  private readonly adapters = new Map<
    string,
    Readonly<RealtimeProviderRegistration>
  >();
  private readonly builtInIds = new Set<string>();

  constructor(
    adapters: readonly RealtimeProviderRegistration[] = [],
    options: { protect?: readonly string[] } = {},
  ) {
    this.registerAll(adapters);
    for (const id of options.protect ?? []) {
      if (!this.adapters.has(id)) {
        registryError("unknown_provider", `cannot protect unknown provider "${id}"`);
      }
      this.builtInIds.add(id);
    }
  }

  register<Id extends string>(
    input: RealtimeProviderRegistration<Id>,
  ): Readonly<RealtimeProviderRegistration<Id>> {
    if (this.adapters.size >= MAX_PROVIDERS) {
      registryError("registry_full", `provider registry exceeds ${MAX_PROVIDERS} entries`);
    }
    const adapter = snapshotAdapter(input);
    if (this.adapters.has(adapter.id)) {
      registryError("duplicate_provider", `duplicate provider "${adapter.id}"`);
    }
    this.adapters.set(
      adapter.id,
      adapter as Readonly<RealtimeProviderRegistration>,
    );
    return adapter;
  }

  registerAll(
    inputs: readonly RealtimeProviderRegistration[],
  ): readonly Readonly<RealtimeProviderRegistration>[] {
    if (!Array.isArray(inputs)) {
      registryError("invalid_adapter", "realtime provider adapters must be an array");
    }
    const registered: Readonly<RealtimeProviderRegistration>[] = [];
    try {
      for (const input of inputs) registered.push(this.register(input));
      return Object.freeze(registered);
    } catch (error) {
      for (const adapter of registered) this.adapters.delete(adapter.id);
      throw error;
    }
  }

  unregister<Id extends string>(
    id: Id,
  ): Readonly<RealtimeProviderRegistration<Id>> | undefined {
    if (this.builtInIds.has(id)) {
      registryError("builtin_provider", `built-in provider "${id}" cannot be unregistered`);
    }
    const adapter = this.adapters.get(id);
    if (!adapter) return undefined;
    this.adapters.delete(id);
    return adapter as Readonly<RealtimeProviderRegistration<Id>>;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  get<Id extends string>(id: Id): Readonly<RealtimeProviderRegistration<Id>> {
    const adapter = this.adapters.get(id);
    if (!adapter) registryError("unknown_provider", `unknown realtime provider "${id}"`);
    return adapter as Readonly<RealtimeProviderRegistration<Id>>;
  }

  catalog(): readonly RegisteredProviderDefinition[] {
    return Object.freeze(
      [...this.adapters.values()]
        .map((adapter) => Object.freeze({
          id: adapter.id,
          label: adapter.label,
          defaultModel: adapter.defaultModel,
          defaultVoice: adapter.defaultVoice,
          env: adapter.env,
          capabilities: adapter.capabilities,
        })),
    );
  }

  async createBrowserConnection<Id extends string>(
    spec: RegisteredVoiceSessionSpec<Id>,
    fundingAuthority: RegisteredBrowserFundingAuthority<NoInfer<Id>>,
  ): Promise<RegisteredBrowserRealtimeConnection<Id>> {
    const adapter = this.get(spec.provider);
    assertSessionProvider(adapter.id, spec);
    assertBrowserFundingAuthority(
      spec,
      fundingAuthority as AnyRegisteredBrowserFundingAuthority,
    );
    const connection = await adapter.createBrowserConnection(
      spec,
      fundingAuthority,
    );
    if (
      fundingAuthority.source === "tenant_byok"
      && JSON.stringify(connection).includes(fundingAuthority.apiKey)
    ) {
      registryError(
        "capability_mismatch",
        `provider "${adapter.id}" exposed its browser funding authority`,
      );
    }
    assertBrowserConnection(adapter, spec, connection);
    return connection;
  }

  async createServerConnection<Id extends string>(
    spec: RegisteredVoiceSessionSpec<Id>,
    audio: RealtimeAudioFormat,
  ): Promise<RegisteredServerRealtimeConnection<Id>> {
    const adapter = this.get(spec.provider);
    assertSessionProvider(adapter.id, spec);
    const connection = await adapter.createServerConnection(spec, audio);
    assertServerConnection(adapter, spec, connection);
    return connection;
  }

  buildSessionUpdate<Id extends string>(
    spec: RegisteredVoiceSessionSpec<Id>,
    audio: RealtimeAudioFormat,
  ): Record<string, unknown> {
    const adapter = this.get(spec.provider);
    assertSessionProvider(adapter.id, spec);
    const update = adapter.buildSessionUpdate(spec, audio);
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      registryError(
        "capability_mismatch",
        `provider "${adapter.id}" returned an invalid session update`,
      );
    }
    return update;
  }

  serverEndpoint<Id extends string>(
    spec: RegisteredVoiceSessionSpec<Id>,
  ): RegisteredServerRealtimeEndpoint<Id> {
    const adapter = this.get(spec.provider);
    assertSessionProvider(adapter.id, spec);
    if (
      adapter.capabilities.telephony !== "native-pcmu"
      || !adapter.serverRealtimeEndpoint
    ) {
      registryError(
        "capability_mismatch",
        `provider "${adapter.id}" requires a transcoding bridge; direct Twilio μ-law passthrough is unavailable`,
      );
    }
    const endpoint = adapter.serverRealtimeEndpoint(spec);
    if (
      !endpoint
      || endpoint.provider !== adapter.id
      || !isPublicWssEndpoint(endpoint.wsUrl)
    ) {
      registryError(
        "capability_mismatch",
        `provider "${adapter.id}" returned an invalid direct telephony endpoint`,
      );
    }
    return endpoint;
  }
}

function builtInRegistration(
  adapter: RealtimeProviderAdapter,
): RealtimeProviderRegistration {
  const serverRealtimeEndpoint = adapter.capabilities.telephony === "native-pcmu"
    ? (spec: RegisteredVoiceSessionSpec) => ({
        provider: adapter.id,
        wsUrl: adapter.id === "xai"
          ? `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(spec.model)}`
          : `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(spec.model)}`,
      })
    : undefined;
  return {
    ...adapter,
    ...(serverRealtimeEndpoint ? { serverRealtimeEndpoint } : {}),
  } as unknown as RealtimeProviderRegistration;
}

const BUILT_IN_REGISTRATIONS = Object.freeze([
  builtInRegistration(xaiAdapter),
  builtInRegistration(openaiAdapter),
  builtInRegistration(geminiAdapter),
]);

const registry = new RealtimeProviderRegistry(BUILT_IN_REGISTRATIONS, {
  protect: BUILT_IN_REGISTRATIONS.map(({ id }) => id),
});

/** Install a self-hosted provider during server bootstrap, before serving calls. */
export function registerRealtimeProvider<Id extends string>(
  adapter: RealtimeProviderRegistration<Id>,
): Readonly<RealtimeProviderRegistration<Id>> {
  return registry.register(adapter);
}

/** Remove a self-hosted provider. Built-ins are deliberately protected. */
export function unregisterRealtimeProvider<Id extends string>(
  id: Id,
): Readonly<RealtimeProviderRegistration<Id>> | undefined {
  return registry.unregister(id);
}

export function realtimeProvider(id: VoiceProviderId): RealtimeProviderAdapter;
export function realtimeProvider<Id extends string>(
  id: Id,
): Readonly<RealtimeProviderRegistration<Id>>;
export function realtimeProvider(
  id: string,
): RealtimeProviderAdapter | Readonly<RealtimeProviderRegistration> {
  return registry.get(id) as RealtimeProviderAdapter;
}

export function providerCatalog(): readonly RegisteredProviderDefinition[] {
  return registry.catalog();
}

export function createBrowserRealtimeConnection<Id extends VoiceProviderId>(
  spec: VoiceSessionSpec & { provider: Id },
  fundingAuthority: BrowserProviderFundingAuthority<NoInfer<Id>>,
): Promise<BrowserRealtimeConnection>;
export function createBrowserRealtimeConnection<Id extends string>(
  spec: RegisteredVoiceSessionSpec<Id>,
  fundingAuthority: RegisteredBrowserFundingAuthority<NoInfer<Id>>,
): Promise<RegisteredBrowserRealtimeConnection<Id>>;
export function createBrowserRealtimeConnection(
  spec: RegisteredVoiceSessionSpec,
  fundingAuthority: AnyRegisteredBrowserFundingAuthority,
): Promise<RegisteredBrowserRealtimeConnection> {
  return registry.createBrowserConnection<string>(
    spec,
    fundingAuthority as RegisteredBrowserProviderRootCredential<string>,
  );
}

export function createServerRealtimeConnection(
  spec: VoiceSessionSpec,
  audio: RealtimeAudioFormat,
): Promise<ServerRealtimeConnection>;
export function createServerRealtimeConnection<Id extends string>(
  spec: RegisteredVoiceSessionSpec<Id>,
  audio: RealtimeAudioFormat,
): Promise<RegisteredServerRealtimeConnection<Id>>;
export function createServerRealtimeConnection(
  spec: RegisteredVoiceSessionSpec,
  audio: RealtimeAudioFormat,
): Promise<RegisteredServerRealtimeConnection> {
  return registry.createServerConnection(spec, audio);
}

export function buildProviderSessionUpdate(
  spec: VoiceSessionSpec,
  audio: RealtimeAudioFormat,
): Record<string, unknown>;
export function buildProviderSessionUpdate<Id extends string>(
  spec: RegisteredVoiceSessionSpec<Id>,
  audio: RealtimeAudioFormat,
): Record<string, unknown>;
export function buildProviderSessionUpdate(
  spec: RegisteredVoiceSessionSpec,
  audio: RealtimeAudioFormat,
): Record<string, unknown> {
  return registry.buildSessionUpdate(spec, audio);
}

/** Public connection metadata for a separately deployed bridge; provider keys stay on that bridge. */
export function serverRealtimeEndpoint(
  spec: VoiceSessionSpec,
): { provider: "xai" | "openai"; wsUrl: string };
export function serverRealtimeEndpoint<Id extends string>(
  spec: RegisteredVoiceSessionSpec<Id>,
): RegisteredServerRealtimeEndpoint<Id>;
export function serverRealtimeEndpoint(
  spec: RegisteredVoiceSessionSpec,
): RegisteredServerRealtimeEndpoint {
  return registry.serverEndpoint(spec);
}
