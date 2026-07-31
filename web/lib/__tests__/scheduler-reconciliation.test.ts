import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeCronRequest: vi.fn(),
  reconcileStalePostBoundaryDispatches: vi.fn(),
  dialDue: vi.fn(),
  quarantineStaleIndeterminateCampaigns: vi.fn(),
  q: vi.fn(),
  analyzeCall: vi.fn(),
  sweepCallTasks: vi.fn(),
  sweepGeneratedToolCleanup: vi.fn(),
  sweepExpiredOperatorPrivateDisplays: vi.fn(),
  drainGovernedCallWorkers: vi.fn(),
}));

vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest: mocks.authorizeCronRequest }));
vi.mock("@/lib/campaigns", () => ({
  reconcileStalePostBoundaryDispatches: mocks.reconcileStalePostBoundaryDispatches,
  dialDue: mocks.dialDue,
  quarantineStaleIndeterminateCampaigns: mocks.quarantineStaleIndeterminateCampaigns,
}));
vi.mock("@/lib/db", () => ({ q: mocks.q }));
vi.mock("@/lib/analysis", () => ({ analyzeCall: mocks.analyzeCall }));
vi.mock("@/lib/tasks", () => ({ sweepCallTasks: mocks.sweepCallTasks }));
vi.mock("@/lib/toolfactory/cleanup", () => ({
  sweepGeneratedToolCleanup: mocks.sweepGeneratedToolCleanup,
}));
vi.mock("@/lib/operator-action-maintenance", () => ({
  sweepExpiredOperatorPrivateDisplays: mocks.sweepExpiredOperatorPrivateDisplays,
}));
vi.mock("@/lib/governed-worker-drain", () => ({
  drainGovernedCallWorkers: mocks.drainGovernedCallWorkers,
}));
vi.mock("@/lib/log", () => ({ log: () => ({ warn: vi.fn() }) }));

import { GET } from "../../app/api/cron/scheduler/route";

describe("scheduler reconciliation ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeCronRequest.mockReturnValue(true);
    mocks.reconcileStalePostBoundaryDispatches.mockResolvedValue(2);
    mocks.dialDue.mockResolvedValue({ "job-1": "accepted:provider_accepted:call-1" });
    mocks.quarantineStaleIndeterminateCampaigns.mockResolvedValue(1);
    mocks.q.mockResolvedValue([]);
    mocks.sweepCallTasks.mockResolvedValue(0);
    mocks.sweepGeneratedToolCleanup.mockResolvedValue({
      claimed: 0,
      cleaned: 0,
      cleanupRequired: 0,
    });
    mocks.sweepExpiredOperatorPrivateDisplays.mockResolvedValue(3);
    mocks.drainGovernedCallWorkers.mockResolvedValue({
      attempted: 1,
      executed: 1,
      claimRaces: 0,
      timeBudgetExhausted: false,
    });
  });

  it("terminalizes crash orphans before claiming and writes quarantine receipts afterward", async () => {
    const order: string[] = [];
    mocks.q.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE calls c") && sql.includes("recording_consent_receipts")) {
        return [{ id: "stale-call-1" }, { id: "stale-call-2" }];
      }
      return sql.includes("purge_expired_call_recordings") ? [{ purged: "7" }] : [];
    });
    mocks.reconcileStalePostBoundaryDispatches.mockImplementation(async () => {
      order.push("reconcile");
      return 2;
    });
    mocks.dialDue.mockImplementation(async () => {
      order.push("dial");
      return { "job-1": "accepted:provider_accepted:call-1" };
    });
    mocks.quarantineStaleIndeterminateCampaigns.mockImplementation(async () => {
      order.push("quarantine");
      return 1;
    });

    const response = await GET(new Request("https://app.example.test/api/cron/scheduler", {
      headers: { authorization: "Bearer exact-secret" },
    }));
    const body = await response.json();

    expect(order).toEqual(["reconcile", "dial", "quarantine"]);
    expect(mocks.reconcileStalePostBoundaryDispatches).toHaveBeenCalledWith(100);
    expect(mocks.dialDue).toHaveBeenCalledWith(15);
    expect(mocks.quarantineStaleIndeterminateCampaigns).toHaveBeenCalledWith(25);
    expect(body).toMatchObject({
      processed: 1,
      reconciledUnknownDispatches: 2,
      quarantinedCampaigns: 1,
      expiredOperatorDisplaysScrubbed: 3,
      operatorDisplayScrubUnavailable: false,
      staleRecordingCallsClosed: 2,
      recordingCallSweepUnavailable: false,
      recordingsPurged: 7,
      recordingPurgeUnavailable: false,
      governedWorkerDrain: {
        attempted: 1,
        executed: 1,
        claimRaces: 0,
        timeBudgetExhausted: false,
      },
    });
    expect(mocks.sweepExpiredOperatorPrivateDisplays).toHaveBeenCalledWith(500);
    expect(mocks.q).toHaveBeenCalledWith("SELECT purge_expired_call_recordings(5000)::text AS purged");
  });

  it("performs no reconciliation, dialing, or cleanup without exact cron authority", async () => {
    mocks.authorizeCronRequest.mockReturnValue(false);

    const response = await GET(new Request("https://app.example.test/api/cron/scheduler"));

    expect(response.status).toBe(401);
    expect(mocks.reconcileStalePostBoundaryDispatches).not.toHaveBeenCalled();
    expect(mocks.dialDue).not.toHaveBeenCalled();
    expect(mocks.quarantineStaleIndeterminateCampaigns).not.toHaveBeenCalled();
    expect(mocks.sweepGeneratedToolCleanup).not.toHaveBeenCalled();
    expect(mocks.sweepExpiredOperatorPrivateDisplays).not.toHaveBeenCalled();
    expect(mocks.drainGovernedCallWorkers).not.toHaveBeenCalled();
  });

  it("keeps dialing available while reporting a failed independent privacy sweep", async () => {
    mocks.sweepExpiredOperatorPrivateDisplays.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await GET(new Request("https://app.example.test/api/cron/scheduler", {
      headers: { authorization: "Bearer exact-secret" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.dialDue).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      expiredOperatorDisplaysScrubbed: 0,
      operatorDisplayScrubUnavailable: true,
    });
  });

  it("keeps dialing available while reporting a failed recording-retention sweep", async () => {
    mocks.q.mockImplementation(async (sql: string) => {
      if (sql.includes("purge_expired_call_recordings")) throw new Error("database unavailable");
      return [];
    });

    const response = await GET(new Request("https://app.example.test/api/cron/scheduler", {
      headers: { authorization: "Bearer exact-secret" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.dialDue).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ recordingsPurged: 0, recordingPurgeUnavailable: true });
  });

  it("keeps dialing available while reporting a failed stale-recording-call sweep", async () => {
    mocks.q.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE calls c") && sql.includes("recording_consent_receipts")) {
        throw new Error("database unavailable");
      }
      return [];
    });

    const response = await GET(new Request("https://app.example.test/api/cron/scheduler", {
      headers: { authorization: "Bearer exact-secret" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.dialDue).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ staleRecordingCallsClosed: 0, recordingCallSweepUnavailable: true });
  });
});
