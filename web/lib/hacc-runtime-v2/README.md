# HACC Runtime Coordinator v2

`HaccRuntimeCoordinatorV2` is the provider-neutral production composition root
for HACC's durable conversation authority. It connects five independently
testable components without allowing a speech provider to become an authority:

1. `ConversationProgram` is the append-only state, goal, capability, receipt,
   worker, and coarse audibility authority.
2. `ProductionTurnContract` is recompiled after every admitted operation and
   retained by the host. Incoming effects and speech releases must present its
   exact current hash.
3. `GovernedEffectCoordinator` owns policy evaluation, the one-way dispatch
   boundary, idempotency, indeterminate outcomes, and read-only reconciliation.
4. `AudibilityLedgerV2` separates generated, released, and acknowledged-played
   PCM and requires reopened receipt authority for consequential claims.
5. `EvidenceTapV2` records the replayable plan, action, worker, audio, playback,
   world, and provider evidence planes.

## Storage boundary

The coordinator contains no database, provider, filesystem, or global-memory
implementation. A `HaccRuntimeStoreV2` must serialize each conversation and
must invoke a transaction callback exactly once. It must never retry a callback
that could have crossed an external dispatch boundary. Production stores can
implement this contract with a row lock or an explicit per-call lease.

The governed-effect store remains separately injected because it owns the
atomic external-effect boundary. `onCommit` lets a projection-backed effect
store observe the newly committed conversation head.

## Integration invariant

Provider code may submit normalized provider events, program events, effect
proposals, and audibility events. It may not:

- select a capability outside the current contract;
- admit an effect using provider-retained context;
- release claim-bearing audio with a stale contract or receipt;
- retry an indeterminate write;
- accept a worker result after its goal, fact dependencies, or capability epoch
  changed; or
- resume from a stored snapshot whose contract cannot be regenerated exactly.

See `__tests__/coordinator.test.ts` for the full correction → detour → stale
worker → governed indeterminate write → reconciliation → claim grant → partial
playback → barge-in → reconnect/replay sequence.
