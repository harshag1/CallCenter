# Deterministic call-turn coordination

[`membership-renewal-turn.json`](membership-renewal-turn.json) is an executable
fixture for the provider-neutral `ConversationCallCoordinator`.

One call to `runTurn`:

1. commits host-authoritative facts, the active goal, and the Flow checkpoint to
   the hash-chained conversation log;
2. asks the governed action store to reserve (not dispatch) the membership
   lookup;
3. atomically spawns a durable research worker with a matching
   `worker.spawned` event; and
4. compiles the next OpenAI/Gemini/xAI-neutral realtime context packet from the
   resulting durable head.

All event, action, and worker identities are derived from the organization,
conversation, turn, phase, and operation. Replaying the same fixture after a
crash is therefore safe. Reusing an operation identity with different durable
event bytes fails closed.

The production composition root is
`web/lib/conversation-call-coordinator-postgres.ts`. It connects the
PostgreSQL conversation runtime, governed Flow action reservation, and governed
durable worker store. Provider adapters consume only the compiled packet; they
do not become workflow authority.
