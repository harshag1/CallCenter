---
provider: anthropic-claude-code
model: fable
timestamp: "2026-07-21T17:34:51.927384+00:00"
question: "What architecture and first vertical slice would turn this repository from a careful benchmark/flow wrapper into a genuinely differentiated, provider-neutral runtime for voice agents that must survive hour-scale, complex conversations without goal drift, enforce realtime guardrails, and spawn durable asynchronous workers from a live call? Challenge the proposed design, identify hidden failure modes, and recommend the smallest implementation that can produce credible numerical evidence rather than a demo."
context_files: ["/private/tmp/hacc-durable-voice-runtime-context.md"]
total_cost_usd: 0.49506400000000006
usage: {"cache_creation": {"ephemeral_1h_input_tokens": 7103, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 7103, "cache_read_input_tokens": 0, "inference_geo": "not_available", "input_tokens": 2, "iterations": [{"cache_creation": {"ephemeral_1h_input_tokens": 7103, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 7103, "cache_read_input_tokens": 0, "input_tokens": 2, "output_tokens": 7000, "type": "message"}], "output_tokens": 7000, "server_tool_use": {"web_fetch_requests": 0, "web_search_requests": 0}, "service_tier": "standard", "speed": "standard"}
advisory_only: true
unverified_peer_review: true
must_verify_claims: true
---

> This is unverified peer-review input, not release or production evidence.

## Verdict

The four-head kernel is the right conceptual model and Option C is the right entry point, but as specified it re-creates the split-brain risk the packet itself flags: the policy head decides actions while Flow v2 executes and leases them, with no stated ordering or consistency mechanism between them. The fix is structural, not procedural — make the heads pure folds over a single append-only hash-chained event log (which `mission-runtime.ts` reportedly already has), and have Flow v2 checkpoints written into that same log via an adapter. Also, the proposed first slice is really three slices; the pure-kernel-first sequencing is correct but the migration and MCP wiring should be gated behind projector-recall evidence, not just invariant fuzzing. The 10,000-schedule synthetic test proves containment, not capability; the credible numerical claim needs a paired text-transport A/B before any paid voice run.

## Assumptions

I am treating the following as claimed but unverified, since no file contents, import graphs, or test output are in the packet:

- `mission-runtime.ts` is genuinely pure and hash-chained, and is never imported by production code.
- The 1,745-pass suite result and clean tree correspond to HEAD `d2bd2fc`.
- The description of `web/lib/tasks.ts` deficiencies (non-exclusive claim, 400-event dump, no lease/heartbeat) is accurate.
- Provider behavior (Gemini sliding-window compression, xAI resume replaying model history) matches current API versions as of July 2026.
- The existing canary result is a true null (ties at n=18 episodes), not a measurement artifact.

## Findings

**P0 — Dual authority for actions under Option C as stated.** The proposal says "the conversation kernel owns memory/policy/workers while Flow v2 remains the action/checkpoint authority." But every action decision consumes memory and policy state, and every action outcome mutates what the memory and worker heads must see. Two independently-persisted state machines with a shared decision path and no specified commit ordering is the textbook setup for the split-brain the packet lists under known risks. A "strict rule" about head ownership is a convention, not a mechanism; nothing prevents a Flow checkpoint and a kernel event from disagreeing about whether an action settled.

**P1 — "Exactly-once delivery into a later context packet" is not achievable as stated.** Between a worker completing and its result appearing in a packet, you have a network, a database, and a possibly-disconnected provider session. What is achievable is at-least-once delivery plus idempotent application keyed by result hash and delivery revision — which the migration sketch actually contains. Related and more dangerous: delivery must be policy-checked *at delivery time*, not creation time. A worker launched under goal G whose result arrives after the user corrected to goal G′ is exactly the stale-completion hazard in the risk list, and nothing in the slice binds delivery to a current-head policy decision.

**P1 — Reconnect semantics conflict with provider session resumption.** The design says reconnect starts from the four durable heads. But xAI resume "primarily replays model history" and Gemini offers native session resumption. If you resume a provider session *and* inject a compiled packet, the model sees two histories that can contradict each other (e.g., the replayed history contains a fact the memory head has since corrected). The core abstraction needs an explicit rule: on reconnect, either fresh session + packet, or provider resume with the packet treated as delta-only — never both naively.

**P1 — The projector's recall is the new single point of failure, and it is untested by the proposed adversarial suite.** Once raw transcript is cold storage, any fact the deterministic projector fails to select is invisible to the model forever. The 10,000-schedule fuzz as described tests invariant preservation (no corruption, no duplicate settlement), not selection quality. A runtime that never corrupts state but drops the one fact that mattered still drifts. Separately, the acknowledged summary-corruption risk needs a provenance mechanism, not vigilance: authoritative typed facts should only be writable from tool receipts or explicit authority-stamped confirmations; model-generated summaries stay in an advisory tier and are pinned by hash but never promoted silently.

**P1 — Policy decisions bound to head digests have a TOCTOU window.** A decision issued against digest H is stale the moment any head advances (e.g., a worker result lands mid-action). The design mentions expiry but not invalidation-on-advance. Flow v2's step-scoped leases apparently already solve this shape of problem; the policy artifact should reuse that binding rather than invent a parallel expiry scheme.

**P2 — Confirmation authority flows through ASR.** "Provider text never grants authority" is right, but confirmations arrive as transcribed speech. A misrecognized "yes" against the wrong pending proposal grants authority incorrectly. Confirmations should bind to a specific proposal digest, and high-consequence ones should require readback of a distinguishing detail.

**P2 — The first slice is three slices.** Pure kernel + property tests, migration 032 + worker tools, and packet compilation + `activeFlowContext` integration are separable deliverables with different risk profiles. Landing them as one unit means the first falsifiable feedback arrives late.

**P2 — The spoken-output gap is acknowledged but unscoped.** The policy firewall guards tool calls; PII disclosure happens in audio. Explicitly declare it out of scope for slice 1 rather than leaving it implied, or the eventual "guardrails" claim overstates coverage.

## Options

**A. Flow v2 expansion only.** Lowest integration risk, but the packet is right that it structurally couples memory/workers to flow steps, and open-ended conversation is precisely the case where flows are absent. Failure mode: two years from now, every non-flow feature is a flow with one step.

**B. Promote mission-runtime to production authority.** Cleanest end state, but a big-bang migration against a production-proven flow runtime with 1,745 passing tests protecting current behavior. Failure mode: a long-lived migration branch that never lands, or a regression in proven checkpoint/replay behavior with no incremental rollback point.

**C. Kernel beside Flow v2 (as proposed).** Fastest slice, but dual persistence creates the P0 above. Failure mode: silent divergence between Flow checkpoints and kernel heads discovered only in an incident.

**C′. Event-log-first kernel (recommended amendment).** One durable append-only log is the sole write authority; mission, memory, policy, and worker heads are deterministic folds; Flow v2 checkpoints are recorded as events through a thin adapter so the kernel can always reconstruct a consistent view. Failure mode: the adapter is the risk concentrate — if Flow writes bypass it, you are back to C. But that is a mechanically checkable property (one write path), unlike C's convention.

## Recommended path

1. Adopt **C′**: build the pure kernel as folds over a single event log, with Flow v2 events ingested via adapter. Head "ownership" becomes projection responsibility, not storage ownership, which dissolves the P0 by construction.
2. Sequence the slice as three gates: (a) pure kernel + projector with property, fuzz, *and recall* tests; (b) text-transport paired A/B producing the first real number; (c) only then migration 032 + gateway tools + `activeFlowContext` delivery, with delivery-time policy re-check and at-least-once/idempotent semantics named honestly.
3. Fix the worker spec: replace "exactly-once delivery" with "at-least-once delivery, exactly-once application," and add a policy re-evaluation against current head digests at delivery time with a defined defer path when the goal has changed.
4. Define the reconnect contract now (fresh-session-plus-packet as default; provider resume as an optimization behind a per-provider capability flag) so it cannot leak provider-specific semantics into the core.

## Strongest objection

The most defensible counter-position: Flow v2 already has checkpoints, leases, replay handling, and bounded context — perhaps the kernel is unnecessary abstraction, and the honest smallest change is Option A plus a memory table. This objection deserves a concrete answer, not dismissal: the falsifying question is whether Flow v2 can represent an *open-ended* conversation with corrections and suspended goals without contorting everything into flow steps. If someone can sketch that in Flow v2 primitives in under a day, Option A wins and the kernel is premature. The packet asserts Flow context "only projects current step plus 4 KB of durable outputs" — that assertion, if verified in code, is the load-bearing justification for the kernel and should be checked before writing kernel code.

## Missing proof

- The actual import graph showing `mission-runtime.ts` is production-unreachable (a `grep`/dependency-cruiser output would settle it).
- Flow v2's context projection limits, verified in `flow-runtime.ts` source, not the packet's summary.
- Any measurement that the deterministic projector concept beats naive recent-window truncation — currently zero evidence; the entire differentiation claim rests on it.
- The concurrency behavior of the current `tasks.ts` claim path (is the non-exclusive claim a live bug or theoretical?).
- Current provider resume semantics confirmed against live API docs, since the reconnect contract depends on them.
- A pre-registered metric definition for "goal drift" — without one, the eventual benchmark number is unfalsifiable.

## Progressive next tests

Ordered from fastest falsification to first shared-state action:

1. **Read-only verification (minutes):** confirm mission-runtime's production unreachability and Flow v2's actual projection bounds in source. This validates or kills the premise before any new code.
2. **Kernel fold property tests (local, seconds per run):** determinism, hash-chain integrity, replay convergence, idempotent event application.
3. **Projector recall tests (local):** inject needle facts/corrections at turn k across 500–2,000-turn schedules; assert presence in the bounded packet at turn N under a fixed byte budget. This is the test the current plan is missing.
4. **Adversarial schedule fuzz:** start with ~1,000 schedules for iteration speed; promote the full 10,000 to CI once the failure rate is zero on the smaller set.
5. **Worker fault injection (local, in-memory store):** kill mid-lease, deliver after cancel, duplicate delivery, deliver after goal change — assert exactly-once application and delivery-time policy defer.
6. **Text-transport paired A/B (cheap API spend):** same model, kernel packet vs. provider-native sliding history, deterministic typed-code oracle (reusing the existing scoring approach from commit `7acba09`'s description), pre-registered drift metric, paired per-scenario. To answer the "gameable by hiding information" objection, include scenarios where full history is genuinely advantageous, so the projection pays a measurable cost when it over-prunes.
7. **Shadow-DB migration 032 + lease exclusivity concurrency test** — the first shared-state action, taken only after 1–6 pass.
8. **Small paired paid voice canary**, only after the transport/oracle gate, and only sized to detect the effect the text A/B measured.

## Questions for Harsha

1. Can Flow v2 checkpoint writes be routed through (or mirrored into) a single event log without touching proven replay behavior — i.e., is the C′ adapter cheap or invasive?
2. What is the byte/token budget for the compiled context packet, and is it per-provider? The projector's recall tests need that number fixed first.
3. What is the provenance rule for authoritative facts — tool receipts and stamped confirmations only, or can any pipeline stage write them?
4. On reconnect, are you willing to forgo provider-native resume entirely in v1 to avoid the dual-history conflict?
5. What effect size on the drift metric would you consider worth the paid voice canary, given the current 18-episode null?

## Confidence

**Moderate-high** on the architectural direction (event-log-first, heads as projections, at-least-once + idempotent application) — these follow from well-established distributed-systems constraints regardless of unseen code details. **Moderate** on the Option A objection and the Flow v2 projection-limit premise, since I have not seen the source. **Low** on any effort or timeline judgment, and on whether the projector will actually beat naive truncation — that is precisely the number the text-transport A/B exists to produce.
