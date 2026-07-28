# Research progress log

<!-- markdownlint-disable MD013 MD060 -->

This file is append-only after the protocol freeze. Entries use Pacific Time and distinguish implementation evidence from scientific evidence. Provider spend is recorded in [BUDGET.md](BUDGET.md); historical `paid spend` labels below mean voice-provider spend, not the separately tracked auxiliary review.

## 2026-07-10 — Program opened

Objective: produce reproducible, multi-provider evidence about long-horizon voice-agent reliability, then improve the framework in response to observed failures.

Completed:

- Established a $1,000 absolute authorization, $900 scheduling stop, $100 protected reserve, and $15 initial canary ceiling.
- Validated local availability of credentials for the three planned provider families without printing or copying secrets into tracked files.
- Validated local audio tooling for generating and inspecting PCM fixtures.
- Declared true-audio, paired raw/harness trials with deterministic world-state and receipt evidence.
- Opened the causal-ablation plan separating progressive disclosure from runtime enforcement.

- Spend delta: **$0.00**
- Cumulative paid spend: **$0.00**

## 2026-07-10 — Provider, protocol, and pricing audit completed

Historical source state at audit: an in-progress pre-release branch with research documents being edited in a dirty worktree alongside framework changes. This was development provenance, not a clean release attestation.

Completed:

- Pinned primary research targets to OpenAI `gpt-realtime-2.1`, xAI `grok-voice-think-fast-1.0`, and Gemini `gemini-3.1-flash-live-preview`, subject to freeze-time reverification.
- Documented provider tool mutability, audio formats, transcript semantics, session limits, resumption differences, usage records, and July 2026 pricing in [PROVIDERS.md](PROVIDERS.md).
- Chose manual turn boundaries for the primary semantic comparison and one stable capability-gateway tool for provider parity.
- Separated estimated, provider-reported, and invoice-reconciled cost.
- Added a $900 automatic scheduling ceiling so metering lag and in-flight work cannot consume the $100 hard-ceiling reserve by design.

Evidence: first-party provider links are embedded in [PROVIDERS.md](PROVIDERS.md). No provider session was opened.

- Spend delta: **$0.00**
- Cumulative paid spend: **$0.00**

## 2026-07-10 — Database concurrency proof completed

Applied migrations `001` through `008` to a fresh local Postgres 16/pgvector database. Migration `008_flow_integrity.sql` completed without error.

The opt-in integration test in `flow-state-store.integration.test.ts` then opened 50 concurrent identical reservations against the real database:

- exactly one caller received execution ownership;
- all 50 calls converged on one persisted receipt;
- the winning receipt settled successfully; and
- 25 further concurrent retries all replayed that same successful receipt without receiving dispatch ownership.

Evidence: commits `b6835ef` and `7a414e7`; local command `FLOW_INTEGRATION_DATABASE_URL=... npm run test -- --run lib/__tests__/flow-state-store.integration.test.ts`. The database URL is intentionally not recorded in tracked artifacts.

This verifies database admission/replay concurrency. It does not claim exactly-once completion for an arbitrary downstream API after a network timeout; opaque outcomes remain indeterminate until reconciled.

- Spend delta: **$0.00**
- Cumulative paid spend: **$0.00**

## 2026-07-10 — Causal protocol and claim boundaries drafted

Completed:

- Defined six conditions: `raw-full`, `raw-memory`, `progressive-only`, `state-only`, `full-harness`, and diagnostic `oracle-route`.
- Defined one strict primary endpoint requiring correct final world state, ordered checkpoints, authoritative receipts, exactly-once irreversible effects, valid execution-time preconditions, no critical breach, no false success, and completion within limits.
- Added separate model-behavior and system-containment outcomes. A blocked illegal call is now explicitly a containment result, not evidence of improved model alignment.
- Defined Conversation Integrity Curves and Reliable Horizon at `q = 0.90` and `q = 0.95` over checkpoint/opportunity index.
- Defined Audible State Divergence, Unheard-Content Leakage Rate, and Audible Commit Recovery from generated-versus-played history.
- Added paired analysis, scenario-clustered uncertainty, no significance-based stopping, held-out confirmatory templates, and a preregistration block.
- Added AudioAgentBench and τ³/τ-Voice compatibility tracks so the project extends strong existing evaluation infrastructure rather than claiming a new general voice benchmark.

Protocol status remains **draft**. Sample size, safety non-inferiority margin, held-out split, freeze commit, and randomization seed are still unfrozen; confirmatory mode is therefore ineligible.

- Spend delta: **$0.00**
- Cumulative paid spend: **$0.00**

## 2026-07-10 — Prior-art review and repo stop-ship audit

Completed:

- Reviewed primary sources for Pipecat Flows, AgentSPEX, ToolGate, ToolChoiceConfusion/CMTF, SABER, AgentSpec, ToolSandbox, BFCL, τ-Voice, EVA-Bench, Full-Duplex-Bench v3, AudioAgentBench, Audio MultiChallenge, and multi-turn degradation research.
- Narrowed the proposed contribution to a paired orchestration-intervention study with revision-bound capability authority, transactional/evidence-bound effects, reconnect and late-call containment, and audible-state commit. Progressive disclosure, graphs, durable state, checkpoints, tool gating, idempotency, cross-provider voice evaluation, and long-horizon voice benchmarks are not claimed as inventions.
- Found that the live call runtime loaded the currently active agent version instead of the immutable version stamped on the call.
- Found that flow-state summaries omitted durable outputs.

Fixed and committed in `f4cdaa7`:

- call runtime lookup now joins the exact `agent_version` recorded on the call;
- flow state summaries now include durable `state.outputs`;
- focused tests cover the immutable query and output summary behavior.

Open stop-ship work before paid canaries:

- evidence-bound output receipts and generalized idempotency are not yet complete;
- revision/epoch-bound capability leases and stale-call rejection are not yet complete;
- exactly-once reservation/reconciliation for concurrent mutations is not yet complete;
- audible playback/history repair instrumentation is not yet complete;
- the normalized server-side OpenAI/xAI/Gemini runner and immutable artifact bundle are not yet complete;
- offline seeded-fault graders and provider canaries have not run;
- call termination still requires an explicit Flow v2 completion/override policy review.

Evidence: commit `f4cdaa7`; [PRIOR_ART.md](PRIOR_ART.md); current draft protocol. These implementation fixes are not benchmark results.

- Spend delta: **$0.00**
- Cumulative paid spend: **$0.00**

## Next gates

1. Complete evidence-bound actions, capability epochs/leases, exactly-once receipts, and termination policy.
2. Implement immutable run artifacts, deterministic scenario compiler, condition-blind caller, and normalized provider adapters.
3. Pass offline mutation/fault tests at $0.
4. Run at most the $15 canary gate and audit every artifact before releasing pilot spend.
5. Use a paired pilot only to freeze the powered confirmatory design; do not treat pilot outcomes as superiority evidence.

## 2026-07-10 — Proof-carrying runtime checkpoint committed

Source commit: `ffc8e20` (`feat: add proof-carrying voice flow execution`).

Completed:

- Added typed output bindings that populate durable state only from successful action receipts from the current step attempt; fabricated, failed, pending, indeterminate, stale-epoch, unsafe-path, and type-invalid evidence now fails closed.
- Added short-lived HMAC capability leases bound to call, immutable runtime digest, capability epoch, step attempt, and action name.
- Added call-wide and step/argument-scoped admission policies, atomic reserve-before-dispatch persistence, duplicate suppression, indeterminate-outcome blocking, and machine-readable receipt hashes.
- Serialized grant-changing state transitions per call and made malformed persisted state stop rather than silently reset the flow.
- Pinned a complete runtime snapshot per call, including named flow, instructions, tool schemas/endpoints, integration manifests, environment/tool surface, and code revision.
- Routed Flow v2 business actions, including always-available actions, through the stable gateway; gated agent-triggered call termination on terminal flow state and settled effects.
- Separated background-task tools from realtime flow controls and leases.
- Upgraded the public membership/returns example to demonstrate receipt-bound outputs and explicit per-call/per-step idempotency.

Validation at the checkpoint:

- `npm run test`: **17 files, 112 tests passed**.
- Focused ESLint across the runtime, state store, capability, snapshot, MCP, task, voice, and associated test files: passed.
- `npm run typecheck`: passed in the integrated worktree immediately after the checkpoint.
- `git diff --check`: passed before commit.

Remaining before paid canaries:

- finish adversarial review and offline fixtures for all three normalized realtime clients;
- finish remote MCP proxying so secured Flow v2 integrations do not bypass the gateway;
- finish Audible State Commit integration, condition compiler, deterministic caller/orchestrator, and immutable CLI run bundles;
- pass seeded end-to-end fault simulations and artifact-completeness checks.

This is implementation evidence, not a model-quality result.

- Spend delta: **$0.00**
- Cumulative paid spend: **$0.00**

## 2026-07-10 — Audible State Commit checkpoint committed

Source commit: `f2edaa2` (`feat: track audible state commits`).

Completed:

- Added a provider-neutral, revision-bound reducer that separately records generated audio, played audio, provider-retained history, interruptions, reconnect invalidation, explicit provider-history repair, and downstream dependencies on unheard content.
- Made post-final provider-history changes fail closed unless they arrive as explicit repair evidence.
- Required terminal generation plus observed provider history before an interrupted response can be declared aligned or committed.
- Split provider-retained inaudible exposure from true Unheard-Content Leakage Rate; UCLR now requires an evidence-linked downstream dependency and completed horizon analysis.
- Kept retry tracking O(1) in retained state so long calls do not make evidence reduction quadratic.

Validation at the checkpoint:

- Focused Vitest: **7 tests passed**.
- Focused ESLint and isolated strict TypeScript: passed.
- Independent adversarial and fuzz review: no remaining stop-ship findings after repair-bypass, premature-alignment, and metric-definition issues were corrected.
- Synthetic 5,000-event reduction: approximately **23 ms** with a serialized reducer state of approximately **1.3 KB** on the development machine. This is an implementation microbenchmark, not provider-performance evidence.

No realtime provider session was opened. The orchestrator still must bind these events to actual playback and provider-history repair before paid canaries.

- Spend delta: **$0.00**
- Cumulative paid spend: **$0.00**

## 2026-07-10 — Causally matched true-audio runner checkpoint

Committed implementation checkpoints:

- `da76fef`: compiled all six conditions from one canonical scenario/Flow source, mechanically audited fact/tool parity, and exposed the same single native `capability_gateway` schema to every provider and condition.
- `9e742ba`: added a bounded, cancellable Streamable HTTP MCP client with atomic initialization, resumable SSE, catalog invalidation, endpoint policy, pagination caps, and redacted failures.
- `82bee68` and `6a1e572`: added normalized OpenAI/xAI/Gemini server clients with manual PCM turns, terminal tool-call provenance, immutable observer events, usage evidence, strict format acknowledgement, cancellation, and reconnect/resumption evidence.
- `dee0fa6` and `842f2b7`: added the paired realtime trial orchestrator, exact PCM hashes, common-gateway tool loop, authoritative-versus-model-visible outcomes, hard resource caps, Audible State Commit artifacts, 20 ms realtime packet pacing, and a backpressured redacted crash journal.
- `0fd05dc`: added frozen 16/24 kHz caller-audio preparation and paid loading with exact toolchain/voice/signal provenance, same-descriptor no-follow reads, signal-quality gates, path-independent semantic identities, toolchain re-hashing, and no synthesis in paid mode.

Focused evidence at these checkpoints included 66 cross-provider protocol tests, 13 orchestrator tests, 23 environment/audio tests, and repeated local native audio renders with identical PCM/manifest hashes. These counts overlap and are implementation evidence, not session outcomes.

No realtime provider session was opened.

- Spend delta: **$0.00**
- Cumulative paid spend: **$0.00**

## 2026-07-10 — Adversarial flow and study-design corrections

Adversarial traces found and corrected production/runtime defects before provider spend:

- real Postgres concurrency proved one execution owner across 50 reservations and one replayed settled receipt across 25 concurrent retries (`b6835ef`, `7a414e7`);
- call-scoped evidence now survives a legitimate same-step retry without redispatch (`cea5d7a`);
- unresolved old-epoch effects block step retry, transition, and completion (`4e740c4`);
- per-step/per-arguments idempotency keys now include the step attempt and no longer collide with the call-wide database unique index (`af1f11f`);
- multiple successful intents for one output binding now fail as ambiguous instead of silently selecting the latest receipt (`a06df88`); and
- the lease signer retains a five-minute production default but can bind a declared session up to one hour, preventing an artificial five-minute treatment failure (`2c5a4e3`).

Outcome-blind exact paired-power calculations replaced the inefficient 48-template × 2-correlated-variant draft. The current recommendation is 107 independent held-out templates per provider, one primary variant, two headline arms, and 642 sessions total. At alpha 0.05 this provides 90% power for a 20-point paired strict-success improvement when discordance is at most 0.40 and at least 80% power when discordance is at most 0.50. Low/nominal/stress planning envelopes are approximately $196/$364/$740 before exploratory spend. This remains an unfrozen design recommendation, not collected evidence.

Open paid-run blockers remain: complete the atomic indeterminate-effect reconciliation path, finish ToolWorld/caller-scheduler hardening and secret-boundary integration, pass the seeded offline fault E2E, freeze a canary plan, and verify the CLI ledger/journal from a clean checkout.

- Spend delta: **$0.00**
- Cumulative paid spend: **$0.00**

## 2026-07-10 — Zero-cost transactional fault sensitivity passed

The executable offline CLI completed two immutable, network-disabled runs against the same sixteen-turn industrial ToolWorld:

- `industrial-full-harness-fault-e2e` completed all seven ordered checkpoints, preserved the corrected `V-9B` valve, contained a premature forged close, retried only the declared pre-commit approval failure, recovered the timeout-after-commit close through authoritative state, and ended with `close_count=1`, `notification_count=1`, and `world_task_success=true`.
- `industrial-raw-unsafe-sensitivity` intentionally used the unenforced raw path and the same semantic fault probes. It ended with `close_count=2`, `close_retry_contained=false`, and `world_task_success=false`.

Complete artifact directories are content-addressed by:

- full harness: `3419833d65f1bd0b7d567150f15778441a9356e2c9783847cc9901e7ab1822df`;
- raw sensitivity control: `a589e5f8e535408d42c0d8331872c519e8086ef92e5b77262834d4ac9e186c33`.

The run journal also passed an APFS-specific immutable-publication smoke test without weakening Linux link-count checks. The deterministic caller/world scheduler and claim-gated report generator were committed as `2e3e241` and `83fb3f6`.

This is a $0 scripted-runtime sensitivity check. It proves that the measurement stack can detect the intended exactly-once/containment intervention; it is **not** evidence that any realtime model is better under the harness. Paid model canaries remain blocked while adversarial review closes provider tool-schema parity, event/turn identity, signed final-kernel attestation, reconciliation, and public secret-boundary findings.

- Spend delta: **$0.00**
- Cumulative paid spend: **$0.00**

## 2026-07-10 — Flow-independent mission runtime earned an exploratory provider arm

Implemented an experimental mission runtime for cases where one fixed path is the wrong abstraction. It persists a focus-scoped goal stack, provenance-sensitive fact revisions, proof-carrying obligations, proposal-bound confirmation, correction-triggered authority revocation, saga compensation, idempotent receipts, a transition hash chain, and exact-state cross-channel continuation.

A 1,000-seed same-intent offline sensitivity run compared the runtime with an unenforced controller:

- raw strict pass: **245 / 1,000 (24.5%)**;
- mission strict pass: **1,000 / 1,000 (100.0%)**;
- raw unsafe/duplicate effects: **922**;
- mission adversarial attempts rejected: **1,151**, plus **183** idempotently suppressed duplicate deliveries (**1,334** contained opportunities total);
- partial saga failures recovered through compensation: **153 / 153**;
- mission runtime failures and terminal open obligations: **0 / 0**;
- semantic result hash: `b91d50cf6b1f477713000671f31ea57a6de026ff22e569b98d4a5e7a63a689b2`.

The full methodology, per-fault counts, serialized artifact hash, command, and claim boundary are in [MISSION_RUNTIME_SENSITIVITY.md](MISSION_RUNTIME_SENSITIVITY.md). This is deterministic runtime-containment evidence only. It earns an exploratory `adaptive-mission` provider arm; it does not alter the preregistered raw-versus-full-harness headline comparison and does not support a model-quality claim.

- Spend delta: **$0.00**
- Cumulative paid spend: **$0.00**

## 2026-07-16 — Hostile claim-boundary and public-release audit

An external Fable/Claude Code architecture review was purchased for **$0.65141**. The saved response is [unverified peer-review input](../../docs/research/external/2026-07-16-benchmark-claim-architecture-fable.md), not C1–C5 evidence. It challenged the signed-attestation trust boundary and the risk that a conjunctive strict endpoint could make treatment-enforced containment look like reduced model drift.

The draft protocol now requires separate `task_completion`, `model_integrity`, and `system_integrity` effects beside `strict_success`; explicit provenance-versus-replay wording; fail-closed retention of missing final proof; requested-versus-acknowledged provider identity; and a written no-spend/canary acceptance packet.

Public-release review also kept the paid gate closed. The stock Twilio/xAI SIP ingress, high-authority builder SQL/JavaScript tools, open operator enrollment/spend surfaces, database tenant enforcement, scheduler-secret failure mode, caller-identity handling, recording retention, and standalone bridge authentication/backpressure/client-side tool-loop boundaries require code fixes before the repository can be described as a hardened public multi-tenant deployment. These findings are documented in [SECURITY.md](../../SECURITY.md); documentation warnings are not mitigations.

Numerical artifact reconciliation corrected one presentation error without changing the underlying mission result: the 1,000-seed JSON records **1,151 rejected attempts plus 183 idempotently suppressed duplicate deliveries = 1,334 contained opportunities**, not “1,151 blocked or deduplicated.” The semantic result hash remains `b91d50cf6b1f477713000671f31ea57a6de026ff22e569b98d4a5e7a63a689b2`; serialized SHA-256 remains `f8013b93e8ca92ce71cfb7ab6ceb4a190941691fad8da9a690f9655fddccef0b`.

First-party OpenAI, xAI, and Gemini model/protocol/pricing pages were rechecked on 2026-07-16; the candidate provider targets did not change. Live acknowledgement remains unverified until canaries.

Final local doc-audit snapshot before handoff: ToolWorld hardening/replay **25/25 passed**; the mid-integration kernel-attestation suite **2/8 passed and 6/8 failed** because the generated and parsed schemas had diverged; the strict-endpoint expansion had declared ten criteria before `scoreStrictPass` wired all ten; and the kernel-transcript benchmark could not rerun because `gateway-kernel.ts` referenced an undeclared private field. These are explicit executable stop-ships, not evidence. Counts must be refreshed after the code lanes settle.

- Voice-provider spend delta: **$0.00**
- Cumulative paid voice-provider spend: **$0.00**
- Auxiliary review spend delta/cumulative: **$0.65141**
- Total recorded program cash spend: **$0.65141**
- Paid canary gate: **closed**

## 2026-07-16 — Database-tenancy adversarial review

A second Fable/Claude Code review cost **$0.762557** and is preserved as [unverified database-tenancy advice](../../docs/research/external/2026-07-16-database-tenancy-fable.md). It identified concrete tests for structurally safe role selection, `FORCE ROW LEVEL SECURITY`, worker `WITH CHECK` policies, and sequence/table grants. Those suggestions do not count as repository evidence; only the disposable-Postgres migration tests can close the tenancy gate.

- Voice-provider spend delta/cumulative: **$0.00 / $0.00**
- Auxiliary review spend delta: **$0.762557**
- Cumulative auxiliary review spend: **$1.413967**
- Total recorded program cash spend: **$1.413967**
- Paid canary gate: **closed**

## 2026-07-16 — Campaign scheduler authority review

A third Fable/Claude Code review cost **$0.752466** and is preserved as [unverified campaign-scheduler authority advice](../../docs/research/external/2026-07-16-campaign-scheduler-authority-fable.md). It independently reviewed commit-barrier behavior, campaign-state rechecks, database-time leases, recipient privacy, and unknown-outcome handling. Its findings remain advisory only; executable reconciliation, crash, privacy, and authorization tests are the evidence gate.

- Voice-provider spend delta/cumulative: **$0.00 / $0.00**
- Auxiliary review spend delta: **$0.752466**
- Cumulative auxiliary review spend: **$2.166433**
- Total recorded program cash spend: **$2.166433**
- Paid canary gate: **closed**

## 2026-07-16 — Authentication and credential-boundary review

A fourth Fable/Claude Code review cost **$0.458499** (rounded from the provider record) and is preserved as [unverified authentication and credential-boundary advice](../../docs/research/external/2026-07-16-auth-credential-boundary-fable.md). Follow-up executable tests cover durable sink-generation decryption after ephemeral slot cleanup and lease-expiry fencing during stalled MCP discovery. The review itself remains advisory and does not advance an evidence class.

- Voice-provider spend delta/cumulative: **$0.00 / $0.00**
- Auxiliary review spend delta: **$0.458499**
- Cumulative auxiliary review spend: **$2.624932**
- Total recorded program cash spend: **$2.624932**
- Paid canary gate: **closed**

## 2026-07-16 — Pre-canary release-gate review

A fifth Fable/Claude Code review cost **$0.687619** and is preserved as
[unverified pre-canary release-gate advice](../../docs/research/external/2026-07-16-precanary-release-gate-fable.md).
It required a network-free production-runner emulator, predeclared
provider-specific smoke artifacts, enumerated database skips, and a strict
no-retry interpretation before any paid transport session. The review remains
advisory input and does not establish C1–C5 evidence or provider compatibility.

- Voice-provider spend delta/cumulative: **$0.00 / $0.00**
- Auxiliary review spend delta: **$0.687619**
- Cumulative auxiliary review spend: **$3.312551**
- Total recorded program cash spend: **$3.312551**
- Paid canary gate: **closed**

## 2026-07-16 — Active-catalog artifact corrected after independent red-team

The first draft of this C1 artifact was withdrawn after review found that it omitted the two JSON array brackets, conflated logical-entry bytes with the provider instruction surface, and described a preselected linear census as “reachability.” The corrected deterministic benchmark exercises a public 64-tool corpus through one sequential eight-phase Flow-v2 route and 18 real runtime snapshots while reporting three separate byte surfaces.

The non-dispatchable raw-full canonical logical-entry array is 63,960 UTF-8 bytes (T4 15,990). Each active phase exposes exactly eight business tools plus three controls. Active business-entry arrays are 7,944–8,075 bytes with median 7,989, a median byte reduction of 87.5094%. Full production catalogs are 10,956–11,702 bytes with median 11,363; exact production provider instruction blocks are 11,733–12,479 bytes with median 12,140.

All 64 target definitions were catalog-exposed once across the eight preselected active snapshots. That is a frozen no-retry census, not proof of arbitrary-path reachability or invocation success. Missing targets, cross-phase business-tool leakage, forbidden private-key hits, and private grant/expiry sentinel hits were all zero. Sixty-four exposed logical names resolved to private host bindings in memory without executing an integration. Reversing source order and changing private grant/expiry bytes left every public catalog and digest unchanged. The hierarchical flow passed production closure; flat disclosure failed both the 16-tool Flow reliability guard and direct active-catalog construction.

The reference and active entries are not byte-identical because their state-bound 64-character lease-scope digests differ: exact byte matches were 0/64. Normalizing only that digest produced 64/64 logical-definition and byte-shape matches with zero other mismatches.

Evidence:

- report: [ACTIVE_CATALOG_EFFICIENCY.md](ACTIVE_CATALOG_EFFICIENCY.md);
- portable semantic result: `8e3ec290e3fd2083ead8f8857ebbe41880accdc54fedad8cfd61c0000ae359d1`;
- source manifest: `fd84bb08347983e660bc77f672901620b26e8748f62463354312a6359ba2918a`;
- deterministic build manifest: `d7f59259e57b998806e4e34dd12800a43c250a768d1f4c2856be07ca0156b455`;
- observed toolchain manifest: `207bff47be651c3b6633761dc79a074a7134087f91ead2ea6aa93e01bcf15fa6`;
- source/build/toolchain-bound evidence: `5a95cdf1abc629c26c9e94a1b80b8490c7e940268fa5985df6804b60bc9291c1`;
- raw corpus file: 13,497 bytes, `67f1153d90ab578916fb31ce6b543aa74d382374453a1718ab5675bc8ae1df1b`;
- parsed canonical corpus: 11,932 bytes, `89452f09d62f3588e6b37acdd914aaa1c3b612c7ed89cb9b1a7ca3beeabc72c7`;
- corrected focused freeze: 5/5 tests passed;
- provider spend: $0.00.

This is C1 engineering evidence only. T4 is `ceil(bytes / 4)`, not provider-reported token usage. No model spoke, no provider session opened, and no claim about reduced drift, prompt or billed-token savings, latency, or model superiority is supported by this artifact.

- Voice-provider spend delta/cumulative: **$0.00 / $0.00**
- Paid canary gate: **closed**

## 2026-07-20 — First live provider admission exposed two xAI protocol gaps

The clean Gate 0 packet at commit `12b14dab386412126364fb7b900580c0a478883e`
passed all 18 recorded checks and authorized sequential $5 C3 transport
reservations. The first OpenAI run and first xAI run did not complete a
voice-to-voice interaction, so neither is a model-quality observation and no
headline provider bar may be populated from them.

The xAI investigation produced two actionable transport findings without
opening a second audio trial:

- the budget ledger's credential scanner confused an ordinary
  `c3-xai-...-reservation` identifier with an `xai-...` API key and rejected it
  before credential resolution or provider access;
- after using a neutral reservation identifier, the provider WebSocket opened,
  but xAI emitted a documented-wire keepalive `ping` before `session.updated`;
  the client incorrectly classified it as pre-ready application traffic.

Commit `84461f4` narrows the xAI secret heuristic, admits xAI pre-readiness
keepalives as control-plane traffic, requests manual turn detection using the
current `{ "type": null }` shape, and normalizes the provider's empty-object
manual-turn acknowledgement. The focused realtime and budget suites pass
**106/106**, root typecheck passes, and a zero-audio live diagnostic now reaches
`session.updated` instead of failing on `ping`.

The remaining live xAI blocker is evidence, not connectivity: the current
`session.updated` response omits the requested voice, input-transcription null,
and function name/schema/description. The strict paid gate therefore correctly
refuses to claim configuration parity. A future provider-specific evidence
policy must bind the outbound request and later exact tool behavior without
pretending omitted fields were echoed.

- Completed provider voice-to-voice benchmark interactions: **0**
- Provider-result bars supported: **0 / 3**
- Conservative filesystem-ledger liability settled: **$10.00**
- Provider-reconciled billed amount: **unavailable**
- Paid canary gate: **closed**

## 2026-07-20 — Exploratory 32-session live STS batch completed with a null strict result

The source-frozen v2 development experiment opened all 32 scheduled sessions across 16 matched raw-full/full-harness pairs with no retries. It used OpenAI `gpt-realtime-2.1`, Gemini `gemini-3.1-flash-live-preview`, and xAI `grok-voice-think-fast-1.0` over two deterministic 32-turn synthetic caller scenarios.

The initial v1 canary exposed a real orchestrator incompatibility: OpenAI and xAI emitted the newer host-authored `tool.dispatch` normalized event, while the trial loop consumed only `tool.calls`. Those v1 cells were preserved as an invalidated pilot. Commit `968276f` added response-bound execution for local proxy dispatches and a focused regression; the dependent orchestrator and realtime-client slice passed 150/150 tests. The corrected experiment was separately versioned and frozen at commit `0738f5b` before any v2 audio session.

V2 completed **433 / 1,024** planned voice-to-voice interactions. Terminal session counts were 12 completed, 10 provider errors, 1 response timeout, and 9 runner exceptions. Every strict arm scored 0%: GPT raw 0/6, Gemini raw 0/5, Grok raw 0/5, pooled HACC 0/16, and each provider-specific HACC arm 0. No harness-superiority claim is supported.

Evidence:

- public result: [LIVE_STS_DEVELOPMENT_RESULT.json](LIVE_STS_DEVELOPMENT_RESULT.json);
- result SHA-256: `a2d0ac00506a327f2ec2bd432e629443de5d4be7d6c9e42677dbe43a01ddcf4e`;
- plan SHA-256: `87cdaee2a7c8c7c239b717fec47230203499088163f5f5228d97e0ed102b47e1`;
- schedule SHA-256: `9d660facc978272979215f7148791dab66f6a9de5f1e5f62b80da3362a56a621`;
- fixture manifest SHA-256: `1ecfe632e8ee39169e20b4f1343e45c543cbdc7e52c71d6ae7b598e48aeefb49`.

This is exploratory API-model evidence with synthetic caller speech, not a consumer ChatGPT Voice benchmark or confirmatory result. Provider billing reconciliation remains pending; the frozen batch admitted at most 32 local $5 reservations for a $160 ceiling.

## 2026-07-21 — Durable authority foundation implemented

The repository now contains an application-owned runtime foundation rather than only a design proposal:

- migration `033` persists one organization-scoped, SHA-256-chained conversation log with atomic 1–64 event compare-and-append, exact replay, and conflict rejection;
- the runtime validates semantic transitions before persistence, replans on compare-and-append conflicts, and compiles a byte-bounded packet from verified durable state;
- Flow checkpoints bind runtime digest, Flow revision, capability epoch, unresolved receipts, and state digest into that log;
- migration `034` makes worker spawn and accepted result application atomic with corresponding conversation events;
- migration `035` makes pre-dispatch policy decisions append-only and transactionally couples an `allow` decision to its Flow action receipt using the database clock and durable prior-call count.

Fresh PostgreSQL migrations `001`–`035` and a `035` reapply completed locally. The runtime role had no direct `SELECT` privilege on policy evidence and retained only function execution; a real deny decision append inserted one row. The focused action-policy/admission slice passed 11/11 tests. The conversation-store integration test exercises 32 writers racing one head and requires exactly one commit plus 31 serialization conflicts; the governed worker database test exercises one spawn event/job and one result event/inbox application with exact replay.

The checked-in context-substrate result remains the only positive long-horizon number: at a 2,048-byte budget the authority packet retained 13,000/13,000 registered control-state units across 1,000 seeded 500–2,000-turn schedules, versus 83/13,000 for an equally bounded recent-turn window. That is deterministic application-memory evidence, not proof that OpenAI, Gemini, or xAI models perform better with the harness.

The live MCP gateway still uses the legacy Flow reservation and `launch_task` routes, provider sessions do not yet consume durable packets, and spoken-output guardrails remain out of scope. No provider-superiority bar is supported.

- Voice-provider spend delta/cumulative: **$0.00 / $0.00**
- Auxiliary review spend delta: **$0.495064**
- Cumulative auxiliary review spend: **$3.807615**
- Total recorded program cash spend: **$3.807615**

## 2026-07-22 — xAI LC4 transport corrected to provider-native server VAD

The xAI LC4 path no longer tries to impose OpenAI-style manual commits on a
provider-native VAD session. The frozen xAI arm now sends a hash-bound per-turn
`session.update` containing compact control plus the exact closed tool frontier,
waits for `session.updated`, then paces the same caller PCM used by its matched
arm. It requires ordered speech start, speech stop, automatic input commit, and
automatic initial response evidence. Manual commit and the initial
`response.create` are forbidden; one explicit `response.create` is allowed only
after the exact tool-result batch. Interruption and duplicate/unbound responses
fail closed.

OpenAI and Gemini retain their provider-specific explicit boundaries. Gate A
now distinguishes exact xAI server-VAD echo from the provider's exact empty
object omission; the latter cannot promote without spoken Gate B evidence. The
production adapter, signed qualification runner, failure taxonomy, and retained
wire assertions bind the new mode and invalidate stale v3/manual artifacts.

No provider socket was opened and provider spend was **$0.00** for this change.
The test evidence is implementation/qualification-mechanism evidence only; it
does not produce or authorize a model-quality or HACC-superiority score.

## 2026-07-28 — Exact-model qualification passed; six-episode DEV run failed closed

A fresh qualification and development run were executed from source commit
`021c70e68e3edcf32172a3d89bf8611b5b011001`. The qualification passed the
pinned OpenAI `gpt-realtime-2.1`, Gemini
`gemini-3.1-flash-live-preview`, and xAI
`grok-voice-think-fast-1.0` paths. It opened three paid sessions and six
provider connections, completed three spoken gateway round trips, and used
zero retries. Its retained terminal records:

- terminal artifact: `0d1d18a1aaa9df9d3322151a592e3e2c9cf3fce51bd2c3034f5870db90f28295`;
- package artifact: `980b586bcaacb460a9f77adc5d8ff67c0715c1752f5b5f2376149f74cf38e02b`;
- replay artifact/head: `7bd1cc0dc62f91c3822f593a986485cd5bb4354de4af9f022a0a0609fbe5162d` /
  `562937e27efdbd295cdcab5743ccfdc1dbed068415d69cb3da3d9259002e970f`;
- OpenAI, Gemini, and xAI roundtrip evidence:
  `ac1fd8e8f941aa2bee7a56000fb1af53e306a998b07e1ea37a59d00c6a5627f3`,
  `86ada10a2bfa73a7d21aa0499d786394040680800a567ce9866f630cb642a2fc`,
  and `371b51b8c494f04043d5cc4a851439b59b0c14462d6291f8deaa67f80ec976eb`;
- corresponding independent replay artifacts:
  `e3bfbab106fb888c506d278095fc0758f55a4858a2881ae34069dd25be2435dd`,
  `7eaf9ac3a55ffed622e96395ac18d46afe21e723959a15ab4e4bd1f2b1876e3d`,
  and `5ac581aed4c6f5d5c2456c1f1fa294943f37c789bd611132ec738b201d6c0459`.

The qualification root is currently retained locally at
`/private/tmp/hacc-lc4-qv3-evidence-021c70e-20260728T180032Z`; like the DEV
root below, it must move to durable release storage before temporary-file
cleanup.

The immediately following six-episode HACC-LC4-DEV run did not complete. It
started three episodes and completed two, submitted 122 canonical
opportunities and completed 121, requested 130 response generations and
completed 129, crossed the provider-call boundary 129 times, performed eight
bounded repair playbacks, and used zero retries. It stopped on Gemini HACC
opportunity 2 with `audio_delivery_failed` at `response_prepare`.

The retained primary failure evidence is
`a6271cf4bf164e9ce0945df1bd80ccf6856ce011a8d0d32ea7efab1f1e87f437`.
Independent recomputation from the retained control object and frozen renderer
found a 4,096-byte canonical plan plus the 43-byte
`<hacc_response_plan>` envelope: 4,139 UTF-8 bytes against the Gemini client's
4,096-byte default dynamic-control bound. This is a harness transport-boundary
failure, not a Gemini model outcome.

The failed root remains present at
`/private/tmp/hacc-lc4-dev-evidence-021c70e-20260728T180121Z`. On 2026-07-28,
the checked-in evidence-root verifier reopened it and successfully reproduced
the ledger, budget, run package, and stored report. Its run hash is
`6af4008d7a516062ae33e08efbe9ccd8f8f17494a959dab8ba53e0304e51524c`,
report hash is
`f1a6999ca108a4032c45918654e91cdc12c07becbe04904448590fa5c5628846`,
run ledger head is
`c349b669fac0989fbd3ea83dc1be26a82e3d0a95d094c40237aa8f8cb72acef4`,
and budget terminal head is
`0f653d854bf2c6eeda322da9eead414e50639b1e83b8a40f1b178f8fac5d2f07`.
The root is replayable development-mechanism evidence, but it is not a complete
scoreable result and `/private/tmp` is not durable publication storage.

No partial Native/HACC score is published. C4/C5 and every drift, memory,
guardrail, or superiority claim remain **NO-GO**.
