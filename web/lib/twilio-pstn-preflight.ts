import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";

const ACCOUNT_SID_PATTERN = /^AC[0-9a-f]{32}$/i;
const API_KEY_SID_PATTERN = /^SK[0-9a-f]{32}$/i;
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
const SHA256_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_RESPONSE_BYTES = 256 * 1024;
const TWILIO_API_ORIGIN = "https://api.twilio.com";
const RECEIPT_DOMAIN = "harshas-amazing-call-center/twilio-pstn-preflight/v1\n";

export const TWILIO_PSTN_AUTHORITY_CEILING_USD = 30;

export type TwilioPstnPreflightBlocker = Readonly<{
  code: string;
  message: string;
  remediation: string;
}>;

export type TwilioPstnPreflightSource = Readonly<{
  branch: string;
  commit: string;
  tree: string;
  clean: boolean;
}>;

type ProbeState = "not_requested" | "skipped_local_blockers" | "passed" | "failed";

type ProbeResult = Readonly<{
  status: ProbeState;
  http_status: number | null;
  detail_code: string | null;
}>;

export type TwilioPstnPreflightReceipt = Readonly<{
  schema_version: 1;
  artifact_type: "twilio_pstn_preflight_receipt";
  created_at: string;
  source: TwilioPstnPreflightSource;
  authority: Readonly<{
    requested_max_usd: number | null;
    hard_ceiling_usd: 30;
    within_ceiling: boolean;
    provider_mutations_authorized: false;
  }>;
  configuration: Readonly<{
    account_binding_sha256: string | null;
    api_key_binding_sha256: string | null;
    caller_binding_sha256: string | null;
    destination_binding_sha256: string | null;
    restricted_key_attested: boolean;
    key_account_binding_attested: boolean;
    inbound_signature_secret_present: boolean;
    inbound_signature_rotation_staged: boolean;
    domain_specific_receipt_secret_present: boolean;
    bridge_stream_url: string | null;
    bridge_is_standalone: boolean;
  }>;
  probes: Readonly<{
    explicitly_requested: boolean;
    network_policy: "disabled" | "read_only_get_allowlist";
    account: ProbeResult;
    owned_voice_caller: ProbeResult;
    bridge_readiness: ProbeResult;
  }>;
  blockers: readonly TwilioPstnPreflightBlocker[];
  ready: boolean;
  next_exact_step: string;
  safety: Readonly<{
    calls_created: 0;
    sms_created: 0;
    provider_mutations: 0;
    secrets_emitted: false;
  }>;
  receipt_sha256: string;
}>;

export type TwilioPstnPreflightInput = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  source: TwilioPstnPreflightSource;
  requestedMaxUsd: string | undefined;
  probeReadOnly: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function binding(label: string, value: string | undefined): string | null {
  return value ? sha256(`${RECEIPT_DOMAIN}${label}\n${value}`) : null;
}

function privateBinding(
  label: string,
  value: string | undefined,
  receiptSecret: string | undefined,
): string | null {
  if (!value || !receiptSecret) return null;
  return createHmac("sha256", receiptSecret)
    .update(`${RECEIPT_DOMAIN}${label}\n${value}`, "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("receipt contains a non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("receipt is not JSON serializable");
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (entries.some(([, item]) => item === undefined)) {
    throw new TypeError("receipt contains an undefined value");
  }
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function blocker(
  code: string,
  message: string,
  remediation: string,
): TwilioPstnPreflightBlocker {
  return Object.freeze({ code, message, remediation });
}

function isControlFreeSecret(value: string | undefined, minimum: number): value is string {
  return Boolean(
    value
    && value.length >= minimum
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value),
  );
}

function parseUsd(raw: string | undefined): number | null {
  if (!raw || !/^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function canonicalBridgeUrl(
  raw: string | undefined,
): Readonly<{ url: URL | null; code: string | null }> {
  if (!raw || raw.trim() !== raw || raw.length > 2_048 || raw.includes("\\")) {
    return Object.freeze({ url: null, code: "bridge_url_missing_or_invalid" });
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return Object.freeze({ url: null, code: "bridge_url_missing_or_invalid" });
  }
  if (
    parsed.protocol !== "wss:"
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== "/stream"
    || raw !== parsed.href
  ) {
    return Object.freeze({
      url: null,
      code: parsed.pathname === "/api/bridge" ? "legacy_bridge_url" : "bridge_url_not_canonical",
    });
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    isIP(hostname) !== 0
    || !hostname.includes(".")
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
  ) {
    return Object.freeze({ url: null, code: "bridge_url_not_public" });
  }
  return Object.freeze({ url: parsed, code: null });
}

function standaloneBridge(parsed: URL | null, publicOrigin: string | undefined): boolean {
  if (!parsed) return false;
  if (!publicOrigin) return true;
  try {
    const application = new URL(publicOrigin);
    return parsed.hostname.toLowerCase() !== application.hostname.toLowerCase();
  } catch {
    return false;
  }
}

function emptyProbe(status: ProbeState): ProbeResult {
  return Object.freeze({ status, http_status: null, detail_code: null });
}

async function boundedJson(response: Response): Promise<Record<string, unknown> | null> {
  const advertised = response.headers.get("content-length");
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_RESPONSE_BYTES)) {
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function getJson(
  fetchImpl: typeof fetch,
  url: URL,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<Readonly<{ response: Response; body: Record<string, unknown> | null }> | null> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return Object.freeze({ response, body: await boundedJson(response) });
  } catch {
    return null;
  }
}

function probeFailure(httpStatus: number | null, detailCode: string): ProbeResult {
  return Object.freeze({ status: "failed", http_status: httpStatus, detail_code: detailCode });
}

async function runReadOnlyProbes(input: Readonly<{
  fetchImpl: typeof fetch;
  timeoutMs: number;
  accountSid: string;
  keySid: string;
  keySecret: string;
  caller: string;
  bridge: URL;
}>): Promise<Readonly<{
  account: ProbeResult;
  ownedVoiceCaller: ProbeResult;
  bridgeReadiness: ProbeResult;
  blockers: readonly TwilioPstnPreflightBlocker[];
}>> {
  const authorization = `Basic ${Buffer.from(`${input.keySid}:${input.keySecret}`, "utf8").toString("base64")}`;
  const accountUrl = new URL(
    `/2010-04-01/Accounts/${encodeURIComponent(input.accountSid)}.json`,
    TWILIO_API_ORIGIN,
  );
  const numberUrl = new URL(
    `/2010-04-01/Accounts/${encodeURIComponent(input.accountSid)}/IncomingPhoneNumbers.json`,
    TWILIO_API_ORIGIN,
  );
  numberUrl.searchParams.set("PhoneNumber", input.caller);
  numberUrl.searchParams.set("PageSize", "20");
  const readyUrl = new URL(`https://${input.bridge.host}/health/ready`);
  const twilioHeaders = Object.freeze({
    accept: "application/json",
    authorization,
  });

  const [accountResult, numberResult, readyResult] = await Promise.all([
    getJson(input.fetchImpl, accountUrl, twilioHeaders, input.timeoutMs),
    getJson(input.fetchImpl, numberUrl, twilioHeaders, input.timeoutMs),
    getJson(input.fetchImpl, readyUrl, Object.freeze({ accept: "application/json" }), input.timeoutMs),
  ]);
  const blockers: TwilioPstnPreflightBlocker[] = [];

  let account: ProbeResult;
  if (!accountResult) {
    account = probeFailure(null, "network_error");
    blockers.push(blocker(
      "twilio_account_probe_failed",
      "The read-only Twilio account probe could not complete.",
      "Check network access and rerun with --probe-read-only; do not originate a call.",
    ));
  } else if (accountResult.response.status === 401 || accountResult.response.status === 403) {
    account = probeFailure(accountResult.response.status, "authentication_rejected");
    blockers.push(blocker(
      "twilio_api_key_auth_rejected",
      "Twilio rejected the attested Restricted API key during a read-only account request.",
      "Replace or reauthorize the Restricted key for the configured account, then rerun the preflight.",
    ));
  } else if (
    !accountResult.response.ok
    || accountResult.body?.sid !== input.accountSid
    || accountResult.body?.status !== "active"
  ) {
    account = probeFailure(accountResult.response.status, "account_not_active_or_mismatched");
    blockers.push(blocker(
      "twilio_account_not_active_or_mismatched",
      "The read-only account response did not prove the configured account is active and key-bound.",
      "Review the Twilio account/key binding and rerun the preflight.",
    ));
  } else {
    account = Object.freeze({ status: "passed", http_status: accountResult.response.status, detail_code: null });
  }

  let ownedVoiceCaller: ProbeResult;
  if (!numberResult) {
    ownedVoiceCaller = probeFailure(null, "network_error");
    blockers.push(blocker(
      "twilio_owned_number_probe_failed",
      "The read-only owned-number probe could not complete.",
      "Check network access and rerun with --probe-read-only; do not originate a call.",
    ));
  } else if (numberResult.response.status === 401 || numberResult.response.status === 403) {
    ownedVoiceCaller = probeFailure(numberResult.response.status, "authentication_rejected");
    blockers.push(blocker(
      "twilio_number_key_auth_rejected",
      "Twilio rejected the attested Restricted API key during the read-only number request.",
      "Grant the reviewed key read access to incoming numbers and rerun the preflight.",
    ));
  } else {
    const numbers = numberResult.body?.incoming_phone_numbers;
    const owned = Array.isArray(numbers) && numbers.some((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const record = candidate as Record<string, unknown>;
      const capabilities = record.capabilities;
      return record.phone_number === input.caller
        && capabilities !== null
        && typeof capabilities === "object"
        && !Array.isArray(capabilities)
        && (capabilities as Record<string, unknown>).voice === true;
    });
    if (!numberResult.response.ok || !owned) {
      ownedVoiceCaller = probeFailure(numberResult.response.status, "caller_not_owned_and_voice_enabled");
      blockers.push(blocker(
        "twilio_caller_not_owned_voice_number",
        "The configured caller was not proven to be an owned, voice-enabled Twilio number.",
        "Set TWILIO_PHONE_NUMBER to an owned voice-enabled number and rerun the preflight.",
      ));
    } else {
      ownedVoiceCaller = Object.freeze({
        status: "passed",
        http_status: numberResult.response.status,
        detail_code: null,
      });
    }
  }

  let bridgeReadiness: ProbeResult;
  if (!readyResult) {
    bridgeReadiness = probeFailure(null, "network_error");
    blockers.push(blocker(
      "bridge_readiness_probe_failed",
      "The standalone bridge readiness probe could not complete.",
      "Deploy or inspect the exact bridge release, then rerun the read-only preflight.",
    ));
  } else if (
    !readyResult.response.ok
    || readyResult.body?.ok !== true
    || readyResult.body?.status !== "ready"
    || !Number.isSafeInteger(readyResult.body?.active_sessions)
    || Number(readyResult.body?.active_sessions) < 0
  ) {
    bridgeReadiness = probeFailure(readyResult.response.status, "not_ready");
    blockers.push(blocker(
      "bridge_not_ready",
      "The standalone bridge did not return its exact ready contract.",
      "Restore GET /health/ready to {ok:true,status:\"ready\",active_sessions:<integer>} and rerun.",
    ));
  } else {
    bridgeReadiness = Object.freeze({
      status: "passed",
      http_status: readyResult.response.status,
      detail_code: null,
    });
  }

  return Object.freeze({ account, ownedVoiceCaller, bridgeReadiness, blockers });
}

function nextStep(blockers: readonly TwilioPstnPreflightBlocker[], probeReadOnly: boolean): string {
  if (blockers.length > 0) return blockers[0].remediation;
  if (!probeReadOnly) {
    return "Rerun this exact source with --probe-read-only; the command will issue three GET requests and no mutations.";
  }
  return "Preflight admitted; retain this receipt before any separately authorized, receipt-bound PSTN canary.";
}

export async function runTwilioPstnPreflight(
  input: TwilioPstnPreflightInput,
): Promise<TwilioPstnPreflightReceipt> {
  const env = input.environment;
  const blockers: TwilioPstnPreflightBlocker[] = [];
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const nextAuthToken = env.TWILIO_AUTH_TOKEN_NEXT;
  const keySid = env.TWILIO_API_KEY_SID;
  const keySecret = env.TWILIO_API_KEY_SECRET;
  const caller = env.TWILIO_PHONE_NUMBER;
  const destination = env.TWILIO_APPROVED_TEST_TO;
  const receiptSecret = env.TELEPHONY_RECEIPT_SECRET;
  const requestedMaxUsd = parseUsd(input.requestedMaxUsd);
  const bridgeResult = canonicalBridgeUrl(env.BRIDGE_WS_URL);
  const bridgeIsStandalone = standaloneBridge(bridgeResult.url, env.PUBLIC_ORIGIN);

  if (!input.source.clean || !SHA256_PATTERN.test(input.source.commit) || !SHA256_PATTERN.test(input.source.tree)) {
    blockers.push(blocker(
      "source_not_release_bound",
      "The preflight source is dirty or lacks valid Git commit/tree bindings.",
      "Commit the intended release source, restore a clean worktree, and rerun the preflight.",
    ));
  }
  if (!ACCOUNT_SID_PATTERN.test(accountSid ?? "")) {
    blockers.push(blocker(
      "twilio_account_sid_invalid",
      "TWILIO_ACCOUNT_SID is missing or malformed.",
      "Configure the canonical AC-prefixed account SID in the private environment.",
    ));
  }
  if (!isControlFreeSecret(authToken, 20)) {
    blockers.push(blocker(
      "twilio_inbound_auth_secret_invalid",
      "TWILIO_AUTH_TOKEN is missing or malformed for inbound signature verification.",
      "Configure the account auth token in the private bridge/web secret stores; do not paste it into evidence.",
    ));
  }
  if (nextAuthToken !== undefined && nextAuthToken !== "" && (
    !isControlFreeSecret(nextAuthToken, 20) || nextAuthToken === authToken
  )) {
    blockers.push(blocker(
      "twilio_rotation_auth_secret_invalid",
      "TWILIO_AUTH_TOKEN_NEXT is malformed or duplicates the current primary token.",
      "Stage one distinct Twilio secondary token in both private bridge/web secret stores, or remove TWILIO_AUTH_TOKEN_NEXT outside a rotation window.",
    ));
  }
  if (env.TWILIO_API_KEY_TYPE !== "restricted") {
    blockers.push(blocker(
      "twilio_key_not_restricted",
      "TWILIO_API_KEY_TYPE does not explicitly attest a Restricted key.",
      "Issue or review a Restricted key and set TWILIO_API_KEY_TYPE=restricted.",
    ));
  }
  if (!accountSid || env.TWILIO_API_KEY_ACCOUNT_SID !== accountSid) {
    blockers.push(blocker(
      "twilio_key_account_binding_mismatch",
      "TWILIO_API_KEY_ACCOUNT_SID does not exactly bind the key to TWILIO_ACCOUNT_SID.",
      "Set the key-account attestation to the exact configured account SID after reviewing the key.",
    ));
  }
  if (!API_KEY_SID_PATTERN.test(keySid ?? "") || !isControlFreeSecret(keySecret, 20)) {
    blockers.push(blocker(
      "twilio_restricted_key_invalid",
      "The Restricted API key SID/secret pair is missing or malformed.",
      "Configure a reviewed SK-prefixed Restricted key pair in the private environment.",
    ));
  }
  if (!E164_PATTERN.test(caller ?? "")) {
    blockers.push(blocker(
      "twilio_caller_invalid",
      "TWILIO_PHONE_NUMBER is missing or is not canonical E.164.",
      "Set TWILIO_PHONE_NUMBER to the canonical E.164 owned caller.",
    ));
  }
  if (!E164_PATTERN.test(destination ?? "")) {
    blockers.push(blocker(
      "approved_destination_missing",
      "TWILIO_APPROVED_TEST_TO is missing or is not canonical E.164.",
      "Set one user-approved destination in TWILIO_APPROVED_TEST_TO in the private environment.",
    ));
  }
  const receiptDistinct = isControlFreeSecret(receiptSecret, 32)
    && ![authToken, nextAuthToken, keySecret, env.MCP_GATEWAY_SECRET].some(
      (credential) => credential && credential === receiptSecret,
    );
  if (!receiptDistinct) {
    blockers.push(blocker(
      "telephony_receipt_secret_invalid",
      "TELEPHONY_RECEIPT_SECRET is missing, malformed, or reused from another credential domain.",
      "Generate a fresh 32-256 character receipt-only secret and store it privately.",
    ));
  }
  if (bridgeResult.code !== null) {
    blockers.push(blocker(
      bridgeResult.code,
      bridgeResult.code === "legacy_bridge_url"
        ? "BRIDGE_WS_URL still targets the legacy /api/bridge route."
        : "BRIDGE_WS_URL is not a canonical public wss:// host with exact path /stream.",
      "Deploy the standalone bridge and set BRIDGE_WS_URL to its exact credential-free wss://<host>/stream URL.",
    ));
  } else if (!bridgeIsStandalone) {
    blockers.push(blocker(
      "bridge_url_not_standalone",
      "BRIDGE_WS_URL resolves to the same host as PUBLIC_ORIGIN instead of a standalone bridge host.",
      "Deploy the bridge on its dedicated public host and set its exact /stream URL.",
    ));
  }
  if (env.BRIDGE_PUBLIC_STREAM_URL && env.BRIDGE_PUBLIC_STREAM_URL !== env.BRIDGE_WS_URL) {
    blockers.push(blocker(
      "bridge_url_binding_mismatch",
      "BRIDGE_PUBLIC_STREAM_URL and BRIDGE_WS_URL are not byte-identical.",
      "Configure both components with the same canonical public /stream URL bytes.",
    ));
  }
  if (requestedMaxUsd === null || requestedMaxUsd > TWILIO_PSTN_AUTHORITY_CEILING_USD) {
    blockers.push(blocker(
      "spend_ceiling_invalid",
      "The requested maximum is missing, malformed, or exceeds the $30 Twilio authority ceiling.",
      "Rerun with --max-usd set to a positive amount no greater than 30.",
    ));
  }

  let accountProbe = emptyProbe(input.probeReadOnly ? "skipped_local_blockers" : "not_requested");
  let numberProbe = emptyProbe(input.probeReadOnly ? "skipped_local_blockers" : "not_requested");
  let readinessProbe = emptyProbe(input.probeReadOnly ? "skipped_local_blockers" : "not_requested");
  if (
    input.probeReadOnly
    && blockers.length === 0
    && accountSid
    && keySid
    && keySecret
    && caller
    && bridgeResult.url
  ) {
    const probes = await runReadOnlyProbes({
      fetchImpl: input.fetchImpl ?? fetch,
      timeoutMs: input.timeoutMs ?? 10_000,
      accountSid,
      keySid,
      keySecret,
      caller,
      bridge: bridgeResult.url,
    });
    accountProbe = probes.account;
    numberProbe = probes.ownedVoiceCaller;
    readinessProbe = probes.bridgeReadiness;
    blockers.push(...probes.blockers);
  }

  const body = Object.freeze({
    schema_version: 1 as const,
    artifact_type: "twilio_pstn_preflight_receipt" as const,
    created_at: (input.now ?? (() => new Date()))().toISOString(),
    source: Object.freeze({ ...input.source }),
    authority: Object.freeze({
      requested_max_usd: requestedMaxUsd,
      hard_ceiling_usd: TWILIO_PSTN_AUTHORITY_CEILING_USD as 30,
      within_ceiling: requestedMaxUsd !== null && requestedMaxUsd <= TWILIO_PSTN_AUTHORITY_CEILING_USD,
      provider_mutations_authorized: false as const,
    }),
    configuration: Object.freeze({
      account_binding_sha256: binding("account", accountSid),
      api_key_binding_sha256: binding("api-key", keySid),
      caller_binding_sha256: privateBinding("caller", caller, receiptDistinct ? receiptSecret : undefined),
      destination_binding_sha256: privateBinding(
        "destination",
        destination,
        receiptDistinct ? receiptSecret : undefined,
      ),
      restricted_key_attested: env.TWILIO_API_KEY_TYPE === "restricted",
      key_account_binding_attested: Boolean(accountSid && env.TWILIO_API_KEY_ACCOUNT_SID === accountSid),
      inbound_signature_secret_present: isControlFreeSecret(authToken, 20),
      inbound_signature_rotation_staged: isControlFreeSecret(nextAuthToken, 20)
        && nextAuthToken !== authToken,
      domain_specific_receipt_secret_present: receiptDistinct,
      bridge_stream_url: bridgeResult.url?.href ?? null,
      bridge_is_standalone: bridgeIsStandalone,
    }),
    probes: Object.freeze({
      explicitly_requested: input.probeReadOnly,
      network_policy: input.probeReadOnly ? "read_only_get_allowlist" as const : "disabled" as const,
      account: accountProbe,
      owned_voice_caller: numberProbe,
      bridge_readiness: readinessProbe,
    }),
    blockers: Object.freeze(blockers),
    ready: blockers.length === 0,
    next_exact_step: nextStep(blockers, input.probeReadOnly),
    safety: Object.freeze({
      calls_created: 0 as const,
      sms_created: 0 as const,
      provider_mutations: 0 as const,
      secrets_emitted: false as const,
    }),
  });
  return Object.freeze({
    ...body,
    receipt_sha256: sha256(`${RECEIPT_DOMAIN}${canonicalJson(body)}`),
  });
}

export function twilioPstnPreflightExitCode(receipt: TwilioPstnPreflightReceipt): 0 | 2 {
  return receipt.blockers.length === 0 ? 0 : 2;
}
