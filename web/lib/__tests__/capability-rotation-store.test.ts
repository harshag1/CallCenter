import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureSafeDatabaseRuntimeRole: vi.fn(),
  getPool: vi.fn(),
}));

vi.mock("../db", () => ({
  ensureSafeDatabaseRuntimeRole: mocks.ensureSafeDatabaseRuntimeRole,
  getPool: mocks.getPool,
}));

import {
  CAPABILITY_ROTATION_OVERLAP_SECONDS,
  CAPABILITY_ROTATION_TTL_SECONDS,
} from "../capability-rotation";
import {
  type CapabilityRotationLease,
  rotateCapabilityLease,
} from "../capability-rotation-store";
import { deriveRotatedScopedJti, type ScopeClaims } from "../voice";

const ISSUED_AT = 2_000_000_000;
const EXPIRES_AT = ISSUED_AT + CAPABILITY_ROTATION_TTL_SECONDS;
const REFRESH_AFTER = EXPIRES_AT - CAPABILITY_ROTATION_OVERLAP_SECONDS;
const CALL_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const ROOT_JTI = "R".repeat(22);
const IDEMPOTENCY_KEY = `${CALL_ID}:1`;
const SESSION_ID = "bridge-session-1";
const BRIDGE_INSTANCE_ID = "bridge-instance-1";
const CALL_SID = `CA${"a".repeat(32)}`;
const ACCOUNT_SID = `AC${"b".repeat(32)}`;
const STREAM_SID = `MZ${"c".repeat(32)}`;
const TO = "+14155550100";

type RotationInput = Parameters<typeof rotateCapabilityLease>[0];

type QueryRecord = Readonly<{
  sql: string;
  params: readonly unknown[];
}>;

type HarnessOptions = Readonly<{
  activeBrowserCall?: boolean;
  telephonyBinding?: Readonly<{
    sessionId: string;
    bridgeInstanceId: string;
    streamSid: string;
    stopped: boolean;
  }>;
  initialLease?: CapabilityRotationLease | null;
}>;

function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function databaseRow(lease: CapabilityRotationLease) {
  return {
    ...lease,
    generation: String(lease.generation),
    issued_at: String(lease.issued_at),
    refresh_after_epoch: String(lease.refresh_after_epoch),
    expires_at_epoch: String(lease.expires_at_epoch),
  };
}

function queryResult(rows: readonly Record<string, unknown>[] = []) {
  return { rows: [...rows], rowCount: rows.length };
}

function makeHarness(options: HarnessOptions = {}) {
  let lease = options.initialLease ? { ...options.initialLease } : null;
  const records: QueryRecord[] = [];
  const release = vi.fn();
  const query = vi.fn(async (rawSql: string, rawParams: unknown[] = []) => {
    const sql = compactSql(rawSql);
    const params = [...rawParams];
    records.push({ sql, params });

    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return queryResult();
    }
    if (sql.includes("JOIN telephony_stream_bindings b")) {
      const binding = options.telephonyBinding;
      const exactBinding = binding
        && !binding.stopped
        && params[6] === binding.streamSid
        && params[7] === binding.sessionId
        && params[8] === binding.bridgeInstanceId;
      return exactBinding ? queryResult([{ id: CALL_ID }]) : queryResult();
    }
    if (sql.includes("FROM calls c JOIN agents a") && sql.includes("c.status = 'active'")) {
      return options.activeBrowserCall === false ? queryResult() : queryResult([{ id: CALL_ID }]);
    }
    if (sql.startsWith("SELECT transport") && sql.includes("FROM voice_capability_rotations")) {
      const selected = lease
        && params[0] === lease.transport
        && params[1] === lease.call_id
        && params[2] === lease.session_id
        ? [databaseRow(lease)]
        : [];
      return queryResult(selected);
    }
    if (sql.startsWith("INSERT INTO voice_capability_rotations")) {
      if (lease) return queryResult();
      lease = {
        transport: "browser",
        call_id: String(params[0]),
        session_id: String(params[0]),
        bridge_instance_id: null,
        stream_sid: null,
        provider: params[1] as "openai",
        rotation_root_jti: String(params[2]),
        generation: 0,
        current_refresh_jti: String(params[2]),
        previous_refresh_jti: null,
        last_consumed_refresh_jti: null,
        last_idempotency_key: null,
        issued_at: Number(params[3]),
        refresh_after_epoch: Number(params[4]),
        expires_at_epoch: Number(params[5]),
      };
      return queryResult([databaseRow(lease)]);
    }
    if (sql.startsWith("UPDATE voice_capability_rotations")) {
      if (
        !lease
        || params[0] !== lease.transport
        || params[1] !== lease.call_id
        || params[2] !== lease.session_id
        || params[9] !== lease.generation
        || params[10] !== lease.current_refresh_jti
      ) return queryResult();
      const previousRefreshJti = lease.current_refresh_jti;
      lease = {
        ...lease,
        generation: Number(params[3]),
        previous_refresh_jti: previousRefreshJti,
        last_consumed_refresh_jti: previousRefreshJti,
        last_idempotency_key: String(params[4]),
        current_refresh_jti: String(params[5]),
        issued_at: Number(params[6]),
        refresh_after_epoch: Number(params[7]),
        expires_at_epoch: Number(params[8]),
      };
      return queryResult([databaseRow(lease)]);
    }
    throw new Error(`Unhandled capability-rotation SQL: ${sql}`);
  });
  const connect = vi.fn(async () => ({ query, release }));
  mocks.getPool.mockReturnValue({ connect });

  return {
    connect,
    get lease(): CapabilityRotationLease | null {
      return lease ? { ...lease } : null;
    },
    query,
    records,
    release,
  };
}

function browserScope(overrides: Partial<ScopeClaims> = {}): ScopeClaims {
  return {
    v: 2,
    callId: CALL_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    aud: "browser_refresh",
    purpose: "capability_rotation",
    method: "POST",
    provider: "openai",
    iat: ISSUED_AT,
    exp: EXPIRES_AT,
    jti: ROOT_JTI,
    ...overrides,
  };
}

function browserInput(overrides: Partial<RotationInput> = {}): RotationInput {
  return {
    transport: "browser",
    scope: browserScope(),
    sessionId: CALL_ID,
    requestedGeneration: 1,
    idempotencyKey: IDEMPOTENCY_KEY,
    nowEpoch: REFRESH_AFTER,
    ...overrides,
  };
}

function telephonyScope(overrides: Partial<ScopeClaims> = {}): ScopeClaims {
  return {
    ...browserScope(),
    aud: "bridge_refresh",
    providerCallId: CALL_SID,
    providerAccountId: ACCOUNT_SID,
    providerTo: TO,
    providerStreamId: STREAM_SID,
    transportProvider: "twilio",
    ...overrides,
  };
}

function telephonyLease(): CapabilityRotationLease {
  return {
    transport: "telephony",
    call_id: CALL_ID,
    session_id: SESSION_ID,
    bridge_instance_id: BRIDGE_INSTANCE_ID,
    stream_sid: STREAM_SID,
    provider: "openai",
    rotation_root_jti: ROOT_JTI,
    generation: 0,
    current_refresh_jti: ROOT_JTI,
    previous_refresh_jti: null,
    last_consumed_refresh_jti: null,
    last_idempotency_key: null,
    issued_at: ISSUED_AT,
    refresh_after_epoch: REFRESH_AFTER,
    expires_at_epoch: EXPIRES_AT,
  };
}

function telephonyInput(overrides: Partial<RotationInput> = {}): RotationInput {
  return {
    transport: "telephony",
    scope: telephonyScope(),
    sessionId: SESSION_ID,
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    streamSid: STREAM_SID,
    requestedGeneration: 1,
    idempotencyKey: `${SESSION_ID}:1`,
    nowEpoch: REFRESH_AFTER,
    ...overrides,
  };
}

describe("atomic capability rotation storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_GATEWAY_SECRET = "rotation-store-test-secret-that-is-at-least-32-bytes";
    mocks.ensureSafeDatabaseRuntimeRole.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.MCP_GATEWAY_SECRET;
  });

  it("lazily seeds and consumes an exact browser renewal in one transaction", async () => {
    const harness = makeHarness();

    const result = await rotateCapabilityLease(browserInput());

    expect(result).toMatchObject({ status: "rotated", lease: { generation: 1 } });
    if (result.status !== "rotated") throw new Error("expected a rotated lease");
    expect(result.lease).toEqual({
      transport: "browser",
      call_id: CALL_ID,
      session_id: CALL_ID,
      bridge_instance_id: null,
      stream_sid: null,
      provider: "openai",
      rotation_root_jti: ROOT_JTI,
      generation: 1,
      current_refresh_jti: deriveRotatedScopedJti(ROOT_JTI, 1, "browser_refresh"),
      previous_refresh_jti: ROOT_JTI,
      last_consumed_refresh_jti: ROOT_JTI,
      last_idempotency_key: IDEMPOTENCY_KEY,
      issued_at: REFRESH_AFTER,
      refresh_after_epoch: REFRESH_AFTER + CAPABILITY_ROTATION_TTL_SECONDS
        - CAPABILITY_ROTATION_OVERLAP_SECONDS,
      expires_at_epoch: REFRESH_AFTER + CAPABILITY_ROTATION_TTL_SECONDS,
    });
    expect(harness.records.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("c.status = 'active'"),
      expect.stringContaining("FROM voice_capability_rotations"),
      expect.stringContaining("INSERT INTO voice_capability_rotations"),
      expect.stringContaining("UPDATE voice_capability_rotations"),
      "COMMIT",
    ]);
    expect(harness.records[1]?.sql).toContain("c.direction = 'web'");
    expect(mocks.ensureSafeDatabaseRuntimeRole).toHaveBeenCalledOnce();
    expect(mocks.ensureSafeDatabaseRuntimeRole.mock.invocationCallOrder[0])
      .toBeLessThan(harness.connect.mock.invocationCallOrder[0]);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it("rejects early renewal without mutating the lazily seeded generation zero lease", async () => {
    const harness = makeHarness();

    await expect(rotateCapabilityLease(browserInput({ nowEpoch: REFRESH_AFTER - 1 })))
      .resolves.toEqual({ status: "too_early" });

    expect(harness.lease).toMatchObject({
      generation: 0,
      current_refresh_jti: ROOT_JTI,
      previous_refresh_jti: null,
      last_consumed_refresh_jti: null,
      last_idempotency_key: null,
    });
    expect(harness.records.some(({ sql }) => sql.startsWith("UPDATE voice_capability_rotations")))
      .toBe(false);
    expect(harness.records.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("replays the committed lease byte-for-byte for the exact old bearer, generation, and key", async () => {
    const harness = makeHarness();
    const first = await rotateCapabilityLease(browserInput());
    if (first.status !== "rotated") throw new Error("expected initial rotation to succeed");
    const committedLeaseJson = JSON.stringify(first.lease);
    const updateCount = harness.records.filter(({ sql }) =>
      sql.startsWith("UPDATE voice_capability_rotations")).length;

    const replay = await rotateCapabilityLease(browserInput({ nowEpoch: REFRESH_AFTER + 10 }));

    if (replay.status !== "replayed") throw new Error("expected exact retry to replay");
    expect(JSON.stringify(replay.lease)).toBe(committedLeaseJson);
    expect(harness.records.filter(({ sql }) =>
      sql.startsWith("UPDATE voice_capability_rotations"))).toHaveLength(updateCount);
    expect(harness.records.at(-1)?.sql).toBe("COMMIT");
  });

  it.each([0, 1])(
    "expires an exact lost-response replay at the old bearer wall plus %i second(s)",
    async (secondsAfterExpiry) => {
      const harness = makeHarness();
      const first = await rotateCapabilityLease(browserInput());
      if (first.status !== "rotated") throw new Error("expected initial rotation to succeed");
      expect(first.lease.expires_at_epoch).toBeGreaterThan(EXPIRES_AT);
      const committedLeaseJson = JSON.stringify(first.lease);

      await expect(rotateCapabilityLease(browserInput({
        nowEpoch: EXPIRES_AT + secondsAfterExpiry,
      }))).resolves.toEqual({ status: "expired" });

      expect(JSON.stringify(harness.lease)).toBe(committedLeaseJson);
      expect(harness.records.filter(({ sql }) =>
        sql.startsWith("UPDATE voice_capability_rotations"))).toHaveLength(1);
      expect(harness.records.at(-1)?.sql).toBe("ROLLBACK");
    },
  );

  it("rejects a wrong idempotency key or generation without advancing committed state", async () => {
    const harness = makeHarness();
    const first = await rotateCapabilityLease(browserInput());
    expect(first.status).toBe("rotated");
    const committed = harness.lease;

    await expect(rotateCapabilityLease(browserInput({ idempotencyKey: `${CALL_ID}:attacker` })))
      .resolves.toEqual({ status: "conflict" });
    await expect(rotateCapabilityLease(browserInput({ requestedGeneration: 3 })))
      .resolves.toEqual({ status: "conflict" });

    expect(harness.lease).toEqual(committed);
    expect(harness.records.filter(({ sql }) =>
      sql.startsWith("UPDATE voice_capability_rotations"))).toHaveLength(1);
  });

  it("fails before lease lookup when the browser call is no longer active", async () => {
    const harness = makeHarness({ activeBrowserCall: false });

    await expect(rotateCapabilityLease(browserInput())).resolves.toEqual({ status: "not_found" });

    expect(harness.records.some(({ sql }) => sql.includes("FROM voice_capability_rotations")))
      .toBe(false);
    expect(harness.records.at(-1)?.sql).toBe("ROLLBACK");
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it("fails closed for a stopped or mismatched telephony stream/session/bridge binding", async () => {
    const harness = makeHarness({
      initialLease: telephonyLease(),
      telephonyBinding: {
        sessionId: SESSION_ID,
        bridgeInstanceId: BRIDGE_INSTANCE_ID,
        streamSid: STREAM_SID,
        stopped: true,
      },
    });

    await expect(rotateCapabilityLease(telephonyInput())).resolves.toEqual({ status: "not_found" });
    const bindingQuery = harness.records.find(({ sql }) => sql.includes("telephony_stream_bindings"));
    expect(bindingQuery?.sql).toContain("b.stopped_at IS NULL");
    expect(bindingQuery?.sql).toContain("b.session_id = $8 AND b.bridge_instance_id = $9");
    expect(bindingQuery?.params).toEqual([
      CALL_ID,
      AGENT_ID,
      ORG_ID,
      CALL_SID,
      ACCOUNT_SID,
      TO,
      STREAM_SID,
      SESSION_ID,
      BRIDGE_INSTANCE_ID,
    ]);
    expect(harness.records.some(({ sql }) => sql.includes("FROM voice_capability_rotations")))
      .toBe(false);

    vi.clearAllMocks();
    mocks.ensureSafeDatabaseRuntimeRole.mockResolvedValue(undefined);
    const mismatch = makeHarness({
      initialLease: telephonyLease(),
      telephonyBinding: {
        sessionId: SESSION_ID,
        bridgeInstanceId: BRIDGE_INSTANCE_ID,
        streamSid: STREAM_SID,
        stopped: false,
      },
    });
    await expect(rotateCapabilityLease(telephonyInput({
      bridgeInstanceId: "attacker-bridge-instance",
    }))).resolves.toEqual({ status: "not_found" });
    expect(mismatch.records.some(({ sql }) => sql.includes("FROM voice_capability_rotations")))
      .toBe(false);
  });
});
