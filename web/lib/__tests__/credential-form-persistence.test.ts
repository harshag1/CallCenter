import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ q: vi.fn(), qOne: vi.fn() }));
vi.mock("../db", () => ({ q: mocks.q, qOne: mocks.qOne }));

import { renderSurface } from "../agent/tools/ui";
import { createScreen } from "../agent/tools/screens-tools";

const SLOT_ID = "018f0e21-7b7c-4d8e-8f9a-0b1c2d3e4f5a";
const ctx = {
  orgId: "018f0e21-7b7c-4d8e-8f9a-0b1c2d3e4f5b",
  email: "owner@example.test",
  agentId: null,
  origin: "https://app.example.test",
};
const secureSurface = {
  title: "Secure handoff",
  blocks: [{
    kind: "tabs",
    tabs: [{
      label: "Credential",
      blocks: [{ kind: "credential_form", slotId: SLOT_ID, label: "Direct sink" }],
    }],
  }],
};

describe("credential form persistence boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses nested credential forms from the generic renderer, pinned or ephemeral", async () => {
    const ephemeral = await renderSurface.execute({ surface: secureSurface } as never, ctx);
    expect(ephemeral.output).toEqual({
      error: "credential forms can only be issued by trusted credential tools and cannot be rendered generically",
    });

    const pinned = await renderSurface.execute({ surface: secureSurface, pin: true } as never, ctx);
    expect(pinned.output).toEqual({
      error: "credential forms can only be issued by trusted credential tools and cannot be rendered generically",
    });
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("refuses to persist a credential form inside a saved screen", async () => {
    const result = await createScreen.execute({
      title: secureSurface.title,
      blocks: secureSurface.blocks,
    } as never, ctx);
    expect(result.output).toEqual({
      error: "credential forms are ephemeral and cannot be saved as screens",
    });
    expect(mocks.qOne).not.toHaveBeenCalled();
  });
});
