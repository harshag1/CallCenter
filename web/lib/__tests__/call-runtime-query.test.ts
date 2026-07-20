import { describe, expect, it } from "vitest";
import { CALL_RUNTIME_SNAPSHOT_QUERY } from "../call-runtime-query";

describe("immutable call runtime snapshot", () => {
  it("prefers the pinned call manifest and falls back through calls.agent_version", () => {
    const normalized = CALL_RUNTIME_SNAPSHOT_QUERY.replace(/\s+/g, " ").trim();
    expect(normalized).toContain("c.runtime_snapshot");
    expect(normalized).toContain("c.status");
    expect(normalized).toContain("c.runtime_snapshot->'flow'");
    expect(normalized.indexOf("v.flow")).toBeLessThan(normalized.indexOf("f.flow"));
    expect(normalized).toContain("v.version = c.agent_version");
    expect(normalized).toContain("c.id = $3");
    expect(normalized).not.toContain("active_version");
  });
});
