import assert from "node:assert/strict";
import test from "node:test";
import { HaccProviderDefinitionError, defineRealtimeProvider } from "../dist/index.js";

function provider(overrides = {}) {
  let connects = 0;
  const definition = defineRealtimeProvider({
    manifest: {
      contractVersion: "0.1",
      id: "fixture",
      label: "Fixture",
      docsUrl: "https://example.com/docs",
      transports: ["websocket"],
      inputAudio: { encoding: "pcm-s16le", sampleRateHz: 16_000, channels: 1 },
      outputAudio: { encoding: "pcm-s16le", sampleRateHz: 24_000, channels: 1 },
      capabilities: ["audio-input", "audio-output"],
      ...overrides,
    },
    async connect() {
      connects += 1;
      throw new Error("not used");
    },
  });
  return { definition, connects: () => connects };
}

test("provider definition is inert", () => {
  const result = provider();
  assert.equal(result.definition.manifest.id, "fixture");
  assert.equal(result.connects(), 0);
});

test("provider rejects duplicate transports", () => {
  assert.throws(
    () => provider({ transports: ["websocket", "websocket"] }),
    (error) => error instanceof HaccProviderDefinitionError && error.code === "invalid_transports",
  );
});

test("provider rejects non-HTTPS documentation URLs", () => {
  assert.throws(
    () => provider({ docsUrl: "http://example.com/docs" }),
    (error) => error instanceof HaccProviderDefinitionError && error.code === "invalid_docs_url",
  );
});
