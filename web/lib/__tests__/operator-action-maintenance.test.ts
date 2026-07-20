import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ q: vi.fn() }));
vi.mock("../db", () => ({ q: mocks.q }));

import { sweepExpiredOperatorPrivateDisplays } from "../operator-action-maintenance";

describe("operator action scheduled maintenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.q.mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000001" }]);
  });

  it("globally scrubs a bounded batch without reading or returning private display values", async () => {
    await expect(sweepExpiredOperatorPrivateDisplays(17)).resolves.toBe(1);

    const [sql, params] = mocks.q.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([17]);
    expect(sql).toContain("expires_at <= clock_timestamp()");
    expect(sql).toContain("private_display IS NOT NULL");
    expect(sql).toContain("LIMIT $1");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("SET private_display = NULL");
    expect(sql).toContain("RETURNING oa.id");
    expect(sql).not.toMatch(/SELECT\s+(?:oa\.)?private_display\b/i);
    expect(sql).not.toContain("RETURNING oa.private_display");
  });

  it.each([
    [0, 1],
    [-20, 1],
    [50_000, 1_000],
    [Number.NaN, 500],
  ])("clamps an unsafe requested batch %s to %s", async (requested, expected) => {
    await sweepExpiredOperatorPrivateDisplays(requested);
    expect(mocks.q.mock.calls[0]?.[1]).toEqual([expected]);
  });
});
