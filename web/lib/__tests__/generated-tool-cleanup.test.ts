import { describe, expect, it, vi } from "vitest";
import {
  GENERATED_TOOL_CLEANUP_MAX_ATTEMPTS,
  sweepGeneratedToolCleanup,
} from "../toolfactory/cleanup";

const ORG = "00000000-0000-4000-8000-000000000001";
const job = {
  key_id: "tik_abcdefghijklmnop",
  org_id: ORG,
  deployment_project: "hacc-tool-v2-aaaaaaaaaaaaaaaaaaaa",
  claim_token: "00000000-0000-4000-8000-000000000002",
  attempts: 1,
};

describe("generated-tool project cleanup worker", () => {
  it("claims with SKIP LOCKED, deletes once, and settles only its org-bound random lease", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([job])
      .mockResolvedValueOnce([{ key_id: job.key_id }]);
    const cleanupProject = vi.fn().mockResolvedValue(undefined);

    await expect(sweepGeneratedToolCleanup(5, { query, cleanupProject })).resolves.toEqual({
      claimed: 1,
      cleaned: 1,
      cleanupRequired: 0,
    });
    const claimSql = String(query.mock.calls[0][0]).replace(/\s+/g, " ");
    expect(claimSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(claimSql).toContain("WITH terminalized AS");
    expect(claimSql).toContain("exhausted.attempts >= $2");
    expect(claimSql).toContain("exhausted.claim_expires_at <= now()");
    expect(claimSql).toContain("status = 'cleaning'");
    expect(claimSql).toContain("claim_expires_at <= now()");
    expect(claimSql).toContain("claim_token = gen_random_uuid()");
    expect(query.mock.calls[0][1]).toEqual([5, GENERATED_TOOL_CLEANUP_MAX_ATTEMPTS]);
    expect(cleanupProject).toHaveBeenCalledWith(job.deployment_project);

    const settleSql = String(query.mock.calls[1][0]);
    expect(settleSql).toContain("status = 'cleaned'");
    expect(settleSql).toContain("org_id = $2");
    expect(settleSql).toContain("claim_token = $3");
    expect(query.mock.calls[1][1]).toEqual([job.key_id, ORG, job.claim_token]);
  });

  it("keeps a bounded cleanup_required record on provider failure without persisting details", async () => {
    const privateProviderDetail = "token=provider-root-secret";
    const query = vi.fn()
      .mockResolvedValueOnce([{ ...job, attempts: GENERATED_TOOL_CLEANUP_MAX_ATTEMPTS }])
      .mockResolvedValueOnce([{ key_id: job.key_id }]);
    const cleanupProject = vi.fn().mockRejectedValue(new Error(privateProviderDetail));

    await expect(sweepGeneratedToolCleanup(1, { query, cleanupProject })).resolves.toEqual({
      claimed: 1,
      cleaned: 0,
      cleanupRequired: 1,
    });
    const retrySql = String(query.mock.calls[1][0]).replace(/\s+/g, " ");
    expect(retrySql).toContain("status = 'cleanup_required'");
    expect(retrySql).toContain("last_error_code = 'provider_cleanup_failed'");
    expect(retrySql).toContain("interval '1 hour'");
    expect(JSON.stringify(query.mock.calls)).not.toContain(privateProviderDetail);
    expect(query.mock.calls[0][1]).toEqual([1, 8]);
  });

  it("terminalizes an abandoned eighth claim before selecting retryable work", async () => {
    const query = vi.fn().mockResolvedValueOnce([]);
    const cleanupProject = vi.fn();
    await expect(sweepGeneratedToolCleanup(1, { query, cleanupProject })).resolves.toEqual({
      claimed: 0,
      cleaned: 0,
      cleanupRequired: 0,
    });
    const sql = String(query.mock.calls[0][0]).replace(/\s+/g, " ");
    expect(sql).toContain("WITH terminalized AS");
    expect(sql).toContain("SET status = 'cleanup_required'");
    expect(sql).toContain("exhausted.attempts >= $2");
    expect(sql).toContain("exhausted.claim_expires_at <= now()");
    expect(query.mock.calls[0][1]).toEqual([1, 8]);
    expect(cleanupProject).not.toHaveBeenCalled();
  });

  it("does not report cleanup authority when its lease was lost before settlement", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([job])
      .mockResolvedValueOnce([]);
    const cleanupProject = vi.fn().mockResolvedValue(undefined);
    await expect(sweepGeneratedToolCleanup(1, { query, cleanupProject })).resolves.toEqual({
      claimed: 1,
      cleaned: 0,
      cleanupRequired: 1,
    });
  });

  it("rejects unbounded batches before database or provider access", async () => {
    const query = vi.fn();
    const cleanupProject = vi.fn();
    await expect(sweepGeneratedToolCleanup(0, { query, cleanupProject })).rejects.toThrow(/between 1 and 25/);
    await expect(sweepGeneratedToolCleanup(26, { query, cleanupProject })).rejects.toThrow(/between 1 and 25/);
    expect(query).not.toHaveBeenCalled();
    expect(cleanupProject).not.toHaveBeenCalled();
  });
});
