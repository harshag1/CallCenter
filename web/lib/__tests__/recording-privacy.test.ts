import { describe, expect, it } from "vitest";
import {
  MAX_BROWSER_RECORDING_BYTES,
  configuredRecordingRetentionDays,
  normalizedBrowserRecordingMime,
  parseRecordingConsent,
  parseStoredRecordingConsent,
  readBoundedRecordingBody,
  storedRecordingConsent,
} from "../recording-privacy";

const NOW = Date.parse("2026-07-16T20:00:00.000Z");
const CONSENT_ID = "00000000-0000-4000-8000-000000000009";

function consent(overrides: Record<string, unknown> = {}) {
  return {
    granted: true,
    consentId: CONSENT_ID,
    grantedAt: "2026-07-16T19:59:00.000Z",
    noticeVersion: "recording-v1",
    retentionDays: 7,
    ...overrides,
  };
}

describe("recording privacy boundary", () => {
  it("requires an exact, recent, affirmative consent envelope", () => {
    expect(parseRecordingConsent(consent(), NOW)).toEqual(consent());
    expect(parseRecordingConsent(consent({ granted: false }), NOW)).toBeNull();
    expect(parseRecordingConsent(consent({ consentId: "not-a-uuid" }), NOW)).toBeNull();
    expect(parseRecordingConsent(consent({ grantedAt: "2026-07-16T19:00:00.000Z" }), NOW)).toBeNull();
    expect(parseRecordingConsent(consent({ unknown: true }), NOW)).toBeNull();
    expect(parseRecordingConsent(consent({ retentionDays: 366 }), NOW)).toBeNull();
    expect(parseRecordingConsent(consent({ noticeVersion: "never-displayed" }), NOW)).toBeNull();
  });

  it("lets consent shorten but never extend the configured retention ceiling", () => {
    expect(configuredRecordingRetentionDays(undefined)).toBe(30);
    expect(configuredRecordingRetentionDays("14", 7)).toBe(7);
    expect(configuredRecordingRetentionDays("14", 30)).toBe(14);
    expect(() => configuredRecordingRetentionDays("forever")).toThrow("must be an integer");
  });

  it("round-trips only canonical stored consent metadata", () => {
    const parsed = parseRecordingConsent(consent(), NOW)!;
    const stored = storedRecordingConsent(parsed, 30, "a".repeat(64), "b".repeat(64));
    expect(parseStoredRecordingConsent({ recording_consent: stored })).toEqual(stored);
    expect(parseStoredRecordingConsent({
      recording_consent: { ...stored, source: "model_claim" },
    })).toBeNull();
    expect(parseStoredRecordingConsent({
      recording_consent: { ...stored, upload_token_hash: "not-a-hash" },
    })).toBeNull();
    expect(parseStoredRecordingConsent({
      recording_consent: { ...stored, upload_expires_at: "2026-07-17T19:59:00.000Z" },
    })).toBeNull();
  });

  it("allows only browser audio MIME types", () => {
    expect(normalizedBrowserRecordingMime("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizedBrowserRecordingMime("text/html")).toBeNull();
    expect(normalizedBrowserRecordingMime(null)).toBeNull();
  });

  it("caps streamed recording bodies even without Content-Length", async () => {
    const accepted = await readBoundedRecordingBody(new Request("https://app.test/recording", {
      method: "POST",
      body: Uint8Array.from([1, 2, 3]),
      duplex: "half",
    } as RequestInit));
    expect(Array.from(accepted)).toEqual([1, 2, 3]);

    const oversized = new Request("https://app.test/recording", {
      method: "POST",
      headers: { "Content-Length": String(MAX_BROWSER_RECORDING_BYTES + 1) },
      body: Uint8Array.from([1]),
      duplex: "half",
    } as RequestInit);
    await expect(readBoundedRecordingBody(oversized)).rejects.toMatchObject({ status: 413 });
  });
});
