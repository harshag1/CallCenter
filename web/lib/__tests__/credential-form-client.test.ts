import { describe, expect, it, vi } from "vitest";
import {
  createCredentialSubmissionId,
  submitCredentialToSink,
} from "../credential-form-client";
import { containsCredentialForm, SurfaceSchema } from "../surface-dsl";

const SLOT_ID = "018f0e21-7b7c-4d8e-8f9a-0b1c2d3e4f5a";
const SUBMISSION_ID = "018f0e21-7b7c-4d8e-8f9a-0b1c2d3e4f6b";

describe("browser-only credential form boundary", () => {
  it("posts directly to the same-origin sink and returns no credential-bearing value", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const result = await submitCredentialToSink({
      slotId: SLOT_ID,
      submissionId: SUBMISSION_ID,
      credential: "Bearer must-not-enter-model-context",
    }, fetchImpl as never);

    expect(result).toBe("saved");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("/api/credentials/ingest", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slot_id: SLOT_ID,
        submission_id: SUBMISSION_ID,
        credential: "Bearer must-not-enter-model-context",
      }),
    }));
    expect(JSON.stringify(result)).not.toContain("must-not-enter-model-context");
  });

  it("rejects malformed correlation slots without network I/O", async () => {
    const fetchImpl = vi.fn();
    await expect(submitCredentialToSink({
      slotId: "cred_v1_bearer",
      submissionId: SUBMISSION_ID,
      credential: "private",
    }, fetchImpl as never)).resolves.toBe("rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses a browser UUIDv4 submission identity and exposes explicit already-used state", async () => {
    expect(createCredentialSubmissionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 410 });
    await expect(submitCredentialToSink({
      slotId: SLOT_ID,
      submissionId: SUBMISSION_ID,
      credential: "private",
    }, fetchImpl as never)).resolves.toBe("already_used");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/credentials/ingest",
      expect.objectContaining({
        body: JSON.stringify({
          slot_id: SLOT_ID,
          submission_id: SUBMISSION_ID,
          credential: "private",
        }),
      })
    );
  });

  it("rejects malformed submission identities without sending a credential", async () => {
    const fetchImpl = vi.fn();
    await expect(submitCredentialToSink({
      slotId: SLOT_ID,
      submissionId: "retry-1",
      credential: "private",
    }, fetchImpl as never)).resolves.toBe("rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats an in-progress finalization as safely retryable with the same identity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 409 });
    await expect(submitCredentialToSink({
      slotId: SLOT_ID,
      submissionId: SUBMISSION_ID,
      credential: "private",
    }, fetchImpl as never)).resolves.toBe("unavailable");
  });

  it("enforces the server's 32 KiB UTF-8 credential limit before network I/O", async () => {
    const fetchImpl = vi.fn();
    await expect(submitCredentialToSink({
      slotId: SLOT_ID,
      submissionId: SUBMISSION_ID,
      credential: "😀".repeat(8_193),
    }, fetchImpl as never)).resolves.toBe("rejected");
    expect(fetchImpl).not.toHaveBeenCalled();

    fetchImpl.mockResolvedValue({ ok: true, status: 200 });
    await expect(submitCredentialToSink({
      slotId: SLOT_ID,
      submissionId: SUBMISSION_ID,
      credential: "😀".repeat(8_192),
    }, fetchImpl as never)).resolves.toBe("saved");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("validates credential forms strictly and marks nested forms ephemeral", () => {
    const parsed = SurfaceSchema.safeParse({
      title: "Credential",
      blocks: [{
        kind: "tabs",
        tabs: [{
          label: "Secure",
          blocks: [{
            kind: "credential_form",
            slotId: SLOT_ID,
            label: "Direct handoff",
            prompt: "send this to the model",
          }],
        }],
      }],
    });
    expect(parsed.success).toBe(false);

    const valid = SurfaceSchema.parse({
      title: "Credential",
      blocks: [{ kind: "credential_form", slotId: SLOT_ID, label: "Direct handoff" }],
    });
    expect(containsCredentialForm(valid)).toBe(true);
    expect(containsCredentialForm(SurfaceSchema.parse({
      title: "Dashboard",
      blocks: [{ kind: "markdown", body: "Safe" }],
    }))).toBe(false);
  });
});
