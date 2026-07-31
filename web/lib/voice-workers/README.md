# Governed voice workers

The worker layer separates long-running follow-through from the realtime speech
model. A model may request a registered recipe, inspect its status, or request
cancellation. It cannot choose its own organization, conversation, policy
epoch, capability manifest, execution lease, result-delivery policy, or
idempotency identity.

`coordinator.ts` exposes five provider-neutral primitives:

- `spawn` admits one immutable, read-only recipe under the current goal, fact
  revisions, policy epoch, and conversation head;
- `status` returns lifecycle state and evidence digests without copying a large
  worker result into model context;
- `cancel` records a monotonic cancellation request and is safe to redeliver;
- `reconcile` distinguishes a reclaimable pre-dispatch lease loss from a
  post-dispatch indeterminate outcome that must not be blindly re-run;
- `deliverResult` submits immutable result evidence to the current conversation
  kernel, which may accept, defer, or reject it. A temporarily suspended goal
  defers delivery without acknowledgement. Permanent policy, fact, or goal
  drift rejects and acknowledges the stale result so it cannot poison the
  inbox; no rejected result is promoted into conversation authority.

Every live tool surface also exposes two provider-neutral pull controls:

- `check_worker` returns only the exact worker's lifecycle and evidence
  digests; it never copies the worker's content into the tool result.
- `get_worker_updates` asks the host to compile a fresh bounded context packet.
  Accepted results can enter that later packet only as explicitly untrusted
  advisory data.

The stock `launch_task` integration does not carry a framework-wide read
allowlist. Before the Flow receipt crosses its dispatch boundary, the host
derives one immutable capability manifest from the intersection of:

1. read-classified tools in the exact active capability catalog;
2. the current Flow checkpoint's granted tools; and
3. the gateway's executable `background` audience.

An empty intersection is a durable `not_sent` rejection, not an
`indeterminate` worker. Pinned calls with no dataset slugs expose neither
`read_table` nor `write_table`; tables created after the call snapshot cannot
expand the worker's authority. When table reads are present, the background
gateway validates every invocation against the pinned enum before dispatch;
provider compliance with the advertised schema is never treated as the
security boundary.

## Untrusted worker content

Worker lifecycle, digests, policy scope, and delivery decisions are host
authority. Worker-authored content is not. Durable provider packets label all
of the following `untrusted_advisory`:

- the worker objective/purpose derived from model or caller input;
- returned fact values and opaque citation identifiers;
- worker/model summaries; and
- recent transcript text.

Delivery acceptance means that organization, goal, policy epoch, dependency
revisions, and evidence hashes matched. It does **not** promote a worker value,
citation, or summary to authoritative truth or to system instructions. Raw
citation URIs, titles, and excerpts remain in private result evidence and are
not injected into the realtime system packet.

## Wiring

1. Construct a `GovernedWorkerRecipeRegistry`. Recipes pin a worker kind and an
   explicit `read_only` capability manifest. Their optional input parser is
   trusted code and must be versioned.
2. Implement `GovernedWorkerBackend` with the durable transitions in
   `store.ts`. Spawn should call `spawnGovernedDurableVoiceWorker`; cancellation
   should call `requestDurableVoiceWorkerCancellation`; accepted delivery
   should call `applyGovernedDurableConversationInboxMessage`.
3. Resolve `GovernedWorkerAuthorityReceipt` from the host policy ledger for
   every invocation. Never build it from tool arguments. The coordinator checks
   its call, agent, organization, runtime, receipt, invocation, operation,
   recipe or worker scope, head, and expiry before backend I/O.
4. Inject a durable, shared `GovernedWorkerOperationJournal`. Its reservation of
   `(conversation, idempotency key, request digest)` must commit before an
   effect starts and retain indeterminate outcomes. The included in-memory
   journal is only for tests and single-process development.
5. Pass `createGovernedWorkerToolPack(...)` to the existing voice-tool pack
   composition layer. Only the gateway's `flow_action` audience can spawn or
   cancel. Reconciliation and result delivery require the dedicated
   `reconciliation` audience.

Worker execution uses a distinct database credential even when it runs inside
the web deployment. `WORKER_DATABASE_URL` must identify a login that inherits
only `hacc_voice_worker`. That narrow role can discover one content-free
candidate and call exact tenant/conversation-scoped claim, heartbeat, mark,
and settle transitions; it has no direct worker/application table access and
no legacy global queue or bearer-token lifecycle grant. Never reuse the web,
scheduled-dialer, or migration-owner credential.

The stock embedded executor claims the exact worker created by
`launch_task`—never the globally oldest job—and keeps that exact lease alive
while checking cancellation and ownership between bounded operations. Its
rounds, provider requests, transcript/input bytes, tool calls, tool
arguments/results, search calls, and generated output all have hard ceilings.
Structured table and knowledge outcomes are the only source of host-issued,
content-addressed citations; free-form model prose cannot mint provenance.

`launch_task` derives deterministic Flow action, operation, worker, and spawn
event identities before dispatch. If the host crashes after the database spawn
commits but before the Flow/MCP receipts settle, an expired replay verifies the
immutable worker, manifest, input, event, current runtime, and Flow ledger,
then atomically promotes the existing spawn evidence. It never creates a
replacement worker.

Every command returns a hash-bound operation receipt containing the exact
authority receipt, request digest, outcome digest, policy epoch, conversation
revision, worker identity, and idempotency identity. Replayed commands return
the original receipt rather than repeating the backend transition.

The authenticated minute scheduler is a bounded durable backstop; inline
`waitUntil(...)` execution only reduces latency. The stock governed recipes
are read-only, so an expired lease can be reclaimed after process loss even
after provider dispatch. This is intentionally at-least-once and can duplicate
read cost, but cannot duplicate a business mutation. A future mutating recipe
must instead become `indeterminate` after dispatch until a recipe-specific
authoritative read proves what happened; the framework does not claim
exactly-once effects for arbitrary external APIs.
