# LC4 rotation review context

## User goal

Harsha wants Harsha's Amazing Call Center to be a genuinely useful open-source
runtime for long, intricate voice-agent calls: durable context, progressive
tool disclosure, realtime guardrails, and auditable behavior across OpenAI,
Gemini, and xAI. The immediate release needs a real six-call descriptive
benchmark, not fabricated or relabeled numbers.

## Exact decision

Choose how a new provider session receives the already-audible conversation at
the 20- and 40-opportunity planned rotation boundaries.

The current implementation serializes chronological caller, assistant, and
provider-visible tool turns into the new session's instruction string. A
retained paid run proved that this does not scale.

## Current source state

- Repository: this checkout
- Branch: `codex/pre-evening-batch-2026-07-02`
- Commit: `12650977209760e244b7df8d551788bd3b33cddd`
- Worktree was clean before this review packet was added.
- The benchmark is `HACC-LC4-DEV-v1`, development-only C3 descriptive evidence.
- It contains one 60-opportunity Native/HACC pair for each of OpenAI, Gemini,
  and xAI: six calls and 360 registered opportunities total.
- Each call deliberately closes and reopens the realtime provider session after
  opportunities 20 and 40.

## Exact retained failure proof

The latest run completed:

- all 60 OpenAI Native opportunities;
- the first 20 OpenAI HACC opportunities;
- 80 submitted and 80 completed opportunities;
- 86 provider generations including repairs;
- zero retries.

It then failed before opening OpenAI HACC segment 2. The terminal run retained
only the sanitized failure-message SHA-256:

`5e7b140348c37e798dbdc66d3ecad0f1f66e573b992bc3c67cee4fcf83bfe7fa`

Provider-free reconstruction from retained evidence proved the exact thrown
message was:

`LC4 rotation conversation text is invalid`

Its SHA-256 is exactly the retained digest. The first segment contained:

- 22 provider exchanges because two opportunities required bounded repair;
- 48 chronological replay turns: 22 caller, 22 assistant, and 4 tool turns;
- 21,962 UTF-8 content bytes;
- a largest provider-visible tool result of 9,187 bytes;
- 24,379 bytes of rendered chronological conversation;
- 24,799 bytes after the HACC state wrapper;
- 25,455 bytes after the common base instructions.

The local validator rejects any single replay turn over 4,000 characters.
Raising that ceiling alone would send a 25 KB session instruction, continue
growing without a principled bound, and conflate conversation history with
system-level instructions. No claim is made here about an undocumented provider
character limit. No new provider call has been made after proving this.

## Relevant implementation

Primary file:

`web/lib/benchmark/lc4-production-provider-adapter.ts`

Relevant symbols:

- `validateConversationTurns`
- `createLc4NativeConversationReplayPacket`
- `createLc4HaccRotationStatePacket`
- `assertLc4RotationConversationParity`
- `renderRotationConversationForProvider`
- `validateRotationContext`
- `Lc4RealtimeProviderBridge.openSegment`
- `createLc4DevRotationContext`

Current behavior:

1. The host retains a hash-bound packet containing exact chronological turns.
2. Native and HACC packets must share the same conversation replay hash.
3. HACC additionally receives two opaque state commitments:
   `flow_state_sha256` and `response_plan_chain_head_sha256`.
4. `openSegment` appends the entire rendered conversation to the base session
   instructions before constructing and connecting a fresh realtime client.

Realtime client:

`web/lib/realtime/client/openai-compatible.ts`

It currently supports session updates, live input audio, response preparation,
tool continuations, and normalized wire evidence. It does not yet expose a
provider-neutral pre-response historical-item replay API.

## Non-negotiable benchmark constraints

- No summaries, dropped turns, selected "important" history, semantic
  compression, or oracle/evaluator-derived context in this frozen comparison.
- Caller, assistant, and provider-visible tool role/order/content must remain
  lossless.
- Conversation history presented at rotation must be identical within each
  Native/HACC provider pair.
- HACC may additionally receive only the preregistered structured state
  commitments.
- Any new replay delivery must be wire-observed, hash-bound, provider-specific
  where necessary, and rejected if the provider cannot prove/admit the history.
- A completed result remains n=1 per arm/provider and cannot establish broad
  efficacy or provider rankings.

## Options under consideration

### A. Raise prompt limits

Allow the 9 KB tool turn and continue placing all history in session
instructions.

Rejected leaning: it remains unbounded, conflates system instructions with
conversation history, and already reaches 25 KB after only 20 opportunities.

### B. Lossy deterministic compaction

Summarize or retain a bounded window plus selected facts.

Rejected for this benchmark: it changes the frozen comparator, risks dropping
exact caller corrections and tool receipts, and would require a new scientific
protocol.

### C. Provider-native history-item replay

Keep the full host integrity packet, but after the new session acknowledges its
base configuration, replay prior caller/assistant/tool content through each
provider's native conversation-history/item mechanism before accepting new
audio. Require exact outbound wire evidence and a deterministic replay receipt.

Current leaning: strongest semantic and scaling boundary if all three provider
APIs support equivalent non-generating historical items.

### D. Provider resumption handles

Use a provider's native resume/session handle where available.

Possible optimization, but not provider-neutral and may not preserve identical
observable semantics or auditable content across all three providers.

## Current leaning and confidence

Lean toward C, with D as a future provider-specific fast path only after C is
the portable reference behavior. Confidence: 0.72.

Evidence that would change the decision:

- an official provider API does not support non-generating historical replay;
- historical item replay changes model-visible semantics materially relative to
  the original conversation;
- tool-role history cannot be replayed without inventing tool-call identities;
- a smaller, lossless bounded representation exists that preserves every
  benchmark-relevant semantic and does not depend on evaluator/oracle state.

## Progressive next test

Before another paid run:

1. Add a provider-neutral history-replay contract with exact role/order/content
   hashes and a hard byte/turn budget.
2. Add fake-provider wire tests for 48-turn and 100-plus-turn histories,
   including a 9,187-byte tool result.
3. Prove replay is sent only after session acknowledgement and before any new
   caller audio or response request.
4. Prove Native/HACC conversation replay hashes are identical and HACC's extra
   state cannot alter the replay.
5. Replay the exact retained failed history entirely offline.
6. Run one no-generation or minimal-generation provider qualification per
   provider only if official API contracts and offline tests are green.
7. Only then authorize the six-cell run.

## Review request

Please disagree where warranted. Rank findings P0/P1/P2, distinguish documented
API facts from inference, and propose the smallest progressive evidence that
should gate another paid run.
