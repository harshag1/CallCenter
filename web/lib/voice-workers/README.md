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
  kernel, which may accept, defer, or reject it. A deferred late result is not
  acknowledged or promoted into conversation authority.

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

Every command returns a hash-bound operation receipt containing the exact
authority receipt, request digest, outcome digest, policy epoch, conversation
revision, worker identity, and idempotency identity. Replayed commands return
the original receipt rather than repeating the backend transition.

The substrate is intentionally at-least-once at the executor boundary. A lease
can be reclaimed before dispatch. Once dispatch begins, loss of the executor is
`indeterminate` until a recipe-specific authoritative read proves what
happened. The framework does not claim exactly-once effects for an arbitrary
external API.
