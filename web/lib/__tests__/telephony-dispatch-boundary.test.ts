import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  getPool: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../db", () => ({
  getPool: mocks.getPool,
  q: mocks.q,
  qOne: mocks.qOne,
}));
vi.mock("../log", () => ({
  log: () => ({ info: mocks.info, error: mocks.error }),
}));

import { callRuntimeDigest, type CallRuntimeSnapshot } from "../call-runtime-snapshot";
import { operatorActionArgumentsSha256 } from "../agent/tools/operator-capability-policy";
import {
  createVoiceCampaignCostQuote,
  createVoiceCostQuote,
  type OperatorCostQuoteV1,
} from "../operator-pricing";
import { AcceptedProviderSettlementError, originateCall } from "../telephony";

const PUBLIC_ORIGIN = "https://voice.example.test";
const BRIDGE_WS_URL = "wss://bridge.example.test/twilio/media";
const AUTH_TOKEN = "test_twilio_auth_token_123456789";
const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const API_KEY_SID = `SK${"c".repeat(32)}`;
const API_KEY_SECRET = "restricted-api-key-secret-123456789";
const RECEIPT_SECRET = "domain-specific-telephony-receipt-secret-123456789";
const CALL_SID = `CA${"b".repeat(32)}`;
const SCHEDULED_CALL_ID = "00000000-0000-4000-8000-000000000101";
const AGENT_ID = "00000000-0000-4000-8000-000000000102";
const ORG_ID = "00000000-0000-4000-8000-000000000103";
const FLOW_ID = "00000000-0000-4000-8000-000000000104";
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000105";
const OTHER_EXECUTION_ID = "00000000-0000-4000-8000-000000000106";
const CLAIM_TOKEN = "00000000-0000-4000-8000-000000000107";
const TO = "+14155550101";
const FROM = "+14155550102";
const PRIVATE_TO_SENTINEL = "+14155550999";
const REASON = `campaign:${CAMPAIGN_ID}`;
const TARGET_SET_SHA256 = "2".repeat(64);
const DATASET_ID = "00000000-0000-4000-8000-000000000108";
const RUNTIME_SCOPE_ID = "00000000-0000-4000-8000-000000000109";
const PRICING_ENVIRONMENT = Object.freeze({
  HACC_OPERATOR_VOICE_MINUTE_CEILING_USD: "0.333333",
  HACC_OPERATOR_QUOTE_SAFETY_MARGIN_USD: "0.000005",
  HACC_OPERATOR_QUOTE_TTL_SECONDS: "86400",
  HACC_OPERATOR_QUOTE_MAX_RESERVATION_USD: "100",
});
const QUOTE_NOW = new Date("2026-07-16T00:00:00.000Z");

const runtimeSnapshot: CallRuntimeSnapshot = {
  v: 2,
  agentVersion: 7,
  namedFlowId: null,
  flow: {
    schema_version: 2,
    nodes: [
      { id: "entry", label: "Incoming call", kind: "incoming_call" },
      {
        id: "help",
        label: "Help",
        kind: "topic",
        steps: [{ id: "answer", label: "Answer", instructions: "Help the caller." }],
      },
    ],
    edges: [{ from: "entry", to: "help" }],
  },
  instructions: "Be helpful and follow the pinned flow.",
  codeRevision: "test-dispatch-boundary",
  toolManifest: [],
  extensionManifest: [],
  externalMcpManifest: [],
  environment: {
    internetEnabled: false,
    allowedDomains: [],
    docsReady: false,
    datasetSlugs: [],
    holdMusic: false,
  },
  createdAt: "2026-07-16T00:00:00.000Z",
};
const RUNTIME_DIGEST = callRuntimeDigest(runtimeSnapshot);

type CampaignRow = Readonly<{
  id: string;
  org_id: string;
  agent_id: string;
  flow_id: string;
  status: string;
  operator_execution_id: string;
  operator_capability: string;
  operator_status: string;
  operator_arguments_sha256: string;
}>;

type JobRow = Readonly<{
  id: string;
  agent_id: string;
  org_id: string;
  to_number: string;
  reason: string | null;
  flow_id: string | null;
  campaign_id: string | null;
  parent_call_id: string | null;
  agent_version: number;
  runtime_snapshot: unknown;
  runtime_digest: string;
  phone_number: string | null;
  dispatch_started_at: string | null;
  operator_execution_id: string;
  operator_arguments_sha256: string;
  target_set_sha256: string | null;
  manifest_capability: string;
  authority_valid: boolean;
  operator_capability: string;
  operator_status: string;
  current_operator_arguments_sha256: string;
  current_estimated_units: number;
  current_estimated_micro_usd: string;
  approved_action_arguments: unknown;
  approval_arguments_sha256: string;
  approval_estimated_units: number;
  approval_estimated_micro_usd: string;
}>;

type QueryRecord = Readonly<{
  sql: string;
  params: readonly unknown[];
  attempt: number;
  phase: QueryPhase;
}>;

type QueryPhase =
  | "begin"
  | "campaign-lock"
  | "scheduled-lock"
  | "reserve-call"
  | "dispatch-boundary"
  | "commit"
  | "rollback"
  | "other";

type QueryFailure = Readonly<{
  attempt: number;
  phase: QueryPhase;
  code: string;
}>;

function campaignApprovalArguments(): Record<string, unknown> & {
  cost_quote: OperatorCostQuoteV1;
} {
  const costQuote = createVoiceCampaignCostQuote({
    originE164: FROM,
    destinationE164s: [TO],
    targetSetSha256: TARGET_SET_SHA256,
    maxDurationSeconds: 900,
  }, {
    environment: PRICING_ENVIRONMENT,
    now: QUOTE_NOW,
  });
  return {
    schema_version: 1,
    action: "run_campaign",
    org_id: ORG_ID,
    agent_id: AGENT_ID,
    flow_id: FLOW_ID,
    dataset_id: DATASET_ID,
    dataset_slug: "members",
    phone_column: "phone",
    agent_version: runtimeSnapshot.agentVersion,
    flow_sha256: "3".repeat(64),
    runtime_admission_scope_id: RUNTIME_SCOPE_ID,
    runtime_digest: RUNTIME_DIGEST,
    target_set_sha256: TARGET_SET_SHA256,
    target_count: 1,
    skipped_count: 0,
    campaign_name: "Membership renewals",
    run_at: null,
    from_number: FROM,
    max_duration_seconds: 900,
    cost_quote: costQuote,
    worst_case_micro_usd: costQuote.reservationMicroUsd,
  };
}

function directApprovalArguments(
  capability: "schedule_call" | "place_call",
  toNumber: string
): Record<string, unknown> & { cost_quote: OperatorCostQuoteV1 } {
  const costQuote = createVoiceCostQuote({
    originE164: FROM,
    destinationE164: toNumber,
    maxDurationSeconds: 900,
  }, {
    environment: PRICING_ENVIRONMENT,
    now: QUOTE_NOW,
  });
  return {
    agent_id: AGENT_ID,
    agent_version: runtimeSnapshot.agentVersion,
    cost_quote: costQuote,
    from_number: FROM,
    max_duration_seconds: 900,
    reason: "Membership renewal",
    runtime_admission_scope_id: SCHEDULED_CALL_ID,
    runtime_digest: RUNTIME_DIGEST,
    to_number: toNumber,
    ...(capability === "schedule_call"
      ? { parent_call_id: null, run_at: "2026-07-17T18:30:00.000Z" }
      : {}),
  };
}

function campaignRow(overrides: Partial<CampaignRow> = {}): CampaignRow {
  const argumentsValue = campaignApprovalArguments();
  const argumentsSha256 = operatorActionArgumentsSha256("run_campaign", argumentsValue);
  return {
    id: CAMPAIGN_ID,
    org_id: ORG_ID,
    agent_id: AGENT_ID,
    flow_id: FLOW_ID,
    status: "running",
    operator_execution_id: CAMPAIGN_ID,
    operator_capability: "run_campaign",
    operator_status: "succeeded",
    operator_arguments_sha256: argumentsSha256,
    ...overrides,
  };
}

function campaignJob(overrides: Partial<JobRow> = {}): JobRow {
  const approvedArguments = campaignApprovalArguments();
  const argumentsSha256 = operatorActionArgumentsSha256("run_campaign", approvedArguments);
  const quote = approvedArguments.cost_quote;
  return {
    id: SCHEDULED_CALL_ID,
    agent_id: AGENT_ID,
    org_id: ORG_ID,
    to_number: TO,
    reason: REASON,
    flow_id: FLOW_ID,
    campaign_id: CAMPAIGN_ID,
    parent_call_id: null,
    agent_version: runtimeSnapshot.agentVersion,
    runtime_snapshot: runtimeSnapshot,
    runtime_digest: RUNTIME_DIGEST,
    phone_number: FROM,
    dispatch_started_at: null,
    operator_execution_id: CAMPAIGN_ID,
    operator_arguments_sha256: argumentsSha256,
    target_set_sha256: TARGET_SET_SHA256,
    manifest_capability: "run_campaign",
    authority_valid: true,
    operator_capability: "run_campaign",
    operator_status: "succeeded",
    current_operator_arguments_sha256: argumentsSha256,
    current_estimated_units: quote.units,
    current_estimated_micro_usd: String(quote.reservationMicroUsd),
    approved_action_arguments: approvedArguments,
    approval_arguments_sha256: argumentsSha256,
    approval_estimated_units: quote.units,
    approval_estimated_micro_usd: String(quote.reservationMicroUsd),
    ...overrides,
  };
}

function directJob(
  capability: "schedule_call" | "place_call",
  overrides: Partial<JobRow> = {}
): JobRow {
  const toNumber = overrides.to_number ?? TO;
  const approvedArguments = directApprovalArguments(capability, toNumber);
  const argumentsSha256 = operatorActionArgumentsSha256(capability, approvedArguments);
  const quote = approvedArguments.cost_quote;
  return campaignJob({
    reason: null,
    flow_id: null,
    campaign_id: null,
    operator_execution_id: SCHEDULED_CALL_ID,
    operator_arguments_sha256: argumentsSha256,
    target_set_sha256: null,
    manifest_capability: capability,
    operator_capability: capability,
    operator_status: capability === "schedule_call" ? "succeeded" : "dispatching",
    current_operator_arguments_sha256: argumentsSha256,
    current_estimated_units: quote.units,
    current_estimated_micro_usd: String(quote.reservationMicroUsd),
    approved_action_arguments: approvedArguments,
    approval_arguments_sha256: argumentsSha256,
    approval_estimated_units: quote.units,
    approval_estimated_micro_usd: String(quote.reservationMicroUsd),
    ...overrides,
  });
}

function phaseFor(sql: string): QueryPhase {
  if (sql === "BEGIN ISOLATION LEVEL SERIALIZABLE") return "begin";
  if (sql.includes("FOR UPDATE OF c")) return "campaign-lock";
  if (sql.includes("FOR UPDATE OF s")) return "scheduled-lock";
  if (sql.includes("INSERT INTO calls")) return "reserve-call";
  if (sql.includes("SET dispatch_started_at = now()")) return "dispatch-boundary";
  if (sql === "COMMIT") return "commit";
  if (sql === "ROLLBACK") return "rollback";
  return "other";
}

function admissionClient(options: {
  campaign?: CampaignRow | null;
  job?: JobRow | null;
  failures?: readonly QueryFailure[];
  timeline?: string[];
} = {}) {
  const records: QueryRecord[] = [];
  let attempt = 0;
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    const phase = phaseFor(sql);
    if (phase === "begin") attempt += 1;
    records.push({ sql, params, attempt, phase });
    options.timeline?.push(`admission:${phase}:${attempt}`);
    const failure = options.failures?.find((item) =>
      item.attempt === attempt && item.phase === phase
    );
    if (failure) throw Object.assign(new Error(`${phase} failed`), { code: failure.code });
    if (phase === "campaign-lock") {
      const campaign = options.campaign === undefined ? campaignRow() : options.campaign;
      return { rows: campaign ? [campaign] : [], rowCount: campaign ? 1 : 0 };
    }
    if (phase === "scheduled-lock") {
      const job = options.job === undefined ? campaignJob() : options.job;
      return { rows: job ? [job] : [], rowCount: job ? 1 : 0 };
    }
    if (phase === "reserve-call" || phase === "dispatch-boundary") {
      return { rows: [{ id: SCHEDULED_CALL_ID }], rowCount: 1 };
    }
    return { rows: [], rowCount: null };
  });
  return { query, release: vi.fn(), records };
}

function settlementClient(options: {
  failCallUpdate?: boolean;
  failScheduledUpdate?: boolean;
  timeline?: string[];
} = {}) {
  const records: { sql: string; params: readonly unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    records.push({ sql, params });
    if (sql === "BEGIN") options.timeline?.push("settlement:begin");
    if (sql.includes("UPDATE calls")) {
      options.timeline?.push("settlement:call");
      return options.failCallUpdate
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: SCHEDULED_CALL_ID }], rowCount: 1 };
    }
    if (sql.includes("UPDATE scheduled_calls")) {
      options.timeline?.push("settlement:scheduled");
      return options.failScheduledUpdate
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: SCHEDULED_CALL_ID }], rowCount: 1 };
    }
    if (sql === "COMMIT") options.timeline?.push("settlement:commit");
    if (sql === "ROLLBACK") options.timeline?.push("settlement:rollback");
    return { rows: [], rowCount: null };
  });
  return { query, release: vi.fn(), records };
}

type TestClient = Readonly<{
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}>;

function installClients(...clients: readonly TestClient[]) {
  for (const client of clients) mocks.connect.mockResolvedValueOnce(client);
}

function acceptedResponse(): Response {
  return new Response(JSON.stringify({ sid: CALL_SID, account_sid: ACCOUNT_SID }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

function dispatch(job: JobRow = campaignJob()) {
  return originateCall(job.agent_id, job.to_number, job.reason, {
    scheduledCallId: SCHEDULED_CALL_ID,
    claimToken: CLAIM_TOKEN,
    expectedAgentVersion: runtimeSnapshot.agentVersion,
    maxDurationSeconds: 900,
    runtimeSnapshot,
    runtimeDigest: RUNTIME_DIGEST,
  });
}

describe("Twilio origination dispatch boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockReset();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_ORIGIN", PUBLIC_ORIGIN);
    vi.stubEnv("BRIDGE_WS_URL", BRIDGE_WS_URL);
    vi.stubEnv("TWILIO_ACCOUNT_SID", ACCOUNT_SID);
    vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
    vi.stubEnv("TWILIO_API_KEY_TYPE", "restricted");
    vi.stubEnv("TWILIO_API_KEY_ACCOUNT_SID", ACCOUNT_SID);
    vi.stubEnv("TWILIO_API_KEY_SID", API_KEY_SID);
    vi.stubEnv("TWILIO_API_KEY_SECRET", API_KEY_SECRET);
    vi.stubEnv("TELEPHONY_RECEIPT_SECRET", RECEIPT_SECRET);
    for (const [key, value] of Object.entries(PRICING_ENVIRONMENT)) vi.stubEnv(key, value);
    vi.stubEnv("HACC_OPERATOR_CALL_MAX_DURATION_SECONDS", "900");
    mocks.getPool.mockImplementation(() => ({ connect: mocks.connect }));
    mocks.q.mockResolvedValue([{ id: SCHEDULED_CALL_ID }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("locks campaign before the job and commits a stable local identity before one provider request", async () => {
    const timeline: string[] = [];
    const admission = admissionClient({ timeline });
    const settlement = settlementClient({ timeline });
    installClients(admission, settlement);
    mocks.q.mockImplementation(async () => {
      timeline.push("identity:stamp");
      return [{ id: SCHEDULED_CALL_ID }];
    });
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchMock = vi.fn(async () => {
      timeline.push("provider:fetch");
      return acceptedResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatch();
    expect(result).toMatchObject({
      callId: SCHEDULED_CALL_ID,
      status: "accepted",
      code: "provider_accepted",
      delivery: {
        status: "accepted",
        evidence_source: "provider_create_response",
        verified_terminal: false,
        provider_message_id: CALL_SID,
        account_binding_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        recipient_binding_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(JSON.stringify(result)).not.toContain("terminal_proof_sha256");
    if (result.status !== "accepted") throw new Error("expected provider acceptance receipt");

    const campaignIndex = admission.records.findIndex((record) => record.phase === "campaign-lock");
    const scheduledIndex = admission.records.findIndex((record) => record.phase === "scheduled-lock");
    const reserve = admission.records.find((record) => record.phase === "reserve-call");
    const boundary = admission.records.find((record) => record.phase === "dispatch-boundary");
    expect(campaignIndex).toBeGreaterThan(-1);
    expect(campaignIndex).toBeLessThan(scheduledIndex);
    expect(reserve?.params[0]).toBe(SCHEDULED_CALL_ID);
    expect(boundary?.params[0]).toBe(SCHEDULED_CALL_ID);
    expect(timeline.indexOf("admission:commit:1")).toBeLessThan(timeline.indexOf("provider:fetch"));
    expect(timeline.indexOf("identity:stamp")).toBeLessThan(timeline.indexOf("settlement:begin"));
    expect(admission.release).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(15_000);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", signal: timeoutController.signal });
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from(`${API_KEY_SID}:${API_KEY_SECRET}`).toString("base64")}`
    );
    const form = new URLSearchParams(String(init.body));
    expect(form.get("To")).toBe(TO);
    expect(form.get("From")).toBe(FROM);
    expect(form.get("Url")).toBe(`${PUBLIC_ORIGIN}/api/telephony/twiml?callId=${SCHEDULED_CALL_ID}`);
    expect(form.getAll("StatusCallbackEvent")).toEqual([
      "initiated", "ringing", "answered", "completed",
    ]);

    expect(mocks.q).toHaveBeenCalledWith(
      expect.stringContaining("provider_accepted_identity_recorded"),
      [SCHEDULED_CALL_ID, CALL_SID, ACCOUNT_SID, JSON.stringify(result.delivery)]
    );
    const callSettlement = settlement.records.find((record) => record.sql.includes("UPDATE calls"));
    const jobSettlement = settlement.records.find((record) =>
      record.sql.includes("UPDATE scheduled_calls")
    );
    expect(callSettlement?.sql).toContain("twilio_call_sid = COALESCE(twilio_call_sid, $2)");
    expect(callSettlement?.sql).toContain("twilio_call_sid IS NULL OR twilio_call_sid = $2");
    expect(jobSettlement?.sql).toContain("claim_token IS NULL AND status = $3");
    expect(callSettlement?.params).toEqual([
      SCHEDULED_CALL_ID, CALL_SID, ACCOUNT_SID, "done", "provider_accepted",
    ]);
    expect(jobSettlement?.params).toEqual([
      SCHEDULED_CALL_ID, CLAIM_TOKEN, "done",
    ]);
  });

  it("rejects root-token-only REST configuration before reserving a call or contacting Twilio", async () => {
    vi.stubEnv("TWILIO_API_KEY_TYPE", "");
    vi.stubEnv("TWILIO_API_KEY_SID", "");
    vi.stubEnv("TWILIO_API_KEY_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(dispatch()).rejects.toThrow(
      "TWILIO_API_KEY_TYPE must be restricted for Twilio REST access"
    );
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets campaign cancellation win the lock race without provider spend", async () => {
    const admission = admissionClient({ campaign: campaignRow({ status: "canceled" }) });
    installClients(admission);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(dispatch()).rejects.toThrow("campaign authority is no longer dispatchable");
    expect(admission.records.map((record) => record.phase)).toEqual([
      "begin", "campaign-lock", "scheduled-lock", "rollback",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("rejects an expired or lost lease before the provider boundary", async () => {
    const admission = admissionClient({ job: null });
    installClients(admission);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(dispatch()).rejects.toThrow("scheduled call is not exclusively dispatchable");
    const lock = admission.records.find((record) => record.phase === "scheduled-lock");
    expect(lock?.sql).toContain("s.claim_lease_expires_at > now()");
    expect(lock?.params).toEqual([SCHEDULED_CALL_ID, CLAIM_TOKEN]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["authority manifest", { authority_valid: false }],
    ["operator argument hash", { current_operator_arguments_sha256: "9".repeat(64) }],
    ["operator capability", { manifest_capability: "place_call" }],
    ["runtime digest", { runtime_digest: "8".repeat(64) }],
  ] satisfies readonly [string, Partial<JobRow>][]) (
    "rejects an exact %s mismatch without provider spend",
    async (_label, override) => {
      const job = campaignJob(override);
      const admission = admissionClient({ job });
      installClients(admission);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(dispatch(job)).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(admission.records.some((record) => record.phase === "reserve-call")).toBe(false);
    }
  );

  it.each([
    ["missing consumed approval", { approved_action_arguments: null }],
    ["execution unit drift", { current_estimated_units: 16 }],
    ["approval unit drift", { approval_estimated_units: 16 }],
    ["execution reservation drift", { current_estimated_micro_usd: "5000001" }],
    ["approval reservation drift", { approval_estimated_micro_usd: "5000001" }],
  ] satisfies readonly [string, Partial<JobRow>][])(
    "rejects %s before reserving a call or contacting Twilio",
    async (_label, override) => {
      const job = campaignJob(override);
      const admission = admissionClient({ job });
      installClients(admission);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(dispatch(job)).rejects.toThrow();
      expect(admission.records.some((record) => record.phase === "reserve-call")).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("fails closed when current configured voice pricing exceeds the consumed reservation", async () => {
    vi.stubEnv("HACC_OPERATOR_VOICE_MINUTE_CEILING_USD", "0.5");
    const job = campaignJob();
    const admission = admissionClient({ job });
    installClients(admission);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(dispatch(job)).rejects.toThrow(
      "Approved voice reservation no longer covers current configured pricing"
    );
    expect(admission.records.some((record) => record.phase === "reserve-call")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-reads authority on serialization and deadlock retries, then sends exactly once", async () => {
    const admission = admissionClient({
      failures: [
        { attempt: 1, phase: "reserve-call", code: "40001" },
        { attempt: 2, phase: "dispatch-boundary", code: "40P01" },
      ],
    });
    const settlement = settlementClient();
    installClients(admission, settlement);
    const fetchMock = vi.fn(async () => acceptedResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(dispatch()).resolves.toMatchObject({ status: "accepted", code: "provider_accepted" });
    expect(admission.records.filter((record) => record.phase === "begin")).toHaveLength(3);
    expect(admission.records.filter((record) => record.phase === "campaign-lock")).toHaveLength(3);
    expect(admission.records.filter((record) => record.phase === "scheduled-lock")).toHaveLength(3);
    expect(admission.records.filter((record) => record.phase === "rollback")).toHaveLength(2);
    expect(admission.records.filter((record) => record.phase === "commit")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bounds serializable admission retries at three attempts and never crosses the boundary", async () => {
    const admission = admissionClient({
      failures: [1, 2, 3].map((attempt) => ({
        attempt,
        phase: "reserve-call" as const,
        code: attempt === 2 ? "40P01" : "40001",
      })),
    });
    installClients(admission);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(dispatch()).rejects.toMatchObject({ code: "40001" });
    expect(admission.records.filter((record) => record.phase === "begin")).toHaveLength(3);
    expect(admission.records.filter((record) => record.phase === "campaign-lock")).toHaveLength(3);
    expect(admission.records.filter((record) => record.phase === "scheduled-lock")).toHaveLength(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on an ambiguous COMMIT even when it carries a retryable SQLSTATE", async () => {
    const admission = admissionClient({
      failures: [{ attempt: 1, phase: "commit", code: "40001" }],
    });
    installClients(admission);
    const fetchMock = vi.fn(async () => acceptedResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(dispatch()).rejects.toMatchObject({ code: "40001" });
    expect(admission.records.filter((record) => record.phase === "begin")).toHaveLength(1);
    expect(admission.records.filter((record) => record.phase === "commit")).toHaveLength(1);
    expect(admission.records.filter((record) => record.phase === "rollback")).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("classifies provider 4xx as a definite failure without retry", async () => {
    const admission = admissionClient();
    const settlement = settlementClient();
    installClients(admission, settlement);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: "invalid To" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(dispatch()).resolves.toEqual({
      callId: SCHEDULED_CALL_ID,
      status: "failed",
      code: "provider_rejected",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.q).not.toHaveBeenCalled();
    const jobSettlement = settlement.records.find((record) =>
      record.sql.includes("UPDATE scheduled_calls")
    );
    expect(jobSettlement?.params).toEqual([SCHEDULED_CALL_ID, CLAIM_TOKEN, "failed"]);
  });

  it("does not echo a private recipient from a provider 4xx body into logs or results", async () => {
    const job = campaignJob({ to_number: PRIVATE_TO_SENTINEL });
    const admission = admissionClient({ job });
    const settlement = settlementClient();
    installClients(admission, settlement);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: `invalid recipient ${PRIVATE_TO_SENTINEL}`,
    }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatch(job);
    expect(result).toMatchObject({ status: "failed", code: "provider_rejected" });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_TO_SENTINEL);
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(PRIVATE_TO_SENTINEL);
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(PRIVATE_TO_SENTINEL);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not put a successfully dialed private recipient in structured logs", async () => {
    const job = campaignJob({ to_number: PRIVATE_TO_SENTINEL });
    const admission = admissionClient({ job });
    const settlement = settlementClient();
    installClients(admission, settlement);
    const fetchMock = vi.fn(async () => acceptedResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatch(job);
    expect(result).toMatchObject({ status: "accepted", code: "provider_accepted" });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_TO_SENTINEL);
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(PRIVATE_TO_SENTINEL);
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(PRIVATE_TO_SENTINEL);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "server error"] as const)(
    "classifies a provider %s as indeterminate and never retries after the durable boundary",
    async (failure) => {
      const admission = admissionClient();
      const settlement = settlementClient();
      installClients(admission, settlement);
      const fetchMock = failure === "timeout"
        ? vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); })
        : vi.fn(async () => new Response(JSON.stringify({ message: "unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(dispatch()).resolves.toEqual({
        callId: SCHEDULED_CALL_ID,
        status: "indeterminate",
        code: "provider_outcome_unknown_do_not_retry",
      });
      expect(admission.records.filter((record) => record.phase === "begin")).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(mocks.q).not.toHaveBeenCalled();
      const jobSettlement = settlement.records.find((record) =>
        record.sql.includes("UPDATE scheduled_calls")
      );
      expect(jobSettlement?.params).toEqual([SCHEDULED_CALL_ID, CLAIM_TOKEN, "indeterminate"]);
    }
  );

  it("surfaces accepted-provider settlement failure with the durable identities and never redials", async () => {
    const admission = admissionClient();
    const settlement = settlementClient({ failScheduledUpdate: true });
    installClients(admission, settlement);
    const fetchMock = vi.fn(async () => acceptedResponse());
    vi.stubGlobal("fetch", fetchMock);

    const error = await dispatch().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AcceptedProviderSettlementError);
    expect(error).toMatchObject({
      code: "provider_accepted_local_settlement_unknown_do_not_retry",
      callId: SCHEDULED_CALL_ID,
      providerCallSid: CALL_SID,
      providerAccountSid: ACCOUNT_SID,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.q).toHaveBeenCalledOnce();
    expect(settlement.records.some((record) => record.sql === "ROLLBACK")).toBe(true);
  });

  it.each([
    ["schedule_call", "succeeded"],
    ["place_call", "dispatching"],
  ] as const)(
    "accepts direct %s authority with a distinct execution ID when the manifest binds the call ID",
    async (capability, expectedStatus) => {
      const job = directJob(capability, { operator_execution_id: OTHER_EXECUTION_ID });
      const admission = admissionClient({ campaign: null, job });
      const settlement = settlementClient();
      installClients(admission, settlement);
      const fetchMock = vi.fn(async () => acceptedResponse());
      vi.stubGlobal("fetch", fetchMock);

      await expect(dispatch(job)).resolves.toMatchObject({ status: "accepted" });
      expect(job.operator_status).toBe(expectedStatus);
      expect(job.id).not.toBe(job.operator_execution_id);
      expect(admission.records.find((record) => record.phase === "scheduled-lock")?.sql)
        .toContain("'callId', s.id::text");
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ["schedule_call", "succeeded"],
    ["place_call", "dispatching"],
  ] as const)(
    "rejects direct %s authority when the manifest does not bind the scheduled call ID",
    async (capability, operatorStatus) => {
      const job = directJob(capability, {
        operator_execution_id: OTHER_EXECUTION_ID,
        operator_status: operatorStatus,
        authority_valid: false,
      });
      const admission = admissionClient({ campaign: null, job });
      installClients(admission);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(dispatch(job)).rejects.toThrow("scheduled call authority does not match the requested dispatch");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(admission.records.some((record) => record.phase === "reserve-call")).toBe(false);
    }
  );
});
