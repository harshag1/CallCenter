"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, ShieldCheck, X } from "lucide-react";

export type OperatorActionApprovalStatus =
  | "pending"
  | "approving"
  | "accepted"
  | "delivered"
  | "succeeded"
  | "rejected"
  | "indeterminate";

export type OperatorActionConfirmationItem = Readonly<{
  kind: "operator_action_confirmation";
  proposalId: string;
  capability: string;
  arguments: Readonly<Record<string, unknown>>;
  argumentsSha256: string;
  estimatedUnits: number;
  worstCaseMicroUsd: number;
  expiresAt: string;
  status: OperatorActionApprovalStatus;
}>;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const FUNDED_CAPABILITIES = new Set([
  "send_email",
  "send_sms",
  "place_call",
  "schedule_call",
  "provision_phone_number",
  "run_campaign",
]);
const E164 = /^\+[1-9]\d{6,14}$/;
const INVISIBLE_OR_DIRECTIONAL = /[\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const TERMINAL_STATUSES = new Set<OperatorActionApprovalStatus>([
  "accepted",
  "delivered",
  "succeeded",
  "rejected",
  "indeterminate",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type JsonCloneBudget = { nodes: number };

function cloneFrozenJson(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
  budget: JsonCloneBudget = { nodes: 0 },
): unknown {
  budget.nodes += 1;
  if (depth > 64 || budget.nodes > 10_000) throw new Error("proposal JSON exceeds structural limits");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error("unsafe proposal number");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error("invalid proposal JSON");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((entry) => cloneFrozenJson(entry, ancestors, depth + 1, budget)));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error("invalid proposal object");
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      if (key.length > 256) throw new Error("proposal key exceeds limit");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("proposal accessors are forbidden");
      output[key] = cloneFrozenJson(descriptor.value, ancestors, depth + 1, budget);
    }
    return Object.freeze(output);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Project the wire proposal into the only fields the browser needs. The
 * canonical argument commitment is retained for exact human review; every
 * server execution secret is discarded and therefore cannot be rendered.
 */
export function operatorActionConfirmationFromWire(value: unknown): OperatorActionConfirmationItem | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (typeof value.proposalId !== "string" || !UUID.test(value.proposalId)) return null;
  if (typeof value.capability !== "string" || !FUNDED_CAPABILITIES.has(value.capability)) return null;
  if (!isRecord(value.arguments)) return null;
  if (typeof value.argumentsSha256 !== "string" || !SHA256.test(value.argumentsSha256)) return null;
  if (!Number.isSafeInteger(value.estimatedUnits) || Number(value.estimatedUnits) < 1) return null;
  if (!Number.isSafeInteger(value.worstCaseMicroUsd) || Number(value.worstCaseMicroUsd) < 0) return null;
  if (typeof value.expiresAt !== "string" || value.expiresAt.length > 64) return null;
  if (!Number.isFinite(Date.parse(value.expiresAt))) return null;

  let argumentsValue: Readonly<Record<string, unknown>>;
  try {
    argumentsValue = cloneFrozenJson(value.arguments) as Readonly<Record<string, unknown>>;
    if (new TextEncoder().encode(JSON.stringify(argumentsValue)).byteLength > 64 * 1024) return null;
  } catch {
    return null;
  }

  return Object.freeze({
    kind: "operator_action_confirmation",
    proposalId: value.proposalId,
    capability: value.capability,
    arguments: argumentsValue,
    argumentsSha256: value.argumentsSha256,
    estimatedUnits: Number(value.estimatedUnits),
    worstCaseMicroUsd: Number(value.worstCaseMicroUsd),
    expiresAt: value.expiresAt,
    status: "pending",
  });
}

export function withOperatorActionApprovalStatus(
  item: OperatorActionConfirmationItem,
  proposalId: string,
  status: OperatorActionApprovalStatus
): OperatorActionConfirmationItem {
  if (item.proposalId !== proposalId || item.status === status || TERMINAL_STATUSES.has(item.status)) {
    return item;
  }
  const validTransition =
    (item.status === "pending" && status === "approving")
    || (item.status === "approving" && TERMINAL_STATUSES.has(status));
  return validTransition ? Object.freeze({ ...item, status }) : item;
}

function capabilityLabel(capability: string): string {
  return capability
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

/** Preserve all six decimal places so the displayed maximum is exact to the micro-dollar. */
function exactUsd(microUsd: number): string {
  const dollars = Math.floor(microUsd / 1_000_000);
  const micros = microUsd % 1_000_000;
  const groupedDollars = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${groupedDollars}.${String(micros).padStart(6, "0")} USD`;
}

function authoritativeStatus(payload: unknown, responseStatus: number): OperatorActionApprovalStatus {
  if (isRecord(payload)) {
    const status = payload.status;
    if (status === "accepted" || status === "delivered" || status === "succeeded"
        || status === "rejected" || status === "indeterminate") return status;
  }
  // The route's pre-dispatch validation failures are 4xx. A conflict or any
  // server/network ambiguity must never be presented as a safe retry.
  if (responseStatus >= 400 && responseStatus < 500 && responseStatus !== 409) return "rejected";
  return "indeterminate";
}

const STATUS_RECONCILIATION_DELAYS_MS = Object.freeze([0, 250, 750, 1_500] as const);

type StatusFetch = (
  input: string,
  init: RequestInit,
) => Promise<Pick<Response, "status" | "json">>;

type ReconciledOperatorActionStatus = Readonly<{
  payload: unknown;
  status: OperatorActionApprovalStatus;
}>;

/**
 * A response-loss recovery path, never an approval retry. PUT only reads the
 * exact execution ledger and can therefore be repeated without provider I/O.
 */
export async function reconcileOperatorActionStatus(
  proposalId: string,
  options: Readonly<{
    signal?: AbortSignal;
    fetchImpl?: StatusFetch;
    wait?: (milliseconds: number) => Promise<void>;
  }> = {},
): Promise<ReconciledOperatorActionStatus | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)));

  for (let attempt = 0; attempt < STATUS_RECONCILIATION_DELAYS_MS.length; attempt += 1) {
    if (options.signal?.aborted) return null;
    const delay = STATUS_RECONCILIATION_DELAYS_MS[attempt];
    if (delay > 0) await wait(delay);
    if (options.signal?.aborted) return null;
    try {
      const response = await fetchImpl(
        `/api/operator-actions/${encodeURIComponent(proposalId)}/approve`,
        {
          method: "PUT",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: "{}",
          credentials: "same-origin",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          signal: options.signal,
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 202 && isRecord(payload) && payload.status === "pending") continue;
      if (response.status >= 500) continue;
      if (response.status === 409 && isRecord(payload)
          && payload.code === "authoritative_receipt_unavailable_reconcile_status") continue;
      return Object.freeze({
        payload,
        status: authoritativeStatus(payload, response.status),
      });
    } catch {
      if (options.signal?.aborted) return null;
    }
  }
  return null;
}

function safeReceiptString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.replace(INVISIBLE_OR_DIRECTIONAL, (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    : null;
}

function visibleSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    INVISIBLE_OR_DIRECTIONAL,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Keep only a human-readable projection of the already-sanitized route
 * receipt. The raw response object is never retained in component state. */
function authoritativeSummary(
  capability: string,
  payload: unknown,
  status: OperatorActionApprovalStatus
): string {
  const response = isRecord(payload) ? payload : null;
  const result = response && isRecord(response.result) ? response.result : null;
  if (status === "indeterminate") {
    return "The server could not prove the provider outcome. This proposal cannot be retried.";
  }
  if (status === "rejected") {
    const code = safeReceiptString(result?.code ?? response?.code, 96);
    return code ? `No external effect was confirmed (${code}).` : "No external effect was confirmed.";
  }
  if (!result) return "The server recorded a successful authoritative receipt.";
  switch (capability) {
    case "send_email": {
      const to = safeReceiptString(result.to, 254);
      return result.accepted === true && to
        ? `Email accepted by the provider for ${to}; delivery is not yet verified.`
        : "The email was accepted by the provider; delivery is not yet verified.";
    }
    case "send_sms": {
      const to = safeReceiptString(result.to, 16);
      const segments = Number.isSafeInteger(result.segments) ? Number(result.segments) : null;
      return result.accepted === true && to && segments
        ? `SMS accepted by the provider for ${to} (${segments} segment${segments === 1 ? "" : "s"}); delivery is not yet verified.`
        : "The SMS was accepted by the provider; delivery is not yet verified.";
    }
    case "place_call": {
      const callId = safeReceiptString(result.call_id, 36);
      if (status === "delivered") {
        return callId
          ? `Verified provider status recorded terminal delivery for call ${callId}.`
          : "Verified provider status recorded terminal call delivery.";
      }
      return callId ? `Provider accepted call ${callId}.` : "The call was accepted by the provider.";
    }
    case "schedule_call": {
      const callId = safeReceiptString(result.id, 36);
      const runAt = safeReceiptString(result.run_at, 64);
      return callId && runAt ? `Call ${callId} is scheduled for ${runAt}.` : "The scheduled call was durably created.";
    }
    case "provision_phone_number": {
      const number = safeReceiptString(result.phone_number, 16);
      return number ? `Phone number ${number} was provisioned.` : "Phone number provisioning completed.";
    }
    case "run_campaign": {
      const campaignId = safeReceiptString(result.campaign_id, 36);
      const targets = Number.isSafeInteger(result.targets) ? Number(result.targets) : null;
      return campaignId && targets
        ? `Campaign ${campaignId} was materialized for ${targets} exact target${targets === 1 ? "" : "s"}.`
        : "The campaign was durably materialized.";
    }
    default:
      return "The server recorded a successful authoritative receipt.";
  }
}

const STATUS_COPY: Record<OperatorActionApprovalStatus, string> = {
  pending: "Nothing runs until you confirm this exact proposal.",
  approving: "Approval submitted. Waiting for the authoritative server receipt…",
  accepted: "The provider accepted the action; final delivery is not yet verified.",
  delivered: "A verified provider callback recorded terminal delivery.",
  succeeded: "Confirmed; see the authoritative result below.",
  rejected: "No external effect was confirmed.",
  indeterminate: "The final provider outcome could not be proven. Do not retry from this card.",
};

export default function OperatorActionApprovalCard({
  item,
  onStatusChange,
}: {
  item: OperatorActionConfirmationItem;
  onStatusChange: (proposalId: string, status: OperatorActionApprovalStatus) => void;
}) {
  const inFlight = useRef(false);
  const reconciliationController = useRef<AbortController | null>(null);
  const expiryMs = Date.parse(item.expiresAt);
  const [expired, setExpired] = useState(() => expiryMs <= Date.now());
  const [receiptSummary, setReceiptSummary] = useState<string | null>(null);
  const [campaignDisplay, setCampaignDisplay] = useState<
    | { state: "loading"; proposalId: string }
    | { state: "ready"; proposalId: string; targets: readonly string[] }
    | { state: "unavailable"; proposalId: string }
  >({ state: "loading", proposalId: item.proposalId });

  useEffect(() => {
    if (item.capability !== "run_campaign") return;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const response = await fetch(
          `/api/operator-actions/${encodeURIComponent(item.proposalId)}/display`,
          {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: "{}",
            credentials: "same-origin",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            signal: controller.signal,
          }
        );
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok || !isRecord(payload)
            || payload.proposal_id !== item.proposalId
            || payload.arguments_sha256 !== item.argumentsSha256
            || payload.target_count !== item.estimatedUnits
            || !Array.isArray(payload.targets)
            || payload.targets.length !== item.estimatedUnits
            || payload.targets.some((target) => typeof target !== "string" || !E164.test(target))
            || new Set(payload.targets).size !== payload.targets.length) {
          throw new Error("campaign display integrity check failed");
        }
        const sortedTargets = [...payload.targets].sort();
        if (payload.targets.some((target, index) => target !== sortedTargets[index])) {
          throw new Error("campaign targets are not canonical");
        }
        if (active) {
          setCampaignDisplay({
            state: "ready",
            proposalId: item.proposalId,
            targets: Object.freeze([...payload.targets] as string[]),
          });
        }
      } catch {
        if (active && !controller.signal.aborted) {
          setCampaignDisplay({ state: "unavailable", proposalId: item.proposalId });
        }
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [item.argumentsSha256, item.capability, item.estimatedUnits, item.proposalId]);

  useEffect(() => {
    const remaining = expiryMs - Date.now();
    if (remaining <= 0) return;
    let timeout: number;
    const checkExpiry = () => {
      const nextRemaining = expiryMs - Date.now();
      if (nextRemaining <= 0) {
        setExpired(true);
        return;
      }
      timeout = window.setTimeout(checkExpiry, Math.min(nextRemaining, 2_147_483_647));
    };
    timeout = window.setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timeout);
  }, [expiryMs]);

  useEffect(() => () => {
    reconciliationController.current?.abort();
  }, []);

  async function approve() {
    if (inFlight.current || item.status !== "pending" || expired) return;
    // The ref closes the double-click window synchronously; the controlled
    // status then makes that disabled state durable across re-renders.
    inFlight.current = true;
    onStatusChange(item.proposalId, "approving");
    reconciliationController.current?.abort();
    const controller = new AbortController();
    reconciliationController.current = controller;
    const publishReceipt = (payload: unknown, status: OperatorActionApprovalStatus) => {
      if (controller.signal.aborted) return;
      setReceiptSummary(authoritativeSummary(item.capability, payload, status));
      onStatusChange(item.proposalId, status);
    };
    const reconcile = async () => {
      const recovered = await reconcileOperatorActionStatus(item.proposalId, {
        signal: controller.signal,
      });
      if (recovered) {
        publishReceipt(recovered.payload, recovered.status);
        return;
      }
      publishReceipt(
        { status: "indeterminate" },
        "indeterminate",
      );
    };
    try {
      const response = await fetch(`/api/operator-actions/${encodeURIComponent(item.proposalId)}/approve`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: "{}",
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 409 || response.status >= 500) {
        await reconcile();
        return;
      }
      const status = authoritativeStatus(payload, response.status);
      publishReceipt(payload, status);
    } catch {
      // The POST itself is never repeated. Reconcile only against the durable
      // execution ledger; unresolved ambiguity remains terminal/fail-closed.
      if (!controller.signal.aborted) await reconcile();
    }
  }

  const terminal = TERMINAL_STATUSES.has(item.status);
  const currentCampaignDisplay = campaignDisplay.proposalId === item.proposalId
    ? campaignDisplay
    : { state: "loading" as const, proposalId: item.proposalId };
  const campaignDisplayReady = item.capability !== "run_campaign" || currentCampaignDisplay.state === "ready";
  const disabled = item.status !== "pending" || expired || !campaignDisplayReady;
  const argumentsJson = visibleSafeJson(item.arguments);

  return (
    <article
      aria-label={`${capabilityLabel(item.capability)} confirmation`}
      className={`my-2 overflow-hidden rounded-2xl border bg-white shadow-[0_12px_36px_rgba(0,0,0,0.06)] ${
        item.status === "indeterminate"
          ? "border-amber-300"
          : item.status === "rejected"
            ? "border-red-200"
            : item.status === "succeeded" || item.status === "delivered"
              ? "border-emerald-200"
              : "border-neutral-200"
      }`}
    >
      <div className="flex items-start gap-3 border-b border-neutral-100 px-4 py-3.5">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-950 text-white">
          {item.status === "succeeded" || item.status === "delivered" ? (
            <Check size={16} aria-hidden />
          ) : item.status === "rejected" ? (
            <X size={16} aria-hidden />
          ) : item.status === "indeterminate" ? (
            <AlertTriangle size={16} aria-hidden />
          ) : (
            <ShieldCheck size={16} aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-neutral-400">
            External action approval
          </p>
          <h3 className="mt-0.5 text-[15px] font-semibold text-neutral-950">
            {capabilityLabel(item.capability)}
          </h3>
          <p
            aria-live="polite"
            className={`mt-1 text-[12px] leading-5 ${
              item.status === "indeterminate" ? "text-amber-800" : item.status === "rejected" ? "text-red-700" : "text-neutral-500"
            }`}
          >
            {expired && item.status === "pending"
              ? "This proposal has expired. Ask for a new proposal before running the action."
              : STATUS_COPY[item.status]}
          </p>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3.5">
        <div>
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-neutral-400">
            Exact action arguments
          </p>
          <pre dir="ltr" className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-neutral-200 bg-neutral-50 p-3 font-mono text-[11px] leading-[1.55] text-neutral-800 [unicode-bidi:isolate]">
            {argumentsJson}
          </pre>
          <div className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-neutral-400">
              Proposal fingerprint
            </p>
            <code
              dir="ltr"
              title="SHA-256 commitment to the capability and exact action arguments"
              className="mt-1 block break-all font-mono text-[10.5px] leading-4 text-neutral-700 [unicode-bidi:isolate]"
            >
              sha256:{item.argumentsSha256}
            </code>
          </div>
        </div>

        {item.capability === "run_campaign" && (
          <div>
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-neutral-400">
              Exact private call targets
            </p>
            {currentCampaignDisplay.state === "ready" ? (
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-neutral-200 bg-neutral-50 p-3 font-mono text-[11px] leading-[1.55] text-neutral-800">
                {JSON.stringify(currentCampaignDisplay.targets, null, 2)}
              </pre>
            ) : (
              <p className={`rounded-xl border p-3 text-[12px] leading-5 ${
                currentCampaignDisplay.state === "unavailable"
                  ? "border-red-200 bg-red-50 text-red-700"
                  : "border-neutral-200 bg-neutral-50 text-neutral-500"
              }`}>
                {currentCampaignDisplay.state === "unavailable"
                  ? "The exact target list could not be verified. Confirmation is disabled; create a fresh proposal."
                  : "Loading the private target list for verification…"}
              </p>
            )}
          </div>
        )}

        <dl className="grid grid-cols-1 gap-2 text-[12px] sm:grid-cols-3">
          <div className="rounded-xl bg-neutral-50 px-3 py-2.5">
            <dt className="text-neutral-400">Estimated units</dt>
            <dd className="mt-0.5 font-semibold tabular-nums text-neutral-900">{item.estimatedUnits}</dd>
          </div>
          <div className="rounded-xl bg-neutral-50 px-3 py-2.5">
            <dt className="text-neutral-400">Worst-case cost</dt>
            <dd className="mt-0.5 font-semibold tabular-nums text-neutral-900">
              {exactUsd(item.worstCaseMicroUsd)}
            </dd>
          </div>
          <div className="rounded-xl bg-neutral-50 px-3 py-2.5">
            <dt className="text-neutral-400">Expires at</dt>
            <dd className="mt-0.5 break-all font-mono text-[10.5px] font-semibold text-neutral-900">
              {item.expiresAt}
            </dd>
          </div>
        </dl>

        {receiptSummary && terminal && (
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-[12px] leading-5 text-neutral-700">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-neutral-400">
              Authoritative result
            </p>
            <p className="mt-1">{receiptSummary}</p>
          </div>
        )}

        <button
          type="button"
          onClick={() => void approve()}
          disabled={disabled}
          aria-busy={item.status === "approving"}
          className={`inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl px-4 text-[13px] font-semibold transition ${
            item.status === "succeeded"
              ? "bg-emerald-600 text-white"
              : item.status === "rejected"
                ? "bg-red-50 text-red-700"
                : item.status === "indeterminate"
                  ? "bg-amber-50 text-amber-900"
                  : "bg-neutral-950 text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-55"
          }`}
        >
          {item.status === "approving" && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {item.status === "pending" && (expired ? "Expired" : "Confirm and run")}
          {item.status === "approving" && "Confirming…"}
          {item.status === "accepted" && "Provider accepted"}
          {item.status === "delivered" && "Delivered"}
          {item.status === "succeeded" && "Confirmed"}
          {item.status === "rejected" && "Rejected"}
          {item.status === "indeterminate" && "Outcome unknown"}
        </button>

        {!terminal && item.status === "pending" && !expired && (
          <p className="text-center text-[10.5px] leading-4 text-neutral-400">
            Confirmation applies only to the proposal shown above.
          </p>
        )}
      </div>
    </article>
  );
}
