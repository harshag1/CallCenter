// Browser-only credential delivery. This module deliberately has no chat/model callback.

const SLOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CredentialSubmitResult = "saved" | "rejected" | "already_used" | "unavailable";

export function createCredentialSubmissionId(): string {
  const submissionId = globalThis.crypto?.randomUUID?.();
  if (!submissionId || !SLOT_ID_PATTERN.test(submissionId)) {
    throw new Error("secure browser UUID generation is unavailable");
  }
  return submissionId;
}

export async function submitCredentialToSink(
  input: Readonly<{ slotId: string; submissionId: string; credential: string }>,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<CredentialSubmitResult> {
  let credentialBytes: number;
  try {
    credentialBytes = new TextEncoder().encode(input.credential).byteLength;
  } catch {
    return "rejected";
  }
  if (
    !SLOT_ID_PATTERN.test(input.slotId) ||
    !SLOT_ID_PATTERN.test(input.submissionId) ||
    credentialBytes < 1 ||
    credentialBytes > 32 * 1024
  ) {
    return "rejected";
  }
  try {
    const response = await fetchImpl("/api/credentials/ingest", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slot_id: input.slotId,
        submission_id: input.submissionId,
        credential: input.credential,
      }),
    });
    if (response.ok) return "saved";
    if (response.status === 409) return "unavailable";
    return response.status === 410 ? "already_used" : "rejected";
  } catch {
    return "unavailable";
  }
}
