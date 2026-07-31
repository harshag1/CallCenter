import "server-only";

import {
  createServerInferenceAuthority,
  createServerInferenceRuntime,
  type ServerInferenceResearch,
} from "../server-inference";

const encoder = new TextEncoder();

/**
 * These are host ceilings, not environment knobs. A self-hosted deployment can
 * make the source limits smaller, but browser/model input cannot make them
 * larger at runtime.
 */
export type OperatorTurnInferenceBudget = Readonly<{
  maxProviderRequests: number;
  maxBuilderRequests: number;
  maxResearchRequests: number;
  maxToolCalls: number;
  maxReservedOutputTokens: number;
  maxBuilderOutputTokensPerRequest: number;
  maxResearchOutputTokensPerRequest: number;
  maxInputBytesPerRequest: number;
  maxTotalInputBytes: number;
  requestTimeoutMs: number;
  operationTimeoutMs: number;
}>;

export const OPERATOR_TURN_INFERENCE_LIMITS: OperatorTurnInferenceBudget =
Object.freeze({
  maxProviderRequests: 8,
  maxBuilderRequests: 6,
  maxResearchRequests: 2,
  maxToolCalls: 12,
  maxReservedOutputTokens: 12_000,
  maxBuilderOutputTokensPerRequest: 1_600,
  maxResearchOutputTokensPerRequest: 1_200,
  maxInputBytesPerRequest: 512 * 1024,
  maxTotalInputBytes: 2 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  operationTimeoutMs: 90_000,
});

export type OperatorTurnInferenceSnapshot = Readonly<{
  providerRequestsReserved: number;
  providerRequestsRemaining: number;
  builderRequestsReserved: number;
  builderRequestsRemaining: number;
  researchRequestsReserved: number;
  researchRequestsRemaining: number;
  toolCallsReserved: number;
  toolCallsRemaining: number;
  outputTokensReserved: number;
  outputTokensRemaining: number;
  inputBytesReserved: number;
  inputBytesRemaining: number;
}>;

/** Opaque process-local authority. Mutable counters live only in this module. */
export type OperatorTurnInferenceAuthority = Readonly<{
  budgetSnapshot(): OperatorTurnInferenceSnapshot;
}>;

export type OperatorBuilderRequestLease = Readonly<{
  signal: AbortSignal;
  dispatch(): Promise<Response>;
  guard<T>(operation: PromiseLike<T>): Promise<T>;
  close(): void;
}>;

type AuthorityState = {
  budget: OperatorTurnInferenceBudget;
  deadlineAtMs: number;
  providerRequestsReserved: number;
  builderRequestsReserved: number;
  researchRequestsReserved: number;
  toolCallsReserved: number;
  outputTokensReserved: number;
  inputBytesReserved: number;
  parentSignal?: AbortSignal;
  researchAuthority: ReturnType<typeof createServerInferenceAuthority>;
};

const authorityStates =
  new WeakMap<OperatorTurnInferenceAuthority, AuthorityState>();

function exactPositiveInteger(
  value: number,
  field: keyof OperatorTurnInferenceBudget,
): void {
  if (
    !Number.isInteger(value)
    || value < 1
    || value > OPERATOR_TURN_INFERENCE_LIMITS[field]
  ) {
    throw new Error(
      `operator turn ${field} must be an integer from 1 to `
        + OPERATOR_TURN_INFERENCE_LIMITS[field],
    );
  }
}

function resolveBudget(
  overrides: Partial<OperatorTurnInferenceBudget>,
): OperatorTurnInferenceBudget {
  const budget = Object.freeze({
    ...OPERATOR_TURN_INFERENCE_LIMITS,
    ...overrides,
  });
  for (const field of Object.keys(
    OPERATOR_TURN_INFERENCE_LIMITS,
  ) as (keyof OperatorTurnInferenceBudget)[]) {
    exactPositiveInteger(budget[field], field);
  }
  if (budget.maxBuilderRequests > budget.maxProviderRequests) {
    throw new Error(
      "operator turn maxBuilderRequests cannot exceed maxProviderRequests",
    );
  }
  if (budget.maxResearchRequests > budget.maxProviderRequests) {
    throw new Error(
      "operator turn maxResearchRequests cannot exceed maxProviderRequests",
    );
  }
  if (
    budget.maxBuilderOutputTokensPerRequest
      > budget.maxReservedOutputTokens
    || budget.maxResearchOutputTokensPerRequest
      > budget.maxReservedOutputTokens
  ) {
    throw new Error(
      "operator turn per-request output limit cannot exceed the turn limit",
    );
  }
  if (budget.maxInputBytesPerRequest > budget.maxTotalInputBytes) {
    throw new Error(
      "operator turn per-request input limit cannot exceed the turn limit",
    );
  }
  return budget;
}

function stateFor(
  authority: OperatorTurnInferenceAuthority,
): AuthorityState {
  const state = authorityStates.get(authority);
  if (!state) throw new Error("operator turn inference authority is invalid");
  return state;
}

function snapshot(state: AuthorityState): OperatorTurnInferenceSnapshot {
  return Object.freeze({
    providerRequestsReserved: state.providerRequestsReserved,
    providerRequestsRemaining:
      state.budget.maxProviderRequests - state.providerRequestsReserved,
    builderRequestsReserved: state.builderRequestsReserved,
    builderRequestsRemaining:
      state.budget.maxBuilderRequests - state.builderRequestsReserved,
    researchRequestsReserved: state.researchRequestsReserved,
    researchRequestsRemaining:
      state.budget.maxResearchRequests - state.researchRequestsReserved,
    toolCallsReserved: state.toolCallsReserved,
    toolCallsRemaining: state.budget.maxToolCalls - state.toolCallsReserved,
    outputTokensReserved: state.outputTokensReserved,
    outputTokensRemaining:
      state.budget.maxReservedOutputTokens - state.outputTokensReserved,
    inputBytesReserved: state.inputBytesReserved,
    inputBytesRemaining:
      state.budget.maxTotalInputBytes - state.inputBytesReserved,
  });
}

export function createOperatorTurnInferenceAuthority(
  overrides: Partial<OperatorTurnInferenceBudget> = {},
  parentSignal?: AbortSignal,
): OperatorTurnInferenceAuthority {
  const budget = resolveBudget(overrides);
  // Create the nested authority first. Its absolute deadline is therefore
  // never later than the enclosing operator-turn deadline.
  const researchAuthority = createServerInferenceAuthority({
    purpose: "operator_research",
    budget: {
      maxProviderRequests: budget.maxResearchRequests,
      maxReservedOutputTokens: budget.maxReservedOutputTokens,
      maxInputBytesPerRequest: budget.maxInputBytesPerRequest,
      requestTimeoutMs: budget.requestTimeoutMs,
      operationTimeoutMs: budget.operationTimeoutMs,
    },
    ...(parentSignal ? { signal: parentSignal } : {}),
  });
  const state: AuthorityState = {
    budget,
    deadlineAtMs: Date.now() + budget.operationTimeoutMs,
    providerRequestsReserved: 0,
    builderRequestsReserved: 0,
    researchRequestsReserved: 0,
    toolCallsReserved: 0,
    outputTokensReserved: 0,
    inputBytesReserved: 0,
    parentSignal,
    researchAuthority,
  };
  const authority: OperatorTurnInferenceAuthority = Object.freeze({
    budgetSnapshot: () => snapshot(state),
  });
  authorityStates.set(authority, state);
  return authority;
}

function serializedBytes(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("operator turn inference input is not serializable");
  }
  return encoder.encode(serialized).byteLength;
}

function reserveProviderRequest(
  state: AuthorityState,
  kind: "builder" | "research",
  maxOutputTokens: number,
  inputBytes: number,
): void {
  if (state.parentSignal?.aborted) {
    throw new Error("operator turn inference cancelled");
  }
  if (Date.now() >= state.deadlineAtMs) {
    throw new Error("operator turn inference deadline exhausted");
  }
  const perRequestLimit = kind === "builder"
    ? state.budget.maxBuilderOutputTokensPerRequest
    : state.budget.maxResearchOutputTokensPerRequest;
  if (
    !Number.isInteger(maxOutputTokens)
    || maxOutputTokens < 1
    || maxOutputTokens > perRequestLimit
  ) {
    throw new Error(
      `operator turn ${kind} output-token reservation must be an integer `
        + `from 1 to ${perRequestLimit}`,
    );
  }
  if (
    !Number.isInteger(inputBytes)
    || inputBytes < 0
    || inputBytes > state.budget.maxInputBytesPerRequest
  ) {
    throw new Error(
      `operator turn inference input exceeded its `
        + `${state.budget.maxInputBytesPerRequest}-byte budget`,
    );
  }
  if (state.providerRequestsReserved >= state.budget.maxProviderRequests) {
    throw new Error("operator turn provider-request budget exhausted");
  }
  if (
    kind === "builder"
    && state.builderRequestsReserved >= state.budget.maxBuilderRequests
  ) {
    throw new Error("operator turn builder-request budget exhausted");
  }
  if (
    kind === "research"
    && state.researchRequestsReserved >= state.budget.maxResearchRequests
  ) {
    throw new Error("operator turn research-request budget exhausted");
  }
  if (
    state.outputTokensReserved + maxOutputTokens
      > state.budget.maxReservedOutputTokens
  ) {
    throw new Error("operator turn output-token budget exhausted");
  }
  if (state.inputBytesReserved + inputBytes > state.budget.maxTotalInputBytes) {
    throw new Error("operator turn input-byte budget exhausted");
  }

  // JavaScript execution is single-threaded between awaits. Incrementing every
  // counter before returning makes concurrent callers race on one atomic
  // reservation point and leaves failed provider attempts consumed.
  state.providerRequestsReserved += 1;
  state.outputTokensReserved += maxOutputTokens;
  state.inputBytesReserved += inputBytes;
  if (kind === "builder") state.builderRequestsReserved += 1;
  else state.researchRequestsReserved += 1;
}

export function assertOperatorTurnInferenceActive(
  authority: OperatorTurnInferenceAuthority,
): void {
  const state = stateFor(authority);
  if (state.parentSignal?.aborted) {
    throw new Error("operator turn inference cancelled");
  }
  if (Date.now() >= state.deadlineAtMs) {
    throw new Error("operator turn inference deadline exhausted");
  }
}

export function reserveOperatorToolCalls(
  authority: OperatorTurnInferenceAuthority,
  count: number,
): OperatorTurnInferenceSnapshot {
  const state = stateFor(authority);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("operator turn tool-call reservation must be a positive integer");
  }
  assertOperatorTurnInferenceActive(authority);
  if (state.toolCallsReserved + count > state.budget.maxToolCalls) {
    throw new Error("operator turn tool-call budget exhausted");
  }
  state.toolCallsReserved += count;
  return snapshot(state);
}

export async function runOperatorTurnResearch(
  authority: OperatorTurnInferenceAuthority,
  system: string,
  user: string,
  options: Readonly<{
    allowedDomains?: readonly string[];
    maxOutputTokens: number;
  }>,
): Promise<ServerInferenceResearch> {
  const state = stateFor(authority);
  const request = {
    system,
    user,
    allowedDomains: options.allowedDomains,
    maxOutputTokens: options.maxOutputTokens,
  };
  reserveProviderRequest(
    state,
    "research",
    options.maxOutputTokens,
    serializedBytes(request),
  );
  // Every invocation constructs a lightweight provider view, but all views
  // share the one nested authority created at turn admission. There is no
  // per-tool budget reset and the server-inference layer performs no retry.
  const inference = createServerInferenceRuntime({
    purpose: "operator_research",
    workload: "research",
    authority: state.researchAuthority,
  });
  return inference.research(system, user, options);
}

export function openOperatorBuilderRequest(
  authority: OperatorTurnInferenceAuthority,
  input: Readonly<{
    maxOutputTokens: number;
    endpoint: string;
    body: string;
    headers: Readonly<Record<string, string>>;
    fetch?: typeof fetch;
  }>,
): OperatorBuilderRequestLease {
  const state = stateFor(authority);
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new Error("operator turn builder fetch is unavailable");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new Error("operator turn builder endpoint is invalid");
  }
  if (
    endpoint.protocol !== "https:"
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
  ) {
    throw new Error("operator turn builder endpoint must be a credential-free HTTPS URL");
  }
  if (typeof input.body !== "string") {
    throw new Error("operator turn builder body must be serialized JSON");
  }
  const requestBodyBytes = encoder.encode(input.body).byteLength;
  if (requestBodyBytes > state.budget.maxInputBytesPerRequest) {
    throw new Error(
      `operator turn inference input exceeded its `
        + `${state.budget.maxInputBytesPerRequest}-byte budget`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(input.body);
  } catch {
    throw new Error("operator turn builder body must be serialized JSON");
  }
  if (JSON.stringify(body) !== input.body) {
    throw new Error("operator turn builder body must be canonical JSON");
  }
  if (
    !body
    || typeof body !== "object"
    || (body as { stream?: unknown }).stream !== true
    || (body as { max_tokens?: unknown }).max_tokens !== input.maxOutputTokens
  ) {
    throw new Error(
      "operator turn builder body does not match its output-token reservation",
    );
  }
  const requestBody = input.body;
  const requestHeaders = Object.freeze({ ...input.headers });
  reserveProviderRequest(
    state,
    "builder",
    input.maxOutputTokens,
    requestBodyBytes,
  );

  const controller = new AbortController();
  const requestDeadlineAtMs = Math.min(
    state.deadlineAtMs,
    Date.now() + state.budget.requestTimeoutMs,
  );
  type Waiter = (error: Error) => void;
  const waiters = new Set<Waiter>();
  let open = true;
  let dispatched = false;
  let terminalError: Error | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const terminate = (error: Error): Error => {
    if (terminalError) return terminalError;
    terminalError = error;
    open = false;
    if (timer) clearTimeout(timer);
    state.parentSignal?.removeEventListener("abort", cancelFromParent);
    controller.abort(terminalError);
    for (const reject of [...waiters]) reject(terminalError);
    waiters.clear();
    return terminalError;
  };
  const exhaustDeadline = (): Error => terminate(new Error(
      requestDeadlineAtMs >= state.deadlineAtMs
        ? "operator turn inference deadline exhausted"
        : "operator turn builder request timed out",
    ));
  const cancelFromParent = (): void => {
    terminate(new Error("operator turn inference cancelled"));
  };

  timer = setTimeout(
    exhaustDeadline,
    Math.max(0, requestDeadlineAtMs - Date.now()),
  );
  state.parentSignal?.addEventListener("abort", cancelFromParent, { once: true });
  if (state.parentSignal?.aborted) cancelFromParent();

  const guard = <T>(operation: PromiseLike<T>): Promise<T> => {
    if (terminalError) {
      // Observe a caller-supplied late operation even when the deadline already
      // elapsed; this prevents an unhandled late rejection.
      void Promise.resolve(operation).catch(() => undefined);
      return Promise.reject(terminalError);
    }
    if (!open) {
      void Promise.resolve(operation).catch(() => undefined);
      return Promise.reject(
        new Error("operator turn builder transport is closed"),
      );
    }
    if (state.parentSignal?.aborted) {
      void Promise.resolve(operation).catch(() => undefined);
      return Promise.reject(terminate(
        new Error("operator turn inference cancelled"),
      ));
    }
    if (Date.now() >= requestDeadlineAtMs) {
      void Promise.resolve(operation).catch(() => undefined);
      return Promise.reject(exhaustDeadline());
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const rejectAtDeadline: Waiter = (error) => {
        if (settled) return;
        settled = true;
        waiters.delete(rejectAtDeadline);
        reject(error);
      };
      waiters.add(rejectAtDeadline);
      void Promise.resolve(operation).then(
        (value) => {
          if (settled) return;
          if (state.parentSignal?.aborted) {
            terminate(new Error("operator turn inference cancelled"));
            return;
          }
          if (Date.now() >= requestDeadlineAtMs) {
            exhaustDeadline();
            return;
          }
          settled = true;
          waiters.delete(rejectAtDeadline);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          waiters.delete(rejectAtDeadline);
          reject(error);
        },
      );
    });
  };

  const dispatch = (): Promise<Response> => {
    if (!open) {
      return Promise.reject(
        terminalError ?? new Error("operator turn builder transport is closed"),
      );
    }
    if (dispatched) {
      return Promise.reject(
        new Error("operator turn builder request exceeded one fetch dispatch"),
      );
    }
    dispatched = true;
    // The microtask rechecks the absolute deadline immediately before the
    // provider dispatch. A zero-delay timer cannot be used as a permission
    // race to start a request after the turn expired.
    const operation = Promise.resolve().then(() => {
      if (state.parentSignal?.aborted) {
        throw terminate(new Error("operator turn inference cancelled"));
      }
      if (!open || Date.now() >= requestDeadlineAtMs) {
        throw exhaustDeadline();
      }
      return fetchImplementation(endpoint.href, {
        method: "POST",
        headers: requestHeaders,
        body: requestBody,
        redirect: "error",
        signal: controller.signal,
      });
    });
    return guard(operation);
  };

  return Object.freeze({
    signal: controller.signal,
    dispatch,
    guard,
    close(): void {
      if (!open && terminalError) return;
      open = false;
      if (timer) clearTimeout(timer);
      state.parentSignal?.removeEventListener("abort", cancelFromParent);
      controller.abort(new Error("operator turn builder transport closed"));
      const error = new Error("operator turn builder transport is closed");
      for (const reject of [...waiters]) reject(error);
      waiters.clear();
    },
  });
}
