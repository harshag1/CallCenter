import { describe, expect, it } from "vitest";
import { CALL_RUNTIME_SNAPSHOT_QUERY } from "../call-runtime-query";

describe("immutable call runtime snapshot", () => {
  it("joins the flow and tools through calls.agent_version", () => {
    const normalized = CALL_RUNTIME_SNAPSHOT_QUERY.replace(/\s+/g, " ").trim();
    expect(normalized).toContain("v.version = c.agent_version");
    expect(normalized).toContain("c.id = $3");
    expect(normalized).not.toContain("active_version");
  });
});
