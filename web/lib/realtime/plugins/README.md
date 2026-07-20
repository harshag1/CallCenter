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
existing adapters. They make the new catalog and conformance surface available
without changing the release-critical runtime registry. Those legacy adapters
still own their existing environment and network access. A direct v1 plugin
should use only `context.readCredential` and `context.fetch`.

This contract validates cooperative plugins; it is not a sandbox for hostile
JavaScript. Run third-party plugin code in an isolated process if it is not
trusted. Conformance is evidence about the tested fixture, not proof of live
provider compatibility or model quality.
