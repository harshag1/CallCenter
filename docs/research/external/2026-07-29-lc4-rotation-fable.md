---
provider: anthropic-claude-code
model: fable
timestamp: "2026-07-29T07:26:35.427775+00:00"
question: "# LC4 long-call rotation architecture question\n\nWhat is the strongest provider-neutral way to restore a lossless, chronological\nvoice-agent conversation after a planned realtime-session rotation without\nplacing the entire history in session instructions, while preserving a fair\nNative-versus-HACC benchmark comparison across OpenAI Realtime, Gemini Live,\nand xAI Voice?\n\nPlease challenge the current leaning toward provider-native history-item replay.\nIdentify any semantic mismatch, benchmark confound, API portability problem,\nor smaller progressive test that should block another paid six-cell run."
context_files: ["2026-07-29-lc4-rotation-context.md"]
total_cost_usd: 0.57204
usage: {"cache_creation": {"ephemeral_1h_input_tokens": 7059, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 7059, "cache_read_input_tokens": 0, "inference_geo": "not_available", "input_tokens": 2, "iterations": [{"cache_creation": {"ephemeral_1h_input_tokens": 7059, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 7059, "cache_read_input_tokens": 0, "input_tokens": 2, "output_tokens": 8556, "type": "message"}], "output_tokens": 8556, "server_tool_use": {"web_fetch_requests": 0, "web_search_requests": 0}, "service_tier": "standard", "speed": "standard"}
advisory_only: true
unverified_peer_review: true
must_verify_claims: true
---

> This is unverified peer-review input, not release or production evidence.

## Verdict

Option C is the right direction, and I agree Options A and B are correctly rejected. But C is not yet safe to gate a paid six-cell run on: its central premise — that all three providers support non-generating, role-faithful historical item injection — is a documented fact only for OpenAI Realtime, partially inferable for Gemini Live, and unverified for xAI. Two semantic issues (audio-to-text modality substitution and the receipt requirement being unsatisfiable on at least one provider) need to be resolved and preregistered before the next paid call, not discovered during it.

## Assumptions

- The retained failure proof is accurate: the run died on the **local** validator (`validateConversationTurns` 4,000-char per-turn ceiling), not on any provider rejection. The packet says this explicitly and I treat it as true.
- The host's hash-bound packet retains original tool-call identifiers from segment 1's wire evidence (implied by "normalized wire evidence" and the call-chronology commits, but not stated outright — listed under Missing proof).
- "Lossless" means lossless relative to the host's retained text record, not relative to the original audio. If Harsha means lossless relative to audio, no text-replay option (A or C) satisfies it.
- Fairness bar is within-pair (Native vs HACC on the same provider), not cross-provider mechanism identity. The packet's constraints read this way; if the bar is cross-provider, C is likely unachievable and the question changes.

## Findings

- **P1 — Provider support for C is asymmetrically evidenced.** OpenAI Realtime documents `conversation.item.create` for message, `function_call`, and `function_call_output` items, and items do not generate until `response.create` (or VAD-triggered response). That is a documented API fact. Gemini Live accepts injected turns via client content with a turn-complete flag, but whether tool history can be replayed as function-call/function-response parts inside those turns — rather than only via the live tool-response channel — is an inference from the non-live Gemini API, not a documented Live API fact I can assert. xAI's realtime surface is described in the packet only as "OpenAI-compatible" at the client level; whether its wire accepts client-created historical items non-generatively is unverified. C's portability claim currently rests on one documented case out of three.

- **P1 — The "deterministic replay receipt / provider must admit the history" requirement may be unsatisfiable on Gemini Live.** OpenAI emits a per-item created event, so a receipt is achievable there. Gemini Live's client-content channel is, to my knowledge, fire-and-forget over the websocket with no per-item acknowledgement. If the contract hard-requires provider admission, C fails on Gemini for reasons unrelated to conversation semantics. The contract needs a preregistered fallback standard (e.g., exact outbound wire evidence plus a post-replay probe) before it is implementable, and that weakening should be decided now, not mid-run.

- **P1 — Modality substitution is a real semantic delta and the canonical-text question is unresolved.** Segment 1's model heard caller audio and produced audio; segment 2's model will see text. Caller-turn text is an ASR transcript, which is itself lossy relative to the audio. This applies equally to both arms within a pair, so within-pair fairness survives, but two things must be preregistered: (a) which text is canonical for caller turns (the provider's own transcript vs. any host-side record), and (b) that the benchmark's "lossless" claim is scoped to the retained text record. Note this confound exists under Option A too — it is not a reason to prefer A — but it must be documented before the frozen comparison runs.

- **P1 — The failure mode that killed the last paid run (local validation mid-run) is reproducible under C unless budgets are proven against worst-case projected history offline.** Segment 2 replays ~20 opportunities of history; segment 3 replays ~40, roughly double the 24 KB that already exists. C moves history out of instructions but does not bound growth. Any new per-item or total budget must be validated offline against the projected segment-3 worst case (including a ≥9,187-byte tool item) so a paid run cannot die on a self-imposed ceiling again. The packet's planned 100-plus-turn fake-provider test covers this if it is sized to the segment-3 projection, not an arbitrary number.

- **P2 — Per-provider content-type and role mapping will differ even where C works.** OpenAI assistant items use different content types than user items; Gemini has only user/model roles with tool material as parts; xAI is unknown. A provider-neutral contract will need a preregistered per-provider rendering table, and the benchmark write-up must state that replay mechanics are provider-specific while role/order/content hashes are provider-neutral.

- **P2 — Replay-window audio gating.** "Replay after session ack, before any caller audio" must be enforced client-side; with server VAD enabled, any buffered or leaked audio during the replay window breaks ordering. On Gemini, absent per-item acks, ordering rests entirely on single-socket send order. This is testable offline with the fake provider.

- **P2 — Boundary-opportunity timing confound.** Replay adds latency and context-token load at exactly opportunities 21 and 41 in both arms. It cancels within-pair but will show up in any per-opportunity latency descriptives; worth annotating in the protocol so it isn't misread as a HACC or provider effect.

## Options

- **A (raise limits):** Correctly rejected. The principled objections (unbounded growth, instruction/history conflation) stand on their own — but be precise that the retained failure proves a local guard fired, not that any provider limit exists. A would also inherit every semantic issue above (modality, canonical text) while adding the instruction-conflation problem.
- **B (lossy compaction):** Correctly rejected for this frozen protocol; it changes the comparator.
- **C (native item replay):** Best semantic boundary; failure modes are the three P1s above — unverified Gemini/xAI support, unattainable receipts on Gemini, and per-provider mapping drift.
- **D (resumption handles):** Gemini Live documents session resumption; OpenAI Realtime does not offer an equivalent to my knowledge. Not neutral, and resumed sessions carry provider-internal state that is not hash-auditable. Agree: future fast path only, never the reference behavior.
- **C′ (single injected history item, not in instructions):** Worth naming to reject explicitly — one user-role item containing the rendered transcript avoids the instruction conflation but collapses roles, violating the role-losslessness constraint. Mention it in the protocol as considered-and-rejected so reviewers don't propose it later.

## Recommended path

Adopt C as the portable reference behavior, but block the six-cell run on three gates in order: (1) written confirmation from official API documentation that Gemini Live and xAI accept non-generating historical items including tool material — if either does not, C needs a preregistered per-provider degradation and the decision reopens; (2) the offline fake-provider suite passing at worst-case projected segment-3 size with the exact retained 48-turn history; (3) one minimal paid qualification call per provider (a few injected items, a verbatim-recall probe, no benchmark opportunities) before authorizing the full run. Preregister the canonical-text rule and the receipt fallback standard before gate 3.

## Strongest objection

The strongest case against proceeding with C now: you are designing a provider-neutral contract around a mechanism whose neutrality is confirmed for exactly one of three providers, and the contract's own admission requirement already appears unsatisfiable on a second. If Gemini or xAI cannot replay tool-role history faithfully, you will end up with three provider-specific replay semantics under a "neutral" label — at which point the honest framing is per-provider adapters with a shared hash contract, and the benchmark write-up must say so. That is survivable, but discovering it after another paid run is not.

## Missing proof

- Official Gemini Live documentation showing (a) injected client-content turns do not trigger generation and (b) function-call/function-response parts are accepted inside injected turns.
- Any official xAI realtime documentation of client-created historical items and their generation semantics.
- Confirmation that the retained integrity packet preserves original tool-call identifiers, so tool replay reuses rather than invents identities.
- A stated canonical-text rule for caller turns (provider ASR transcript vs. other record).
- A projected byte/turn budget for segment 3 and evidence the new validators accept it offline.
- The receipt standard C will use on providers with no per-item acknowledgement.

## Progressive next tests

1. **Documentation audit (free, minutes):** For each provider, cite the exact official API section covering non-generating item injection and tool-history representation. This alone can falsify C's neutrality premise.
2. **Offline replay of the retained failure (free):** Run the exact 48-turn segment-1 history through the new contract and per-provider renderers against fake providers; assert role/order/content hash parity, Native/HACC hash equality, and that HACC's extra state commitments cannot perturb the replay bytes.
3. **Worst-case sizing test (free):** Same suite at projected segment-3 scale (~100+ turns, ≥9,187-byte tool item) against the new budgets, so no local validator can kill a paid run again.
4. **Ordering/gating test (free):** Fake-provider proof that replay occurs strictly after session acknowledgement and that no audio can enter the socket during the replay window.
5. **Per-provider qualification call (first paid step, minimal):** One short session per provider: inject two or three items including one tool exchange, confirm zero generations during injection from wire evidence, then one probe response asking the model to quote an injected caller turn verbatim. This is the cheapest live falsification of both non-generation and history visibility.
6. **Single-rotation rehearsal (small paid):** Replay the full retained segment-1 history into one fresh session per provider with one probe referencing an early caller correction and the large tool receipt.
7. Only after 1–6 are green, authorize the six-cell run.

## Questions for Harsha

- Is the fairness bar within-pair only, or must the replay mechanism itself be identical across providers? The answer determines whether per-provider adapters are acceptable under C.
- Does the retained wire evidence include original tool-call identifiers for reuse in replay?
- Which text is canonical for caller turns, and is that decision preregistered in the protocol?
- If Gemini (or xAI) offers no per-item acknowledgement, does outbound wire evidence plus a post-replay probe satisfy the "provider must admit the history" constraint, or does that constraint get formally amended?
- What is the intended byte/turn budget for the segment-3 replay, and is it derived from any documented provider limit or purely a host policy?

## Confidence

0.8 that C is the correct architectural direction over A, B, and D. 0.5 that all three providers support it without materially different per-provider semantics — that number is what the documentation audit and the two cheap qualification steps exist to move, and it is why the six-cell run should stay blocked until they complete.
