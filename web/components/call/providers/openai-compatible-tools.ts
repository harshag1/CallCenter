import {
  BrowserCapabilityGateway,
  type BrowserCapabilityGatewayCall,
} from "./capability-gateway";
import {
  BROWSER_REALTIME_LIMITS,
  isPlainRecord,
  utf8Bytes,
} from "./types";

const MAX_PENDING_CALLS = 10_000;
const MAX_CALLS_PER_RESPONSE = 64;
const MAX_QUEUED_TOOL_EVENTS = 128;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const TERMINAL_RESPONSE_STATUSES = new Set(["completed", "cancelled", "failed", "incomplete"]);

type PendingCall = Readonly<{
  callId: string;
  responseId: string;
  itemId?: string;
  name: string;
  arguments: unknown;
  fingerprint: string;
}>;

type ToolLoopOptions = Readonly<{
  gateway: BrowserCapabilityGateway;
  sendJson: (value: Readonly<Record<string, unknown>>, label: string) => void;
  onError: (error: Error) => void;
  closeProtocol: (code: number, reason: string) => void;
}>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function providerId(value: unknown, label: string): string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

function optionalProviderId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : providerId(value, label);
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string" || utf8Bytes(value) > BROWSER_REALTIME_LIMITS.providerEventBytes) {
    throw new Error("provider function arguments are missing or oversized");
  }
  try { return JSON.parse(value) as unknown; } catch {
    throw new Error("provider function arguments are malformed JSON");
  }
}

function pendingFromEvent(event: Record<string, unknown>, fallbackResponseId?: string): PendingCall | null {
  const item = isPlainRecord(event.item) ? event.item : {};
  if (item.type !== "function_call" && event.type !== "response.function_call_arguments.done") return null;
  const callId = providerId(event.call_id ?? item.call_id, "provider native call id");
  const responseId = providerId(
    event.response_id ?? (isPlainRecord(event.response) ? event.response.id : undefined) ?? fallbackResponseId,
    "provider native response id",
  );
  const itemId = optionalProviderId(event.item_id ?? item.id, "provider native item id");
  const name = typeof (event.name ?? item.name) === "string" ? String(event.name ?? item.name) : "";
  const rawArguments = event.arguments ?? item.arguments;
  const args = parseArguments(rawArguments);
  const fingerprint = canonicalJson({ callId, responseId, itemId: itemId ?? null, name, arguments: args });
  return { callId, responseId, ...(itemId ? { itemId } : {}), name, arguments: args, fingerprint };
}

/**
 * Provider-native function calls become executable only after response.done
 * proves the response completed. Complete batches are sent back before exactly
 * one response.create; every protocol ambiguity closes instead of guessing.
 */
export class OpenAICompatibleBrowserToolLoop {
  private readonly pending = new Map<string, PendingCall>();
  private readonly itemOwners = new Map<string, string>();
  private readonly sealedResponses = new Map<string, string>();
  private eventTail: Promise<void> = Promise.resolve();
  private queuedEvents = 0;
  private stopped = false;

  constructor(private readonly options: ToolLoopOptions) {}

  observe(event: Record<string, unknown>): void {
    if (this.stopped) return;
    const wireType = typeof event.type === "string" ? event.type : "";
    if (wireType !== "response.function_call_arguments.done"
      && wireType !== "response.output_item.done"
      && wireType !== "response.done") return;
    if (this.queuedEvents >= MAX_QUEUED_TOOL_EVENTS) {
      this.fail(new Error(`provider exceeded ${MAX_QUEUED_TOOL_EVENTS} queued function events`));
      return;
    }
    this.queuedEvents += 1;
    this.eventTail = this.eventTail
      .then(() => this.process(event))
      .catch((error) => this.fail(error))
      .finally(() => { this.queuedEvents -= 1; });
  }

  close(): void {
    this.stopped = true;
    this.pending.clear();
    this.itemOwners.clear();
  }

  private async process(event: Record<string, unknown>): Promise<void> {
    if (this.stopped) return;
    if (event.type === "response.function_call_arguments.done" || event.type === "response.output_item.done") {
      const pending = pendingFromEvent(event);
      if (pending) this.remember(pending);
      return;
    }

    const response = isPlainRecord(event.response) ? event.response : null;
    if (!response) throw new Error("response.done omitted its response object");
    const responseId = providerId(response.id ?? event.response_id, "provider native response id");
    if (event.response_id !== undefined && event.response_id !== responseId) {
      throw new Error("response.done contains contradictory response identities");
    }
    const output = Array.isArray(response.output) ? response.output : [];
    const terminalCallIds: string[] = [];
    for (const raw of output) {
      if (!isPlainRecord(raw) || raw.type !== "function_call") continue;
      const pending = pendingFromEvent({ type: "response.output_item.done", item: raw }, responseId);
      if (pending) {
        if (terminalCallIds.includes(pending.callId)) {
          throw new Error(`response.done duplicated provider native call id ${pending.callId}`);
        }
        terminalCallIds.push(pending.callId);
        this.remember(pending);
      }
    }
    const pendingForResponse = [...this.pending.values()].filter((call) => call.responseId === responseId);
    const terminalSet = new Set(terminalCallIds);
    const omitted = pendingForResponse.filter((call) => !terminalSet.has(call.callId));
    if (omitted.length > 0) {
      throw new Error(`response.done omitted pending function calls: ${omitted.map((call) => call.callId).join(", ")}`);
    }
    const calls = terminalCallIds.map((callId) => this.pending.get(callId)!);
    if (calls.length > MAX_CALLS_PER_RESPONSE) {
      throw new Error(`provider response exceeded ${MAX_CALLS_PER_RESPONSE} function calls`);
    }
    const status = typeof response.status === "string" ? response.status : "";
    if (!TERMINAL_RESPONSE_STATUSES.has(status)) {
      throw new Error(`response.done contained unknown terminal status ${JSON.stringify(status)}`);
    }
    const terminalEventId = optionalProviderId(event.event_id, "provider terminal event id");
    const terminalFingerprint = await sha256(canonicalJson({
      responseId,
      status,
      calls: calls.map((call) => call.fingerprint),
    }));
    const sealed = this.sealedResponses.get(responseId);
    if (sealed !== undefined) {
      if (sealed !== terminalFingerprint) throw new Error(`provider response ${responseId} was replayed with different contents`);
      // Parsing the replay above reconstructs its terminal calls. Remove them
      // before returning so exact provider replays cannot leak pending state.
      for (const call of calls) this.pending.delete(call.callId);
      return;
    }
    if (calls.length === 0) return;
    if (this.sealedResponses.size >= MAX_PENDING_CALLS) {
      throw new Error(`provider exceeded ${MAX_PENDING_CALLS} response identities`);
    }
    this.sealedResponses.set(responseId, terminalFingerprint);
    if (status !== "completed") {
      for (const call of calls) this.pending.delete(call.callId);
      return;
    }

    const gatewayCalls: BrowserCapabilityGatewayCall[] = calls.map((call) => ({
      functionName: call.name,
      nativeCallId: call.callId,
      nativeResponseId: responseId,
      ...(call.itemId ? { nativeItemId: call.itemId } : {}),
      ...(terminalEventId ? { terminalEventId } : {}),
      terminalWireType: "response.done",
      arguments: call.arguments,
    }));
    const results = await this.options.gateway.executeBatch(gatewayCalls);
    if (this.stopped) return;
    if (results.length !== calls.length) throw new Error("tool gateway returned a partial provider batch");

    const outputFrames = results.map((result, index) => {
      if (result.nativeCallId !== calls[index]?.callId) {
        throw new Error("tool gateway result order or native identity changed");
      }
      // MCP's isError bit is authoritative. Preserve successful gateway
      // envelopes verbatim, while making failures impossible to mistake for a
      // successful JSON result on OpenAI-compatible transports.
      const providerOutput = result.isError ? { error: result.output } : result.output;
      let serialized: string;
      try { serialized = JSON.stringify(providerOutput); } catch {
        throw new Error("tool gateway result was not JSON serializable");
      }
      if (serialized === undefined || utf8Bytes(serialized) > BROWSER_REALTIME_LIMITS.outboundFrameBytes) {
        throw new Error("tool gateway result exceeded the provider output limit");
      }
      return {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: result.nativeCallId,
          output: serialized,
        },
      };
    });
    // Pre-serialize every frame before sending any one of them. A synchronous
    // send failure after the first frame is irrecoverable and closes below.
    for (const frame of outputFrames) {
      this.options.sendJson(frame, "provider function output");
    }
    this.options.sendJson({ type: "response.create" }, "provider response continuation");
    for (const call of calls) this.pending.delete(call.callId);
  }

  private remember(call: PendingCall): void {
    if (call.itemId) {
      const priorOwner = this.itemOwners.get(call.itemId);
      if (priorOwner !== undefined && priorOwner !== call.callId) {
        throw new Error(
          `provider native item id ${call.itemId} was reused across calls ${priorOwner} and ${call.callId}`,
        );
      }
      if (priorOwner === undefined && this.itemOwners.size >= MAX_PENDING_CALLS) {
        throw new Error(`provider exceeded ${MAX_PENDING_CALLS} native item identities`);
      }
      this.itemOwners.set(call.itemId, call.callId);
    }
    const prior = this.pending.get(call.callId);
    if (prior && prior.fingerprint !== call.fingerprint) {
      throw new Error(`provider native call id ${call.callId} was reused with different contents`);
    }
    if (!prior && this.pending.size >= MAX_PENDING_CALLS) {
      throw new Error(`provider exceeded ${MAX_PENDING_CALLS} pending function call identities`);
    }
    this.pending.set(call.callId, call);
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    // A terminal protocol failure permanently disables this loop. Retaining
    // provider-authored call arguments after that point serves no replay or
    // recovery purpose and can otherwise pin a full bounded ledger in memory.
    this.pending.clear();
    this.itemOwners.clear();
    const normalized = error instanceof Error ? error : new Error("provider function protocol failed");
    this.options.onError(normalized);
    this.options.gateway.close();
    this.options.closeProtocol(1002, "provider function protocol failed");
  }
}
