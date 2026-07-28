# Realtime provider plugins

The v1 plugin contract lets a voice provider join Harsha's Amazing Call Center
without adding another provider branch to a central switch.

Import the browser-safe contract, registry, and conformance kit from:

```ts
import {
  createRealtimeProviderPluginRegistry,
  runRealtimeProviderPluginConformance,
  type RealtimeProviderPlugin,
} from "@/lib/realtime/plugins";
```

Server code can additionally import the current OpenAI, xAI, and Gemini adapter
wrappers:

```ts
import {
  BUILT_IN_REALTIME_PROVIDER_PLUGINS,
  readRealtimeProviderEnvironmentCredential,
} from "@/lib/realtime/plugins/server";
```

The server-only entrypoint is intentionally separate. Importing the ordinary
plugin barrel does not pull credential-bearing adapters into browser bundles.

## Install in a self-hosted runtime

The plugin contract owns wire normalization and conformance. The application
runtime uses a smaller server adapter for token minting, session updates, and
telephony bridge metadata. Install that adapter once during server bootstrap:

```ts
import {
  registerRealtimeProvider,
  type RealtimeProviderRegistration,
} from "@/lib/realtime/registry";

const communitySip = {
  id: "community-sip",
  label: "Community SIP",
  defaultModel: "community-realtime-v1",
  defaultVoice: "river",
  env: ["COMMUNITY_SIP_TOKEN"],
  capabilities: {
    browser: "websocket",
    telephony: "requires-transcoding",
    remoteMcp: false,
    clientFunctions: true,
    sessionResumption: { supported: false, enabledByDefault: false },
    notes: ["Browser connections use short-lived, server-minted tokens."],
  },
  createBrowserConnection: async (session) => {
    // Mint an ephemeral token on the server. Never return COMMUNITY_SIP_TOKEN.
    return {
      provider: "community-sip",
      model: session.model,
      voice: session.voice,
      transport: "websocket",
      wsUrl: "wss://voice.example.test/realtime",
      token: "short-lived-token",
    };
  },
  createServerConnection: async (session) => ({
    provider: "community-sip",
    model: session.model,
    voice: session.voice,
    wsUrl: "wss://voice.example.test/realtime",
    headers: {},
    sessionUpdate: { type: "session.update" },
    wireProtocol: "openai-realtime",
  }),
  buildSessionUpdate: (session) => ({
    type: "session.update",
    model: session.model,
  }),
} satisfies RealtimeProviderRegistration<"community-sip">;

registerRealtimeProvider(communitySip);
```

Registration is atomic and fail-closed. IDs are bounded kebab-case strings;
environment names are unique uppercase identifiers; metadata is detached and
frozen; duplicate IDs and capability contradictions are rejected. Bundled
providers cannot be unregistered. A self-hosted extension can be removed with
`unregisterRealtimeProvider("community-sip")`.

The runtime validates that returned provider/model/voice/transport metadata
matches the registration. `native-pcmu` additionally requires a direct `wss:`
endpoint; `requires-transcoding` must omit it. These checks catch manifest
drift, but they do not prove live network or audio compatibility.
Registered WSS URLs cannot contain userinfo or fragments; put server
credentials in headers and expose only ephemeral browser credentials.

`registry.ts` is `server-only`. A custom browser provider also needs a
client-side consumer for its public ephemeral connection shape. Keep adapter
implementations, credential reads, and registration imports out of client
components.

## Contract boundary

Every plugin declares an immutable `contractVersion: "1.0"` manifest that binds:

- provider ID, defaults, public documentation, credential names, and maturity;
- browser/server transports and the exact media profiles each transport accepts;
- native-media, transcoding-bridge, or unsupported telephony behavior, with
  separate PSTN ingress and provider-side media profiles;
- tool delivery and provider-neutral tool-call normalization;
- usage-metering source and available evidence.

The plugin supplies session validation, browser/server factories, an event
normalizer, and a tool-result encoder. The registry rejects unknown transports
and media before calling plugin-owned validation, credential readers, factories,
or injected network access. It validates sessions before exposing a lazy,
manifest-scoped credential reader.

```ts
const registry = createRealtimeProviderPluginRegistry([
  ...BUILT_IN_REALTIME_PROVIDER_PLUGINS,
  communityProviderPlugin,
]);

const connection = await registry.createConnection(
  "community-provider",
  "server",
  "websocket",
  "pcmu-8k-mono",
  session,
  { readCredential: readRealtimeProviderEnvironmentCredential },
);
```

Use `registry.createEventNormalizer(...)` and
`registry.encodeToolResults(...)`, rather than invoking plugin hooks directly,
to retain runtime validation of provider identity, event shape, tool-call
identity, duplicate results, JSON safety, and batch bounds.

## Conformance

`runRealtimeProviderPluginConformance(plugin, fixture)` is a dependency-free
baseline smoke conformance kit. It checks:

1. manifest and factory consistency;
2. one valid supported connection with fake declared credentials;
3. invalid-session rejection before credential access;
4. unsupported transport/media rejection before plugin code;
5. normalized event/tool-call shape and JSON-safe tool-result encoding.

The supplied network function throws, so a cooperative factory cannot make a
live request through its injected context. This smoke does not exhaustively
prove every manifest capability. The repository test registers the three
current wrappers and a synthetic fourth provider, then runs the kit.

## Current boundary

The OpenAI, xAI, and Gemini exports are transitional wrappers around the
existing adapters. They make the normalized plugin catalog and conformance
surface available while the protected runtime registry preserves existing
browser and bridge behavior. Those legacy adapters still own their existing
environment and network access. A direct v1 plugin should use only
`context.readCredential` and `context.fetch`; its server-facing runtime adapter
should expose only ephemeral browser credentials.

This contract validates cooperative plugins; it is not a sandbox for hostile
JavaScript. Run third-party plugin code in an isolated process if it is not
trusted. Conformance is evidence about the tested fixture, not proof of live
provider compatibility or model quality.
