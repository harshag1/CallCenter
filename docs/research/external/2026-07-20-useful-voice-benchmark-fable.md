---
provider: anthropic-claude-code
model: fable
timestamp: "2026-07-20T23:44:01.255455+00:00"
question: "Design the smallest scientifically useful production-API benchmark that can determine whether Harsha's Amazing Call Center improves real voice-agent usefulness over the same raw realtime models. Be adversarial: identify circular or treatment-contaminated labels, invalid comparators, missing-data mistakes, simulator leakage, provider-transport confounds, and ways a favorable result could be self-serving. Recommend a progressive test ladder under a $1,000 total budget, with exact stop/go gates, minimum task mix, primary and secondary endpoints, and what evidence is sufficient for a public claim. Also state whether the current deterministic caller/world scheduler should be integrated, whether an LLM user simulator is appropriate, and how to keep development from contaminating held-out confirmation."
context_files: ["docs/research/external/2026-07-20-useful-voice-benchmark-context.md"]
total_cost_usd: 0.553555
usage: {"cache_creation": {"ephemeral_1h_input_tokens": 6284, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 6284, "cache_read_input_tokens": 0, "inference_geo": "not_available", "input_tokens": 2, "iterations": [{"cache_creation": {"ephemeral_1h_input_tokens": 6284, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 6284, "cache_read_input_tokens": 0, "input_tokens": 2, "output_tokens": 8510, "type": "message"}], "output_tokens": 8510, "server_tool_use": {"web_fetch_requests": 0, "web_search_requests": 0}, "service_tier": "standard", "speed": "standard"}
advisory_only: true
unverified_peer_review: true
must_verify_claims: true
---

> This is unverified peer-review input, not release or production evidence.

## Verdict

The proposed replacement design is directionally sound — paired arms, ITT denominators, world-side verification, and a gated ladder are the right skeleton — but it is not yet safe to spend beyond the $25 canary tier. Three things must happen first: (1) integrate the deterministic caller/world scheduler into the provider orchestrator (yes, integrate it; the open-loop runner was the proximate cause of the last failure), (2) specify and freeze a defensibly strong baseline arm, and (3) hash-commit the held-out task instances and analysis code before any development pilot opens a session. An LLM user simulator should not be the primary caller; it is acceptable only as a separately labeled robustness arm.

## Assumptions

I am treating the following as true only because the packet states them, without independent evidence: the ToolWorld genuinely adjudicates terminal states independently of harness telemetry; the scheduler is condition-blind as described; per-episode realtime cost is in roughly the $1–$4 range (my estimate — not in the packet); provider model versions cannot be pinned beyond what each API acknowledges. I assume "raw-memory arm" means the same model with the same leaf tools and full business context up front, but the packet never defines it — see Findings.

## Findings

- **P0 — Open-loop orchestrator.** The packet states "the current provider orchestrator does not use the scheduler; it remains open-loop." The prior run's failure (fixed 32-turn prerecorded sequence, 433/1,024 completions, all strict arms zero) is exactly this defect. Any paid run before integration re-buys the same null. This is the single gating engineering task.

- **P0 — Denominator ambiguity enables differential attrition.** The headline is "intention-to-treat task completion across all opened sessions." The prior run opened 32 sessions against a much larger plan. If the harness arm (extra proxy/gating machinery) affects whether a session *opens*, pre-open failures silently exit the denominator asymmetrically. The denominator must be *scheduled episodes*, with opened-session completion reported separately as a transport metric.

- **P0 — Label circularity risk in the raw arm.** The packet correctly bans the grant catalog from defining legality, but the same discipline must apply to *all* integrity metrics: "duplicate effect," "unsafe action," and "false receipt accepted" must be adjudicated by the world oracle from world logs, identically for both arms. If any system-integrity metric is only observable via harness telemetry, the raw arm gets scored on a different instrument and the comparison is invalid.

- **P1 — Baseline arm unspecified.** Nothing in the packet defines the raw arm's prompt, tool schemas, or context delivery. A harness author comparing against their own hand-built baseline is the main self-serving vector. The honest claim requires a *best reasonable simple baseline*: all leaf tools exposed, full business knowledge in the system prompt, same limits, with a small preregistered tuning budget spent on the baseline (not the harness) during development.

- **P1 — Legacy turn-indexed curves.** The packet says the report "still consumes legacy turn-indexed curves rather than the semantic-opportunity curves." The harness changes turn structure by design, so turn-indexed comparisons are confounded. Confirmation must consume only semantic-opportunity curves.

- **P1 — Provider identity is partially unverifiable.** Gemini fields are "request-only/unverifiable"; xAI fields "not echoed." A mid-experiment silent model update is indistinguishable from a treatment effect. Record acknowledged config per session, pair arms tightly in time (minutes, not hours, within a block, with AB/BA counterbalancing), and scope any claim for those providers as "model as served on these dates."

- **P1 — Power under the budget.** At ~$2–4 per pair, $600 buys roughly 150–300 pairs total, i.e., 50–100 per provider. McNemar on discordant pairs at that size detects only ~15–20pp per-provider differences. If the true effect is 8pp, the held-out run will produce an uninterpretable null that could be spun either way. The minimum detectable effect must be preregistered, and a below-MDE pilot signal must be a *stop*, not a reason to pool harder.

- **P1 — Caller "determinism" hides a judgment component.** The scheduler "chooses frozen prerecorded utterances from listener-observable state" — but computing listener-observable state from agent *audio* requires ASR/classification, which is a judged step. If that classifier was developed against harness-arm transcripts, or mis-hears the harness arm's phrasing patterns differently, caller difficulty diverges by arm. The classifier must be frozen, condition-blind, logged per decision, and human-audited on a sample from both arms.

- **P2 — Pooling weights are a gaming vector.** "Frozen provider weights" is fine only if frozen *before* the pilot (equal weights or planned-allocation weights). Weights chosen after seeing per-provider effects can manufacture a pooled win.

- **P2 — Voice-experience blinding is imperfect.** A judge hearing "let me confirm your grant covers this" can infer condition. Treat voice experience as exploratory, not confirmatory.

- **P2 — "Wins by blocking" guardrail needs a number.** The packet names the risk but not the metric. Preregister attempted-semantic-action rate per opportunity; flag any harness completion advantage accompanied by a large (>preregistered threshold, e.g., 30% relative) drop in attempts.

## Options

1. **Adaptive deterministic caller as primary (proposed).** Reproducible, condition-blind, auditable; failure mode is brittleness (unmatched agent utterance → dead branch) and the hidden classifier issue above. Best for a defensible claim.
2. **LLM user simulator as primary.** More naturalistic coverage, but non-deterministic, leak-prone (the simulator can key off harness-style disclosures or sycophantically cooperate), and adds a same-vendor contamination risk if the simulator shares a vendor with the agent under test. Not acceptable for the primary endpoint; acceptable as a labeled secondary arm with a frozen prompt, a vendor different from the agent, and its own audit sample.
3. **Open-loop prerecorded audio.** Already failed; keep only as the labeled stress test the packet proposes.
4. **Human callers.** Highest validity, but blows the budget at any useful n; defensible only as a ~10-episode qualitative audit if reserve permits.

## Recommended path

Integrate the scheduler into the orchestrator; define and freeze the baseline arm spec; generate held-out task instances now and publish a SHA-256 commitment (encrypted tarball hash in a timestamped public commit); freeze the analysis script. Then run the ladder in Progressive next tests with these preregistered elements:

- **Unit:** one scheduled episode (not opened session).
- **Primary endpoint:** world-oracle-verified task completion, ITT over scheduled episodes, paired difference per provider (exact McNemar), MDE 15pp.
- **Secondary endpoints:** unsafe/duplicate-effect rate (world-side), false-receipt acceptance, model integrity, transport/session completion, semantic-opportunity integrity curves, latency, cost per completed task; voice experience exploratory only.
- **Guardrail:** attempted-action rate must not collapse in the winning arm.
- **Task mix (minimum):** 3 task families × 3 complexity bands, each instance containing the packet's required elements (recoverable fault, duplicate/timeout-after-commit opportunity, false-receipt trap), with ordinary-success and recovery paths both represented; ≥2 instances per family×band in the pilot, held-out allocation fixed by the power check.
- **Missing-data rule:** an episode that never opens, errors, or hits limits is a non-completion in ITT; reruns permitted only for a preregistered infrastructure-failure taxonomy, applied identically to both arms, funded from the $200 reserve, with originals reported alongside.
- **Public claim bar:** preregistered protocol hash predating the pilot; per-provider paired CI excluding zero on the primary endpoint for at least two of three providers (or the preregistered pooled test); transport completion above gate in *both* arms; no guardrail flag; full raw artifacts (audio, transcripts, world logs, scorer outputs) published; claim scoped to these task families, these providers as served on these dates, versus the published baseline spec.

## Strongest objection

Even executed perfectly, this is an author-built world, author-built tasks, and an author-built scorer evaluating the author's harness. The tasks are structurally shaped around the harness's strengths — receipts, exactly-once, revision-bound grants are the *task ingredients* (false-receipt traps, duplicate opportunities). A skeptic will say the benchmark measures "does a harness built for X do X in a world that tests X." The mitigations — strong baseline, world-side-only adjudication, published artifacts, third-party spot audit — reduce but do not eliminate this. The claim must be worded as effectiveness *on stateful, policy-constrained task families of this shape*, and the strongest available answer is releasing the world and tasks so others can run competing harnesses against the same oracle.

## Missing proof

- The raw-arm configuration (prompt, tool exposure, context delivery) — currently nonexistent in the packet.
- Evidence the world oracle can score a raw-arm episode with zero harness telemetry (an actual scored raw-arm episode log would prove it).
- The listener-state classifier's specification, freeze status, and error rate on harness-arm audio.
- Per-episode cost per provider (needed for the power check; currently my guess).
- Whether any provider pins model versions, and what each acknowledges per session.
- The held-out commitment artifact (hash + timestamp) — asserted as a plan, does not exist yet.

## Progressive next tests

1. **$0, local:** wire the scheduler into the orchestrator; run closed-loop episodes against a scripted mock provider. Gate: caller adapts correctly across all three complexity bands with zero runner exceptions in ~50 episodes.
2. **$0, local:** score a scripted raw-arm episode and a scripted harness-arm episode through the world oracle; diff the scoring inputs. Gate: no harness-only artifact appears in either scoring path.
3. **$0:** publish the held-out commitment hash and freeze baseline spec + analysis script in a tagged commit.
4. **≤$25 canaries:** ~6–10 short paired sessions per provider on a trivial echo task. Gate per provider: ≥90% sessions reach a terminal state, function-call sequencing behaves, config acknowledgment logged. A failing provider is dropped from confirmation, not retried into passing.
5. **≤$175 pilot:** ~60–100 paired episodes across surviving providers, development seeds only. Gates: ≥85% of scheduled episodes reach a terminal state in both arms; runner exception rate <2%; classifier audit agreement ≥95% on a sampled set; power check shows the $600 tier reaches the 15pp MDE per provider or a preregistered pooled fallback. Any gate failure stops spend and publishes an infrastructure result.
6. **≤$600 held-out confirmation:** frozen seeds, tagged code, counterbalanced pairs within tight time blocks, no selective retries, analysis run once by the frozen script. Any post-freeze code change invalidates the run; restart requires fresh committed seeds funded from reserve.

## Questions for Harsha

1. What exactly is the raw-memory arm's configuration, and are you willing to spend part of the development budget strengthening it rather than the harness?
2. How is listener-observable state computed from agent audio (which ASR/classifier, frozen when, developed against which transcripts)?
3. What are measured per-episode costs per provider from the prior run, so the power check uses real numbers?
4. Are pre-open session failures currently counted in any denominator, and can the runner log a scheduled-episode record before dialing?
5. Is a third-party audit of a held-out sample (even ~20 episodes) feasible before publication?
6. Do any of the three providers offer pinned model snapshots, and if not, are you comfortable scoping claims to "as served on these dates"?

## Confidence

High confidence in the methodological critique (open-loop runner, denominator, circularity, baseline-spec gap) — these follow directly from packet evidence. Moderate confidence in the budget arithmetic and sample-size figures, which depend on per-episode costs I estimated rather than measured. Moderate confidence that 15pp is the right MDE; it is a judgment call balancing the budget against a claim worth publishing, and Harsha's cost data could justify revising it.
