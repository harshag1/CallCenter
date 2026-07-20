/**
 * Gemini Live provider transcription is not part of the framework's default
 * evidence boundary. It is a separately billed, completion-driven stream with
 * no mechanically enforceable token/event ceiling in the setup contract.
 * Transcripts used for benchmark claims must instead be derived from the exact
 * PCM that was played to or captured from the call.
 */
export const GEMINI_PROVIDER_TRANSCRIPTION_POLICY = Object.freeze({
  input: "disabled" as const,
  output: "disabled" as const,
});

export const GEMINI_PROVIDER_TRANSCRIPTION_SETUP_KEYS = Object.freeze([
  "inputAudioTranscription",
  "outputAudioTranscription",
] as const);

/** The protocol defines these as one mutually exclusive server-message union. */
export const GEMINI_SERVER_MESSAGE_TYPE_KEYS = Object.freeze([
  "setupComplete",
  "serverContent",
  "toolCall",
  "toolCallCancellation",
  "goAway",
  "sessionResumptionUpdate",
  // WebSocket failures are delivered outside the protobuf oneof but are still
  // terminal envelopes and must never be mixed with an actionable message.
  "error",
] as const);

export function geminiServerMessageTypes(
  message: Readonly<Record<string, unknown>>,
): readonly string[] {
  return Object.freeze(GEMINI_SERVER_MESSAGE_TYPE_KEYS.filter((key) => (
    Object.prototype.hasOwnProperty.call(message, key)
  )));
}

export function assertGeminiProviderTranscriptionDisabled(
  setup: Readonly<Record<string, unknown>>,
  evidenceSource = "independently metered played-PCM transcription evidence",
): void {
  for (const key of GEMINI_PROVIDER_TRANSCRIPTION_SETUP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(setup, key)) {
      throw new Error(`Gemini provider transcription (${key}) is disabled: use ${evidenceSource}`);
    }
  }
}
