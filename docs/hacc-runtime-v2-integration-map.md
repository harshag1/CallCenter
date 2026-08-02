# HACC runtime v2 production integration map

Status: implementation map, not a claim that runtime v2 is live.

Scope: browser calls and the hardened standalone Twilio bridge.
Baseline repository snapshot inspected: `ddb1ac4e0396516e6943de07268d7a2d74232fff` on `open-source`; the shared branch advanced during this read-only audit, so call sites were rechecked through `82d56b0c320eb2bb425ca6e3eb3a635e72ee45b7`.

Line numbers below are navigation hints for this snapshot. Symbol names and invariants are the durable contract.

## Decision

The committed v2 modules must become the production composition, not a second runtime selected only by a benchmark:

- `conversation-program` is the semantic projection of the existing PostgreSQL conversation event log. It must not create another authoritative log or another independently mutable head.
- `runtime-control` produces the closed Turn Contract used by both the tool gateway and the speech-release gate.
- `governed-effect-runtime` becomes the only execution owner for write and opaque actions. Existing MCP and Flow receipts remain transport and compatibility projections; they must not become competing effect authorities.
- `audibility-v2` is the only source for agent speech promoted into durable conversation context. Provider transcripts and generated audio remain advisory evidence.
- `realtime/conformance-v2` is fed by the browser and bridge provider adapters, using provider-authored acknowledgements rather than outbound configuration requests.
- `evidence-v2` observes the production authority changes above. The benchmark consumes that evidence; it does not recreate the treatment.

The cutover must be pinned per call. No active call may switch between legacy and v2 authority, and rollback changes only the mode assigned to new calls.

## What is production today

### Browser path

```text
POST /api/voice/token
  -> buildVoiceSession()
  -> voiceSessionSpecForCall()
  -> activeConversationRouteAuthorityFor()
  -> preparePostgresLiveConversationRoute()
  -> bounded durable context packet + active capability catalog
  -> provider-specific browser transport
  -> BrowserCapabilityGateway
  -> POST /api/mcp
  -> callActiveCapability()
  -> Flow control or run_action
  -> refreshed catalog + durable packet in the tool result
```

Current call sites:

| Boundary | Current symbol | Current behavior | Missing v2 authority |
|---|---|---|---|
| Call allocation | `web/app/api/voice/token/route.ts:41` `POST` | Allocates a call, resolves funding, builds provider connection | Does not create or return a v2 runtime/session identity or EvidenceTap identity |
| Session composition | `web/lib/voice.ts:1022` `voiceSessionSpecForCall` | Pins the agent runtime, loads the active catalog, calls the durable route, injects packet instructions | Does not compile or retain a Production Turn Contract |
| Durable route | `web/lib/live-conversation-route.ts:114` `defineLiveConversationRoute` | Mirrors the Flow checkpoint, delivers pending worker results, compiles a context packet | Multiple loads permit a head change between the returned `planDigest`, worker delivery, and final packet; no closed response frontier is returned |
| PostgreSQL route | `web/lib/live-conversation-route-postgres.ts:39` `deliverPendingWorkerResults` | Claims and applies up to 16 worker messages before a new packet | Worker delivery is not projected through `conversation-program`; the result count is authority-free metadata |
| Browser gateway | `web/components/call/providers/capability-gateway.ts:373` `BrowserCapabilityGateway` | Verifies catalog monotonicity, serializes provider calls, carries provider provenance | Verifies no Turn Contract hash and provides no transport hook to install a refreshed contract before continuation |
| MCP ingress | `web/app/api/mcp/route.ts:556` `callActiveCapability` call | Executes a logical capability, then refreshes catalog and packet | Returns no contract/freshness assertion; packet refresh failure blocks the catalog but is not a contract failure |
| Logical binding | `web/lib/active-capability-catalog.ts:400` `bindActiveCapabilityInvocation` | Privately converts a logical action to `run_action` with the current Flow grant | Correctly keeps the grant out of model arguments; it must also bind the retained Turn Contract digest |
| Action dispatch | `web/lib/mcp.ts:992` `callActiveCapability`; `web/lib/mcp.ts:2217` `run_action` | Outer MCP replay admission, Flow grant verification, Flow receipt reservation, preflight, one dispatch marker, settlement/reconciliation | Does not use `GovernedEffectCoordinator`; effect authority is split between MCP, Flow, integration-specific acknowledgement logic, and reconciliation code |
| Browser speech gate | `web/components/call/providers/outbound-speech.ts:69` `finalizeQuarantinedSpeech` | Holds exact PCM until a narrow speech policy passes and schedules it in `AudioContext` | Scheduling is not audibility, terminal claims are not receipt-granted through the Turn Contract, and `audibility-v2` is not updated |
| Browser event persistence | `web/components/call/realtime.ts:302` `queueEvent`; `web/app/api/calls/[id]/events/route.ts:58` `sanitizeBrowserEvent` | Batches transcripts, provider state, guardrail evidence, and errors into `call_events` | **Current P0:** the client queues `outbound_speech_gate`, the route rejects that event type, and a single rejected item is prepended forever, potentially blocking every later transcript/evidence event. Generic client events are also not the append-only v2 authority and `agent_said` can mean provider transcript rather than acknowledged playback |
| Browser provider factory | `web/components/call/providers/index.ts:7` `createBrowserRealtimeTransport` | Hard-coded switch for OpenAI, xAI and Gemini | The committed provider plugin registry is not the production construction path, so adding a provider still requires core runtime edits |

The existing model-visible logical tool surface is worth preserving. The provider proposes `{tool_name, arguments}` through `capability_gateway`; the host privately adds the Flow grant. Runtime v2 must strengthen that boundary, not expose leases, epochs, or receipt IDs to the model.

### PSTN path

Production is intended to use the standalone `bridge/` service. `web/app/api/bridge/route.ts:10` keeps `web/lib/bridge.ts` disabled in production and should remain a development-only compatibility route.

```text
Twilio Media Stream
  -> bridge/server.js
  -> BridgeSession
  -> POST /api/telephony/session bootstrap
  -> provider adapter (OpenAI-compatible OpenAI/xAI)
  -> Twilio media + marks
  -> AuthorityClient -> POST /api/mcp
  -> EventJournal -> POST /api/telephony/events
  -> call_events
```

Current call sites:

| Boundary | Current symbol | Current behavior | Missing v2 authority |
|---|---|---|---|
| Bootstrap | `web/app/api/telephony/session/route.ts:380` `POST` | Atomically binds the Twilio stream and returns a scrubbed, replayable session configuration | Bootstrap schema carries catalog authority but no Turn Contract, logical runtime session ID, or conformance requirements |
| Provider normalizer | `bridge/lib/provider-adapter.js:169` `OpenAICompatibleProviderAdapter` | Validates session acknowledgement, response/tool identity, terminality, transcripts and interruption for OpenAI/xAI | Does not emit `RealtimeLifecycleEvent` v2 or EvidenceTap events; Gemini is explicitly unsupported |
| Media loop | `bridge/lib/session.js:789` `handleProviderEvent` | Normalizes provider output, tool batches, interruptions and terminal responses | Does not assert a current Turn Contract before response release or tool admission |
| PCM forwarding | `bridge/lib/session.js:862` `handleOutputAudio` | Splits μ-law output into bounded chunks and pairs each with a Twilio mark | Generated/released/played ranges are not applied to `audibility-v2`; chunk hashes are not retained in production evidence |
| Playback acknowledgement | `bridge/lib/session.js:929` `acknowledgePlaybackThrough` | Advances played bytes only when Twilio echoes an issued mark | This is the strongest existing production audibility signal, but it is stored only as a generic journal event |
| Barge-in repair | `bridge/lib/session.js:950` `handleBargeIn` | Clears queued Twilio media, cancels the response, truncates provider history, and retires unexecuted calls | Clear/truncation state is not a persisted audibility ledger and does not refresh the conversation Turn Contract |
| Tool execution | `bridge/lib/session.js:1101` `dispatchToolBatch` | Pins one catalog snapshot for the batch and serially calls the authority gateway | Does not bind a Turn Contract; all calls in a batch intentionally use the pre-batch catalog but the continuation receives no new closed response contract |
| Journal | `bridge/lib/event-journal.js:219` `EventJournal` | Bounded at-least-once batches with strict acknowledgement and terminal reserve | In-memory until delivered; it is transport custody, not EvidenceTap v2 or the conversation program |
| Journal ingress | `web/app/api/telephony/events/route.ts:154` `POST` | Hash-validates and idempotently writes bridge events to `call_events` | Does not translate accepted events atomically into program, audibility, conformance, and evidence projections |

There is also a separate xAI SIP/webhook runtime at `web/app/api/voice/webhooks/route.ts`. It opens its own realtime connection and writes generic call events directly. It must either become a conforming v2 adapter or remain explicitly legacy-only; it cannot silently bypass the composition root while HACC v2 is claimed for PSTN.

### Durable workers

`launch_task` already has stronger handling than a fire-and-forget tool: it derives a read-only manifest, uses deterministic identities, writes a durable worker, and has crash-gap reconciliation. The live route then claims applicable inbox messages before recompiling a packet.

The remaining split is structural:

- `conversation-call-coordinator-postgres.ts:112` constructs action and worker authorities, but `live-conversation-route-postgres.ts:109` erases the coordinator types and `live-conversation-route.ts` submits neither actions nor worker spawns.
- `run_action` owns the `launch_task` special case in `mcp.ts`, while the generic v2 program and effect coordinator do not see the same transition atomically.
- worker application advances the older conversation kernel, not `conversation-program`.
- a tool result can carry a refreshed packet, but neither browser nor bridge installs a new closed Turn Contract before the provider continues.

## Committed v2 modules that are not yet production callers

The following search should eventually return production composition callers, not only exports, READMEs, and tests:

```bash
rg -n 'createConversationProgramLog|foldConversationProgram|createProductionTurnContract|GovernedEffectCoordinator|AudibilityLedger|EvidenceTapV2|RealtimeLifecycleConformanceValidator' \
  web bridge --glob '!**/*.test.*' --glob '!**/__tests__/**'
```

At the inspected snapshot:

| Module | Implemented property | Production gap |
|---|---|---|
| `web/lib/conversation-program` | Goals, Flow checkpoints, obligations, capability epochs, receipts, workers and audibility in one deterministic projection | Standalone in-memory log/envelope duplicates concepts from `conversation-kernel`; no PostgreSQL or live-route adapter |
| `web/lib/runtime-control` | Strict, hash-bound Production Turn Contract with freshness assertions and ambiguity collapse | No call from `voice.ts`, `live-conversation-route`, MCP, browser transports, bridge, or speech release |
| `web/lib/governed-effect-runtime` | Policy -> lease -> reservation -> one-way dispatch -> settlement -> one read-only reconciliation job | No PostgreSQL store adapter, action adapters, or `run_action` call site |
| `web/lib/audibility-v2` | Exact generated/released/acknowledged/cleared sample ranges and receipt-bound terminal-claim grants | No durable store or browser/bridge event mapper |
| `web/lib/realtime/conformance-v2` | Provider-acknowledged session identity and causally valid normalized lifecycle | Current browser and bridge normalizers do not feed it |
| `web/lib/evidence-v2` | Typed, chained, signed evidence bundle and offline endpoint replay | In-memory tap has no production sink, lifecycle, raw-artifact store, or terminalizer |

## Target production composition

Add one server-only composition root, `web/lib/hacc-runtime-v2/production.ts`, exposing narrow operations rather than allowing routes to construct authorities independently:

```ts
type HaccRuntimeV2 = {
  openCall(input): Promise<RuntimeSessionReceipt>
  prepareTurn(input): Promise<PreparedTurn>
  admitProgramTransition(input): Promise<ProgramTransitionReceipt>
  executeEffect(input): Promise<EffectExecutionReceipt>
  spawnWorker(input): Promise<WorkerSpawnReceipt>
  deliverWorkerResult(input): Promise<WorkerDeliveryReceipt>
  observeProviderEvent(input): Promise<ProviderObservationReceipt>
  observeAudio(input): Promise<AudibilityObservationReceipt>
  closeCall(input): Promise<TerminalEvidenceReceipt>
}
```

`PreparedTurn` contains one atomically read authority snapshot:

- conversation/program revision and head;
- Flow and Mission revisions/digests;
- capability epoch and active catalog;
- Production Turn Contract and retained contract digest;
- provider-neutral context packet;
- pending worker and ambiguity state;
- evidence sequence/head.

Neither routes nor providers may combine a catalog from one read with a packet or Turn Contract from another.

## Immediate P0 — unblock the browser evidence journal

This precedes every architecture patch because current browser speech-gate evidence can poison the shared persistence queue.

Files:

- change `web/app/api/calls/[id]/events/route.ts`;
- change `web/components/call/realtime.ts`;
- extend the route and browser realtime tests with one real client-to-route contract test.

Work:

1. Add an explicit, strictly reconstructed `outbound_speech_gate` server schema. Admit only bounded identifiers, provider/action/reason enums, digests, byte/range counts, timings and violation codes. Never admit raw PCM, transcripts, provider frames, credentials or arbitrary nested error strings through this endpoint.
2. Give every queued browser event a bounded `client_event_id`, and make accepted IDs idempotent per call. A response loss must not duplicate durable evidence.
3. Separate permanent schema rejection from transient failure. Return structured rejected indices/IDs for a syntactically valid batch; the client removes only those terminally rejected items, records one content-free `client_persistence_loss` marker, and continues. `5xx`, timeouts and disconnects remain bounded retries.
4. Preserve strict validation. Do not fix queue liveness by accepting unknown event types or silently dropping invalid evidence server-side.
5. Add the exact regression: queue a valid `outbound_speech_gate`, then `agent_said`, then `user_said`; flush through the real sanitizer/handler and prove all three persist once. Also prove raw PCM, cross-call IDs, oversized ranges and tampered digests are terminally rejected without blocking the following valid event.

Gate:

- no valid event can be held behind a permanently invalid event;
- a lost success response produces no duplicate event;
- retries are finite at shutdown and the terminal loss count is truthful;
- the endpoint remains same-origin, tenant-owned, size-bounded and content-scrubbed.

## Ordered patch sequence

### Patch 0 — pin runtime mode and contracts

Files:

- change `web/lib/call-runtime-snapshot.ts` and its tests;
- change call creation in `web/lib/voice.ts`;
- add `web/lib/hacc-runtime-v2/types.ts` and `production.ts`;
- add an additive migration after the current migration tip.

Work:

1. Add `controlPlane: "legacy_v1" | "hacc_v2_shadow" | "hacc_v2_enforced"` to the immutable call runtime snapshot.
2. Generate one logical runtime session ID per call and one connection epoch per physical provider connection.
3. Pin required provider features, Turn Contract version, program version, audibility version and EvidenceTap version.
4. Store only public identities/digests in the snapshot. Signing keys and provider secrets remain external.
5. Default existing agents and already-open calls to `legacy_v1`; enable v2 only for newly allocated calls through a server-side allowlist.

Gate:

- same call can never change mode;
- exact snapshot replay is byte-stable;
- unknown versions fail before a provider connection or microphone grant;
- rollback affects new calls only.

### Patch 1 — make `conversation-program` a projection of the existing one log

Files:

- change `web/lib/conversation-kernel.ts` and `conversation-runtime.ts`;
- add `web/lib/conversation-program/conversation-kernel-adapter.ts`;
- change `web/lib/conversation-runtime-postgres.ts` only if the adapter needs a versioned read;
- extend migration `033` through a new additive migration; never rewrite `voice_conversation_events` rows.

Work:

1. Keep `voice_conversation_events` and `voice_conversations.event_head_*` as the only physical order and head.
2. Treat `ConversationProgramEventDraft` as a logical event. Wrap new program payloads in a versioned outer conversation event or extend the existing payload union with non-conflicting v2 event names.
3. Fold legacy facts/goals/commitments/Flow checkpoints/workers through an explicit read-only compatibility mapper.
4. New v2 events are never reverse-written to legacy tables. Legacy Flow state may remain temporarily as a compatibility projection, but it cannot authorize an effect without a matching current program head.
5. Add obligations, action reservations/receipts and audibility references to the production fold.

Do not persist the standalone `ConversationProgramLog` as a second hash chain. Its digest may be a deterministic projection/evidence value, but the PostgreSQL conversation head is authority.

Gate:

- 1,000 seeded crash/replay schedules end at the same event head and program digest;
- existing conversation rows fold without mutation;
- a conflicting legacy/program projection blocks the action frontier;
- a suspended goal exposes no actions;
- a correction advances the capability epoch and invalidates dependent proposals, confirmations and worker deliveries.

### Patch 2 — compile one Turn Contract from the same head

Files:

- change `web/lib/live-conversation-route.ts` and `live-conversation-route-postgres.ts`;
- change `web/lib/voice.ts`;
- add `web/lib/runtime-control/program-source.ts`;
- change `web/app/api/mcp/route.ts` and the gateway result envelope;
- change `web/components/call/providers/types.ts` and each browser transport.

Work:

1. Replace the route's current mirror -> packet -> worker delivery -> second packet sequence with one bounded transaction/replan loop: mirror current Flow, deliver applicable workers, load one terminal program head, derive catalog, packet and Turn Contract, then return them together.
2. Retain `{freshness, contract_sha256}` server-side with the physical connection epoch. Provider-returned hashes never establish freshness.
3. Inject the Turn Contract as advisory provider context, but enforce it at the host tool and speech boundaries.
4. Add the refreshed contract and digest to the MCP result envelope beside the catalog and packet.
5. Extend `BrowserRealtimeTransport` with `installTurnControl(prepared)` and require acknowledgement before tool continuation or the next response.
6. Reuse the normalized clients' existing `prepareResponse`, `prepareToolContinuation`, and xAI `prepareServerVadTurn` semantics rather than inventing provider-specific ordering again.
7. For a transport that cannot install current control before server-VAD audio can trigger generation, either add a bounded input-media barrier or fail v2 admission. Never silently run an old contract.

Assertions:

- immediately before logical tool binding;
- again in the same transaction as effect reservation;
- immediately before any claim-bearing audio release;
- after every Flow/program transition, worker delivery, receipt settlement, correction, barge-in and reconnect.

Gate:

- 10,000 state transitions produce the exact registered intent/action frontier;
- stale contracts are rejected at tool and speech boundaries;
- compilation p95 stays below 5 ms;
- provider-visible contract stays within the frozen byte cap;
- a refresh failure produces an empty frontier and recovery response, never a legacy fallback.

### Patch 3 — make governed admission the default `run_action` path

Files:

- add `web/lib/governed-effect-runtime/postgres-store.ts` and `adapters.ts`;
- change `web/lib/mcp.ts` at `callActiveCapability` and the `run_action` case;
- change `web/lib/flow-state-store.ts` to compatibility projection helpers;
- add an additive governed-effect migration with immutable receipts, leases, dispatch markers and unique reconciliation jobs.

Work:

1. Build `GovernedEffectProposal` only from the host-bound logical invocation, current program/Flow head, catalog binding and provider invocation identity.
2. Assert the retained Turn Contract before `GovernedEffectCoordinator.execute`.
3. Implement a PostgreSQL `GovernedEffectStore` whose reservation and dispatch-boundary functions compare the current program head, Flow digest, capability epoch and policy digest under one lock.
4. Wrap built-in, extension, generated, and remote MCP actions as explicit adapters. Each declares `effect`, authoritative acknowledgement semantics and one read-only reconciliation contract where available.
5. Let `GovernedEffectCoordinator` own dispatch and settlement. The existing `mcp_tool_invocation_receipts` remains transport replay authority; `flow_action_receipts` becomes a compatibility view/projection of the governed receipt for v2 calls.
6. Host program transitions such as `classify`, `enter_step`, `complete_step` and `get_flow_state` do not cross the external-effect adapter. They still require the same current Turn Contract and append one program event transactionally.
7. An action lacking a trustworthy effect classification or terminal acknowledgement is `opaque`. After its dispatch marker, any error or missing proof is indeterminate and never auto-retried.

Do not dual-dispatch through the old `run_action` body and the new coordinator. The pinned call mode selects exactly one owner before admission.

Gate:

- 10,000 concurrent/replay schedules produce zero duplicate semantic effects;
- every write/opaque adapter has exactly one persisted dispatch attempt;
- stale authority, expired leases and policy denials dispatch zero times;
- indeterminate effects create one read-only reconciliation job;
- every previous Flow v2 example produces the same public business result and a stronger receipt chain.

### Patch 4 — bring workers into the same program transition

Files:

- change `web/lib/conversation-call-coordinator-postgres.ts`;
- change `web/lib/voice-workers/*` and `web/lib/governed-call-worker-executor.ts`;
- change `web/lib/live-conversation-route-postgres.ts`;
- change the `launch_task`, `check_worker` and `get_worker_updates` paths in `web/lib/mcp.ts`.

Work:

1. Route `launch_task` through the v2 effect adapter, but atomically bind its worker row and `worker.spawned` program event before the governed receipt can succeed.
2. Keep worker capabilities read-only for this release. A future mutating worker needs a separate indeterminate/reconciliation contract.
3. On delivery, lock the current program head and revalidate goal focus, dependency fact revisions, capability epoch and result digest before one `worker.delivery_recorded` event.
4. Accepted delivery forces a new Turn Contract before the provider sees the tool continuation. Deferred or rejected content never enters provider context.
5. Replace the live route's accepted-count-only result with exact delivery event IDs and resulting program head.
6. Make reconciliation jobs use the same durable worker scheduler, but a distinct recipe/audience that permits only the adapter's pinned read-back operation.

Gate:

- one semantic spawn maps to one worker and one program event;
- duplicate delivery applies once;
- stale, cancelled or superseded results advance no fact, Flow step or claim grant;
- every process-loss point between spawn, settle, execute and deliver has a deterministic terminal disposition;
- minute-scheduler recovery remains bounded and tenant-isolated.

### Patch 5 — normalize provider lifecycle in browser and bridge

Files:

- change `web/lib/realtime/plugins/types.ts`, built-ins and registry;
- change `web/components/call/providers/openai-webrtc.ts`, `xai-websocket.ts`, `gemini-websocket.ts`;
- change `bridge/lib/provider-adapter.js` and `bridge/lib/session.js`;
- add bridge-side conformance serialization compatible with `web/lib/realtime/conformance-v2`.

Work:

1. Assign stable logical-session, connection-epoch, turn, response, audio-delta, tool-call and tool-result identities.
2. Translate actual inbound provider events into `RealtimeLifecycleEvent` v2.
3. Feed one `RealtimeLifecycleConformanceValidator` per logical session and persist every normalized event plus the raw wire hash.
4. Treat requested model/voice/settings as a request only. V2 becomes ready only after provider-authored acknowledgement satisfies the pinned required-feature vector.
5. Add explicit dynamic-control acknowledgement/proof to browser and bridge continuation ordering.
6. Keep the hardened bridge fail-closed for Gemini PSTN until a real Gemini adapter, PCM/μ-law transcode, tool continuation and interruption conformance suite pass. Do not report three-provider PSTN support before that work exists.
7. Replace the browser factory switch with the validated plugin registry as the single production provider-construction path. Keep provider-specific transports behind registry adapters; a synthetic fourth provider must not edit `voice.ts`, MCP, Turn Contract, worker, audibility or EvidenceTap code.
8. Route the separate xAI SIP webhook runtime through the same adapter/composition contract or pin it to `legacy_v1` in both configuration and public capability metadata.
9. Keep `web/lib/bridge.ts` disabled and delete it only after standalone bridge deployment and rollback documentation are proven.

Gate:

- the unchanged conformance suite passes for all supported provider/transport cells;
- request-only acknowledgement fails;
- missing required features fail before caller audio is admitted;
- provider reconnect increments only the connection epoch and compiles a fresh Turn Contract from the durable head;
- a synthetic fourth provider requires no core-runtime switch edit.

### Patch 6 — make audibility authoritative

Files:

- add a durable `web/lib/audibility-v2/postgres-store.ts`;
- change browser playback helpers in `web/components/call/providers/types.ts` and `outbound-speech.ts`;
- change `bridge/lib/session.js` and `web/app/api/telephony/events/route.ts`;
- change `web/lib/live-conversation-route-postgres.ts:116` `recentAudibleTurnsForCall`;
- add a narrowly authenticated browser audibility endpoint or typed event variant.

Work:

1. Register every provider response and exact PCM chunk before release.
2. Detect claim-bearing ranges against the Turn Contract. A terminal/external-effect claim receives a grant only from the exact settled governed receipt and current authority revision.
3. Run every release request through `audibility-v2`. Missing grants block overlapping ranges before playback.
4. Browser: record exact scheduled ranges and `AudioBufferSourceNode.onended` device-render acknowledgements. Label this `device_render_acknowledged`, not proof a human perceived sound.
5. Twilio: map media enqueue, issued mark, echoed mark, clear, barge-in and provider truncation into exact half-open sample ranges. An echoed mark is transport-playback acknowledgement, still not proof of human perception.
6. Apply audibility events and corresponding program references under one ingestion transaction. A late mark from a cleared queue epoch must fail closed.
7. Replace `provider_transcript_unverified_playback` agent turns in `recentAudibleTurnsForCall` with text aligned to acknowledged ranges. Missing/low-confidence alignment remains `unverifiable` and is not promoted.

Gate:

- 500 browser and 500 PSTN interruption schedules promote zero unheard ranges;
- 500 terminal-claim trials release zero ungranted claim ranges;
- clear/disconnect invalidates late playback acknowledgements;
- exact PCM/range/evidence hashes replay identically;
- ASR or playback evidence loss yields `unverifiable`, never a success claim.

### Patch 7 — attach EvidenceTap to production authority

Files:

- add `web/lib/evidence-v2/postgres-store.ts`, `production-tap.ts` and a terminalizer;
- change the runtime v2 composition root, MCP ingress, worker store, provider event ingress and audibility ingestion;
- change benchmark runners to consume only serialized production bundles.

Work:

1. Do not keep a long call's only EvidenceTap in process memory. Append normalized typed evidence to an org/call-scoped durable table with compare-and-append sequence/hash semantics.
2. Emit evidence at the point of authority: plan/contract registration, catalog publication, provider observation, action attempt/policy/receipt, worker event, generated/released/played audio, world/program transition, usage and terminal disposition.
3. Store raw PCM and provider frames in a private content-addressed artifact store; EvidenceTap contains their digests and bounded metadata, never credentials or raw private tool results.
4. Finalize once after all bridge/browser/tool/worker journals are terminal. Sign through an external Ed25519 signer; never store the private key in the bundle or repository.
5. Make every opened run terminal, including adverse, aborted, infrastructure-failed and unverifiable runs.
6. Freeze evidence-plane applicability in the evaluation contract before a call opens. The current replay rejects every category or event type with a zero count, which incorrectly makes an actionless or workerless call unverifiable. Represent `required`, `not_applicable`, and `missing` distinctly; never fabricate placeholder action or worker events to make a root non-empty.
7. Delete benchmark-specific control-plane emission only after the benchmark can reconstruct its endpoints exclusively from the production bundle.

Gate:

- the standalone verifier derives all registered endpoints from the production bundle;
- byte mutation, deletion, reorder, substitution, wrong signer, missing evidence plane or broken causal reference fails replay;
- a contract-declared non-applicable plane with zero events verifies, while a required plane with zero events fails;
- an unsafe but correctly recorded call remains valid adverse evidence;
- benchmark code imports production contracts and replay only, never a separate HACC treatment implementation.

### Patch 8 — shadow, enforce, then remove parallel paths

Rollout:

1. **Offline:** all deterministic, migration, fault and replay gates; no provider spend.
2. **Shadow:** production-shaped calls run the legacy owner while v2 folds the same accepted events and compares heads/frontiers. V2 performs no effects and releases no speech.
3. **Read/control enforcement:** v2 owns reads and Flow/program transitions; consequential effects remain legacy for entire pinned calls.
4. **Browser enforcement:** v2 owns all new allowlisted browser calls.
5. **PSTN enforcement:** v2 owns all new allowlisted standalone-bridge calls after bridge persistence/audibility gates.
6. **Benchmark:** Native and HACC both use the production provider/media/evidence substrate; only the registered treatment contract differs.
7. **Default:** v2 becomes the default for newly published Flow v2 agents.
8. **Removal:** delete benchmark-only HACC treatment code, then legacy action ownership, only after two releases with replay-complete rollback evidence.

No mid-call fallback is allowed. If v2 fails after provider or effect admission, the call records a terminal failure or safe handoff; it does not switch to legacy authority.

## Non-negotiable invariants

| ID | Invariant | Enforcement point |
|---|---|---|
| I1 | One conversation event head is the authoritative order | PostgreSQL compare-and-append transaction |
| I2 | One effect receipt owns each semantic write/opaque action | Governed-effect unique reservation and dispatch marker |
| I3 | Model/provider content cannot mint grants, epochs, receipts or freshness | Active catalog private binding and retained Turn Contract digest |
| I4 | Every tool or speech decision uses one atomically read authority snapshot | Runtime v2 `prepareTurn`, gateway and release assertions |
| I5 | Post-dispatch uncertainty is indeterminate and never blindly retried | Governed effect settlement and unique read-only reconciliation job |
| I6 | Worker completion is advisory until current-head delivery policy accepts it | Worker delivery transaction |
| I7 | Generated or transcribed speech is not proof of playback | Audibility ledger acknowledged ranges only |
| I8 | Terminal effect claims require exact current receipt grants | Turn Contract claims plus audibility release decision |
| I9 | Provider configuration requests are not acknowledgements | Realtime conformance validator |
| I10 | Production and benchmark HACC execute the same runtime code | EvidenceTap/replay import boundary |
| I11 | Runtime mode cannot downgrade or change during a call | Pinned call runtime snapshot |
| I12 | Every database operation is call/org scoped and role bounded | SQL foreign keys, `SECURITY DEFINER` functions, RLS and worker role |

## Compatibility and data migration

### Existing calls and data

- Do not backfill synthetic v2 evidence for historical calls.
- Historical and already-open calls retain `legacy_v1` and their original runtime snapshot semantics.
- The program compatibility mapper may read legacy conversation events, Flow checkpoints and worker events. It must mark missing receipt/audibility/conformance facts as `unverifiable`, never invent them.
- No migration may rewrite the existing hash-chained `voice_conversation_events` rows.
- Additive tables and functions are rolled forward; rollback disables assignment of v2 to new calls but preserves evidence and receipts for existing v2 calls.

### Existing agents and Flow v2 packages

- Keep Flow JSON, logical action names and the provider-visible `capability_gateway` arguments stable.
- Keep public business outputs stable. Add v2 authority fields only inside the existing verified gateway envelope.
- Flow v1 direct mode remains legacy-only. A v2 call must reject direct write/opaque exposure and provide a migration diagnostic.
- Existing worker recipes remain read-only and version-pinned.

### Provider compatibility

- A provider/transport cell is enabled only when its exact pinned model, voice, acknowledgement, tool continuation, interruption and audio format pass conformance.
- Browser support and PSTN support are separate capabilities.
- Gemini browser readiness does not imply Gemini PSTN readiness.
- Native provider resumption is an optional transport optimization. A fresh packet and Turn Contract from the application head remain authority.

## Verification matrix

### Focused unit and property suites

Retain and extend:

- `web/lib/runtime-control/__tests__/turn-contract.test.ts`;
- `web/lib/conversation-program/__tests__/conversation-program.test.ts`;
- `web/lib/governed-effect-runtime/__tests__/coordinator.test.ts`;
- `web/lib/audibility-v2/__tests__/ledger.test.ts`;
- `web/lib/evidence-v2/__tests__/evidence-v2.test.ts`;
- `web/lib/realtime/conformance-v2/conformance-v2.test.ts`.

Add seeded property tests for cross-module invariants, not only module-local validity:

- correction between contract compile and effect reserve;
- Flow transition between batch calls;
- worker completion between policy decision and dispatch boundary;
- disconnect after dispatch but before settlement;
- claim grant revoked before PCM release;
- playback clear followed by late browser/Twilio acknowledgement;
- reconnect with stale provider history;
- EvidenceTap crash before terminalization.

### Database integration suites

Add:

- `web/lib/__tests__/conversation-program-postgres.integration.test.ts`;
- `web/lib/__tests__/governed-effect-runtime-postgres.integration.test.ts`;
- `web/lib/__tests__/audibility-v2-postgres.integration.test.ts`;
- `web/lib/__tests__/evidence-v2-postgres.integration.test.ts`;
- `web/lib/__tests__/hacc-runtime-v2-atomic-turn.integration.test.ts`.

Each suite must run real concurrent transactions and kill/restart at every durable boundary. Mocking the store interface is not proof of SQL atomicity.

### Browser transport suites

Extend the existing OpenAI, xAI and Gemini browser tests to prove:

- provider acknowledgement feeds conformance;
- Turn Contract is installed before caller audio or tool continuation;
- stale contract causes no response or tool dispatch;
- exact PCM chunks enter audibility before release;
- `onended`, interruption and stop map to correct ranges;
- an unresolved tool call at provider close terminalizes as indeterminate without redispatch;
- the production EvidenceTap sees the same normalized events.

### Standalone bridge suites

Extend:

- `bridge/test/provider-adapter.test.js`;
- `bridge/test/session.test.js`;
- `bridge/test/event-journal.test.js`;
- `bridge/test/server.integration.test.js`.

Required fault points:

- before/after bootstrap commit;
- before/after provider acknowledgement;
- before/after Twilio media enqueue and echoed mark;
- before/after clear and truncation acknowledgement;
- before/after authority gateway request and response;
- before/after journal batch acknowledgement;
- shutdown with pending marks, tools, bootstrap or capability rotation.

### End-to-end release gate

A provider-free fake realtime transport must first prove the entire browser and PSTN-shaped composition:

```text
program event -> Turn Contract -> provider proposal -> governed effect
-> receipt/reconciliation -> worker delivery -> claim grant -> PCM release
-> playback acknowledgement -> EvidenceTap terminal bundle -> offline replay
```

The offline gate requires:

- 10,000 authority races;
- 10,000 reconnect/crash schedules;
- 1,000 browser interruption schedules;
- 1,000 PSTN mark/clear schedules;
- zero duplicate or unauthorized effects;
- zero stale worker applications;
- zero ungranted claim releases;
- byte-identical endpoint replay.

Only then should paid transport qualification begin. Provider calls validate transport compatibility; they are not a debugging loop for authority, storage, evidence or scoring.

## Definition of production integration complete

Runtime v2 is integrated only when all of the following are true:

1. `voice.ts`, MCP, browser transports and the standalone bridge call the same v2 composition root.
2. Every v2 response and tool continuation is bound to a current Production Turn Contract.
3. Every v2 write/opaque action is owned by `GovernedEffectCoordinator` with one persisted dispatch marker.
4. Flow, goals, obligations, receipts, workers and audibility fold from the one PostgreSQL conversation head.
5. Only acknowledged playback ranges can become agent conversational context.
6. OpenAI, Gemini and xAI browser cells pass the same provider conformance contract; PSTN cells are claimed only where separately proven.
7. Every opened call receives a terminal, independently replayable EvidenceTap v2 bundle.
8. The benchmark imports the production runtime/evidence interfaces and contains no alternative HACC response planner, effect gateway, worker semantics or audibility authority.
9. Existing Flow v2 examples and public gateway outputs remain compatible.
10. Shadow comparison, rollback and migration evidence are checked in at the exact release commit.

Until these conditions hold, the accurate public statement is: HACC has tested v2 runtime primitives and a partially durable production path, but the complete v2 harness is not yet the default browser/PSTN runtime.
