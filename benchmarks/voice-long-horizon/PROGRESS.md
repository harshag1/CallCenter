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

## 2026-07-28 — Two further DEV roots exposed authority and branch-custody bugs

The next fresh root, at source
`deda084a14b803b40de1ef6835a80fe389bd0e1a`, completed 120/120 OpenAI
canonical opportunities and 128/128 response generations with eight bounded
repairs and zero retries. It failed after the HACC horizon because a rejected
argument-free `archive.observe_worker_result` attempt had
`effective_arguments: null`, but episode finalization treated it as an
accepted worker observation. The retained run/report/package are
`2a9fb6d0228d51df3af6f306868956a637230b178344a4fed36ed4f5a59f686e`,
`234b88b9ff8016eb6cc7afc455d4240e3fc5473adec63b34077ff1cefffa491f`,
and `55fa39c7d7dd2b30b4b6a7b8422c0c992cb0f1658a82245a08c32b90bd86c50d`.
Commit `79501bb` now retains such attempts as failed `@unbound` authority
events without satisfying obligations or crashing finalization.

A new exact-source qualification passed all three provider gateways before the
subsequent source-`79501bb50d8442b2e5c16db35fbb336061692f30` run. That DEV
root completed both OpenAI episodes, validating the prior fix live, then
stopped before Gemini HACC opportunity 42. It completed 161/162 submitted
canonical opportunities, 173/174 requested generations, 173 provider calls,
12 repairs, and zero retries.

The stop revealed a separate custody bug: the signed caller scheduler selected
the registered `no_call` status-followup branch, but the provider adapter
compared its 248,840-byte PCM only with the 180,128-byte non-branch episode
binding. Failure evidence
`bafa7762fdcad13f171242fec1a32649fee1fab1f41428f0844ce8150c1830d1`
shows the adapter rejected it at `pre_send_contract`, before any Gemini audio
or response request. The retained run/report/package are
`2b69e2551d50272477dd9c141d31e12267820f2fb69825aeadbe235480bf657c`,
`f55c4524c7725cc475f98e8f99ba230d03f0c3b50d3c0eb0483a93e434f24238`,
and `ac14cf464ab5fdb56d2bfc9b3d9be46d5972b844ea863ffcede46804ba762b6e`.

Both reports are incomplete, claim-ineligible, and unscorable. The completed
OpenAI episodes are not partial results. The exact failure analysis and custody
hashes are retained in
[HACC_LC4_DEV_FAILED_ATTEMPTS.md](evidence/HACC_LC4_DEV_FAILED_ATTEMPTS.md).
At this attempt boundary, a new paid run was blocked until alternate branch
audio could be accepted only through verified signed branch authority and
provider-free mutation tests covered wrong opportunity, outcome, PCM
hash/length, and sample rate.

- Conservative DEV settlement delta: **$12.50**
- Active reservations after both terminals: **$0.00**
- Provider-reported and invoice-reconciled cost: **unavailable**
- Public benchmark graph: **blocked**

## 2026-07-28 — `f956647` qualification passed; DEV gateway repair failed closed

The fresh qualification at source
`f95664760510016b4da5389982a11e6c8e428883` passed the pinned OpenAI
`gpt-realtime-2.1`, Gemini `gemini-3.1-flash-live-preview`, and xAI
`grok-voice-think-fast-1.0` paths. It opened three paid sessions and six
provider sessions, completed six generation phases and three tool round trips,
and used zero retries or reconnects. Its signed terminal artifact is
`4736fd083bfa9791f3b61479b7b5a96ece3aa3da613e4aee45fd7421268bca5d`
and its terminal-body hash is
`52ebc6eb0c963c95ca86c9e2d9d593fdbd8213554f30b451aee393509f8b1fca`.

The immediately following DEV attempt did not complete. It finished the
OpenAI Native episode, then stopped during the repair playback for OpenAI HACC
opportunity 10:

- episodes started/completed/finalized: **2 / 1 / 1**;
- canonical opportunities submitted/completed: **70 / 69**;
- response generations requested/completed: **75 / 74**;
- provider calls: **75**;
- bounded repair playbacks: **4**;
- paid retries: **0**.

Primary failure evidence
`cd6758a4b60320dd8548a7e46e0988a17cea61249ba572cd95d0e83655d5a48a`
records a `gateway_fatal` at `gateway_dispatch`, classified as `parse`, on the
opportunity-10 repair. The provider terminal was observed and 256,800 bytes of
assistant PCM were retained, but the response did not reach the adapter's
completed state. Secondary cleanup evidence
`a4847c11afb7c32cafd98128070691606da3844fb67068f26927cfbae8523104`
links back to that primary failure. This is an evidence/gateway-path failure,
not an OpenAI model score.

The run/report/package are
`e981290743e1120866078717f319e468efe19832e33a1651dad0c01e12c41313`,
`7edc0be39165d06dbeacb5ce6bb28719ab557c6327e2a9550fe83becc4ecaf0a`,
and `d1313acb4515e78093d7f4cf4b1e22f3c9961554ff1dc1f588e9fba2e5a0b947`.
The report is incomplete, claim-ineligible, and
`unscorable_missing_authority_evidence`, with no task results. The exact
failure record is retained in
[HACC_LC4_DEV_FAILED_ATTEMPTS.md](evidence/HACC_LC4_DEV_FAILED_ATTEMPTS.md).

- Qualification conservative settlement: **$3.00**
- DEV conservative settlement: **$5.00**
- Active reservations after both terminals: **$0.00**
- Provider-reported and invoice-reconciled cost: **unavailable**
- Public benchmark graph: **blocked**

Neither the completed Native episode nor the nine completed HACC opportunities
may be extracted as a partial benchmark. No Native/HACC efficacy, memory,
guardrail, drift, or superiority claim is authorized.

## 2026-07-28 — Gateway contract repair and provider-free fault injection

The failed `f956647` attempt exposed a model-facing namespace collision rather
than a transport or audio failure. The HACC control packet advertised internal
actions such as `archive.complete_stage` and `flow.get_state`, while the sole
provider function accepted closed semantic intents such as
`complete_current_stage`. The well-identified but semantically invalid request
was incorrectly escalated to a session-fatal parse error.

Commits `ab3d2ef634e0947aa719610c6e4818762f75d16d` and
`80cbdd8` now:

- project internal actions to the exact callable semantic frontier and hide
  internal-only controls;
- reject an entire provider batch before any sibling executes when one member
  is semantically invalid;
- return a bounded provider-visible correction result and request exactly one
  continuation;
- retain separate zero-effect rejection receipts that cannot satisfy an
  authority obligation;
- expose no executable tool frontier during speech-repair playback;
- keep identity, provenance, replay, batch-abuse, result-delivery, and
  post-dispatch ambiguity failures fatal.

The provider-free fault-injection benchmark in commit `580afdd` executed 33
real `Lc4DevGatewayTurnCoordinator` scenarios across OpenAI-, Gemini-, and
xAI-shaped events:

- clean controls: **3/3**;
- recoverable semantic, mixed-batch, and repair faults contained: **15/15**;
- provenance, replay, abuse, and delivery faults failed closed: **15/15**;
- unauthorized executor calls: **0**;
- false authority projections: **0**;
- provider API and network calls: **0**.

Its artifact SHA-256 is
`21719d58e73a54d50f9bcf547d90b4bc4d4ad1710114e808d30d83ae3370e64d`.
This is deterministic mechanism evidence for the enumerated faults. It does not
measure how often a provider emits them and does not authorize any provider or
HACC efficacy claim. The paid six-cell benchmark and graph remain blocked until
a new exact-source qualification and one-shot run complete.

## 2026-07-28 — `4e47774` one-shot run quarantined after evidence-custody failure

The exact-source qualification at
`4e477740de14c8520d5baba2337d10a0077c822f` passed all three pinned provider
gateways with three paid sessions, six provider sessions, six generation
phases, three tool round trips, and zero retries.

The following six-cell DEV run completed both OpenAI arms and both Gemini arms:

- terminal episodes: **4/6**;
- completed canonical opportunities: **240/360**;
- completed provider turns, including registered repairs: **256**;
- paid retries: **0**;
- HACC pre-dispatch semantic rejections: **0**.

After Gemini Native reached its terminal event, the runner opened the internal
xAI Native episode and recorded its signed budget connection intent. A provider
network connection attempt began, but no xAI caller audio, response generation,
or provider exchange was submitted. The next signed-ledger inspection rejected
a transient unsafe pathname observation. The file later observed as a private
regular one-link file, but the old aggregate diagnostic did not retain which
metadata predicate differed.

The in-memory failed run was then masked by a second ledger inspection during
budget finalization. Consequently the root contains no immutable `run.json`,
terminal budget evidence, run package, report, or public result. It is
quarantined, must not be resumed, and contributes no partial score or graph.
Its last run-ledger event is
`9f3c562f768d21eb93fb2434f24c9ba8105fc360c283ce179898dbe8130dab90`;
its last budget event is
`7f0ede4f0c73c796c28b8ca9d86da01e3455b8d8a5c43412766f80d3da9b6564`.

The launch fix keeps the ledger on one `O_NOFOLLOW` descriptor from verified
read through append, binds pathname and descriptor by device/inode, revalidates
after read and fsync, detects extra bytes, and keeps persistent hard links,
symlinks, replacements, and unsafe modes fail-closed. The operator now writes
the terminal run before secondary cleanup and publishes terminal budget
evidence plus the run package as one rollback-safe immutable pair. Future
release evidence is rooted on private local APFS outside Desktop metadata
management.

The same source cycle also corrected provider continuation control:

- OpenAI/xAI bind the exact current response plan on `response.create`;
- Gemini 3.1 sends normal-turn control over `realtimeInput.text`;
- Gemini semantic-rejection control is embedded in the synchronous
  `toolResponse`, its sole generation trigger;
- any missing, stale, oversized, colliding, or undeliverable binding fails
  before unsafe result delivery, with zero executor or authority projection.

No Native/HACC memory, drift, guardrail, or efficacy claim is authorized from
this incomplete run. A new source commit, qualification, evidence root, keys,
authorization, and full one-shot run are required.

## 2026-07-28 — `c0592ae` qualification passed; finite xAI DEV clip failed closed

The next exact-source qualification at
`c0592aed6d770dd06cdecac15846e4b91dc7ebee` passed OpenAI
`gpt-realtime-2.1`, Gemini `gemini-3.1-flash-live-preview`, and xAI
`grok-voice-think-fast-1.0` with three paid sessions, six provider sessions,
six generation phases, three tool round trips, and zero retries. Its trust
artifact and terminal artifact are
`d3536c9c25fa727d7a1f97673e15bb2c9f8c84eab1d25717f38568118e55cfcf`
and
`d06f11a0066d606d6f0e2213b4813d94b0525d9a2d760f9c0951195bd4b356bf`.

The exact-source one-shot DEV attempt then recorded:

- episodes started/completed: **5/4**;
- canonical opportunities submitted/completed: **241/240**;
- provider calls: **256**;
- registered repairs: **16**;
- paid retries: **0**.

Both OpenAI arms and both Gemini arms completed their full 60-opportunity
horizons. xAI Native opportunity 1 delivered all finite caller PCM and observed
`input_audio_buffer.speech_started`, but the provider did not emit
`input_audio_buffer.speech_stopped`, automatic commit, response start, output,
or a terminal response before the bounded timeout. xAI HACC was cancelled
without opening. The immutable failure run and package hashes are
`0e2b0e1726bed14130f0bca1d2996a168d0f8cbd0f82c24070b578b7cc83b967`
and
`fe73edce47d78aabe227dfbedf548c6366fd0471b14cdec98f2ec5241d54de39`.

The official report ran once and correctly remained incomplete:

- report:
  `c562b13ac2961f257067608666d100a18eb72a40ad2440eed56fe78eff7ef071`;
- exact six-episode horizon: **false**;
- evidence complete: **false**;
- task results available: **false**;
- efficacy claim eligible: **false**;
- budget replay verified: **true**.

The terminal filesystem ledger has **$0.00** active and conservatively settled
**$12.50** for DEV. Together with the qualification's **$3.00**, cumulative LC4
conservative settlements are **$55.50**. The earlier `4e47774` ledger still
carries **$15.00 maximum** quarantined nonterminal authority outside that
settled total.

The failure was traced to a concrete composition mismatch. Qualification
already appends the frozen, separate zero-PCM transport delimiter after the
byte-exact xAI caller clip so native server VAD can observe the configured
silence window. The DEV production adapter at `c0592ae` omitted that existing
suffix and ended transport immediately after caller PCM. That explains why
qualification completed while the finite DEV clip remained in
`speech_started`.

This diagnosis is not validation of any pending source change. The `c0592ae`
root is failed, immutable, and nonpublishable; none of its completed cells may
be extracted into a score or launch graph. A new source commit, qualification,
evidence root, keys, authorization, and full one-shot six-cell run are required
before any Native/HACC efficacy statement.

## 2026-07-28 — `f75d1d2` one-shot exposed xAI VAD liveness boundary

The exact-source qualification passed all three providers with zero retries.
Its xAI evidence covers the retained server-VAD transport only; it does not
qualify the later finite-manual efficacy transport. The following DEV run
completed four full 60-opportunity cells and eight xAI Native turns before
failing closed at xAI Native opportunity 9.

The failed turn delivered all 101,142 caller PCM bytes in 106 chunks and the
full separate 800 ms zero-PCM delimiter. xAI emitted `speech_started` but no
`speech_stopped`, automatic commit, response start, output, provider fatal, or
terminal response before the bounded timeout. Five provider pings arrived
during the wait, so the socket remained inbound-live. The evidence excludes
the prior missing-delimiter defect but cannot distinguish provider VAD state
from one-way media-ingestion loss.

- episodes started/completed: **5/4**;
- canonical opportunities submitted/completed: **249/248**;
- registered repairs completed: **16/16**;
- provider calls completed: **264**;
- paid retries: **0**;
- run/package: `d98b0d6e1b009dde600f37986904f082b9e52dab098a935420c191d537aa880a` / `5d2ecd3f17f8474db4ec400ca5b9f3101bed290059a4f3a0ecefcb3df4570de3`;
- primary/cleanup failure evidence: `e51ee7c631fc6aa3ca8c816ca4d4c5172e9b09b0791db3d9dbeb2d4caab119c1` / `2f8b8e7abc76bcb0421e24103dd0d808e4be3818a8132b8fc2c566f9638d0a52`;
- DEV conservative settlement: **$12.50**, active authority **$0.00**.

The root is immutable, nonpublishable, and contributes no partial score or
graph.

The next source revision separates estimands instead of hiding the failure:
finite prerecorded xAI LC4 calls use the documented manual boundary
(`turn_detection: null`, exact PCM, one commit acknowledgement, one initial
response request), while interactive server-VAD qualification remains
separate. The live server-VAD delimiter is independently extended to a
replay-bound 2,000 ms hard cap and fails immediately on exhaustion. Transport
mode, purpose, profile hash, commit/acknowledgement/request/start ordering, and
qualification scope are machine-bound through profiles, signed admission,
evidence, and replay. Provider-free validation passed 2,708 tests with 59
skips, plus lint and TypeScript.

No new paid run is authorized by this entry. A new immutable source commit and
a small, one-shot xAI Gate D manual finite-clip qualification must produce a
signed replay-verifiable receipt before another six-cell one-shot. Gate D is
transport evidence only: it admits the finite-manual path but does not itself
support a Native-versus-HACC score or launch claim.

## 2026-07-28 — Active-catalog artifact refreshed for durable context packets

The production provider-instruction wrapper now tells the model to replace the
prior durable context packet when a tool result returns
`outcome.hacc_realtime_context_packet`. The canonical `$0` active-catalog
generator was run twice from the same source and toolchain; the two 37,398-byte
pretty JSON artifacts were byte-identical with SHA-256
`2a5eb967ea915816ab9fa70bcf32b8522236309983d3d789c54c4979886c3013`.

This intentional wrapper change adds exactly 115 bytes to every measured
active provider-instruction block. The wrapper is now 892 bytes, up from 777;
active instruction blocks are 11,848–12,594 bytes with median 12,255, up from
11,733–12,479 with median 12,140. Their rough T4 range is now 2,962–3,149 with
median 3,064. Tool counts, logical-entry bytes, full-catalog bytes, compiler
containment, the 64/64 frozen exposure census, and zero private-leak findings
are unchanged.

- portable semantic result:
  `7ec332b0db56908924ceef07151a033d90fa0bf56c2145bdf1f65e8373d65442`;
- source manifest:
  `9dd1fda3382d3566dbd0f93fdbcaa03634c57fc430831e2013362b7fc0b63fba`;
- deterministic build manifest:
  `d7f59259e57b998806e4e34dd12800a43c250a768d1f4c2856be07ca0156b455`;
- observed toolchain manifest:
  `419ad3ce70d8af1ce32b62146dcd48b32459eef083f0268edc82164904e74a25`;
- source/build/toolchain-bound evidence:
  `6d7969749fcb0d5080e9f5b93913aeea8093ef427b64b5ab224f0eb18cf263bb`;
- provider spend: **$0.00**.

This remains C1 serialization and containment evidence. It does not establish
provider token usage, billed savings, invocation success, model quality,
reduced drift, or superiority over a native realtime agent.

## 2026-07-28 — Live xAI manual telemetry discovery and Gate D v3

The first finite-manual Gate D from clean source
`3d91c85103c6eab03302f714fbd59f5ac51906f3` claimed its one-shot invocation
and failed before producing a passing receipt. The private root is immutable,
cannot be retried, and contributes no qualification or efficacy evidence. Its
full `$1.00` authority is conservatively settled.

Two bounded production diagnostics then isolated the mechanism without
reusing that root:

- a setup-only WebSocket accepted the pinned
  `grok-voice-think-fast-1.0` model, `ara` voice, 24 kHz PCM formats,
  `turn_detection.type: null`, and the static function schema; the observed
  lifecycle was `socket.open`, `session.created`, `conversation.created`,
  `ping`, `session.updated`;
- a separate single-generation manual-audio probe appended 126,156 bytes of
  PCM, explicitly committed, received `input_audio_buffer.committed`,
  explicitly requested one response, observed 96,480 assistant PCM bytes, and
  completed. It also emitted exactly one
  `input_audio_buffer.speech_started` / `speech_stopped` pair before the commit
  acknowledgement despite manual mode.

That pair was telemetry, not turn authority: no response started until the
host's explicit commit acknowledgement and `response.create`. The failed Gate
D had incorrectly treated any speech-activity report as proof of provider
server-VAD control. The source correction now:

- treats the pair as optional non-authoritative telemetry;
- admits only zero events or exactly one ordered started/stopped pair before
  the explicit commit acknowledgement;
- rejects incomplete, duplicate, response-bound, or call-bound telemetry;
- still requires exact `commit -> committed -> response.create ->
  response.created` causality and a distinct post-tool continuation;
- rotates the finite-manual transport profile, production binding, and Gate D
  identity to v3; and
- emits only a closed-vocabulary failure class after a one-shot claim, never
  provider plaintext.

The two diagnostic sessions are grouped under a separate conservative `$1.00`
charge; provider billing remains unreconciled. Post-baseline conservative
exposure is therefore `$2.00` including the failed Gate D. This is a transport
finding and source correction, not an efficacy result, Native/HACC score, or
launch-graph datum. A fresh clean commit, keys, evidence root, and passing Gate
D v3 receipt remain mandatory.

## 2026-07-28 — Live xAI audio-wire alias discovery and Gate D v4

Gate D v3 at clean source
`35ba9be4544e339aca2ac58db322f88fea90f495` crossed the corrected manual
turn boundary but failed its one-shot audio-output contract. It produced no
passing receipt, its private root is quarantined, and its `$1.00` authority is
conservatively settled.

A fresh redacted raw-wire diagnostic then executed the exact two-phase
function lifecycle successfully with no retry or reconnect:

- one explicit manual commit and acknowledgement;
- two distinct provider response identities, both terminal `completed`;
- 86,880 initial-response PCM bytes and 193,440 post-tool PCM bytes;
- exactly one `capability_gateway` call whose arguments selected
  `transport.probe` with an empty argument object; and
- one function result followed by one explicit continuation request.

The provider emitted assistant audio on the currently documented
`response.output_audio.delta` event. HACC's shared normalizer already accepted
both that event and the legacy-compatible `response.audio.delta`, but Gate D's
independent role checker required only the latter. The source correction makes
the two-name set explicit in the frozen xAI transport profile, production
binding, live adapter, and replay validator; concrete production-adapter tests
now exercise `response.output_audio.delta`. Gate D identity is rotated to v4,
so neither failed root can be admitted under the corrected contract.

This diagnostic is conservatively charged another `$1.00`; post-baseline
conservative exposure is now `$4.00` across two failed one-shot gates and two
bounded diagnostic groups. It remains transport evidence only. A new clean
commit and a fresh passing Gate D v4 receipt are still required before
qualification or any efficacy cell.

## 2026-07-29 — DEV v5 stopped locally; fresh paid sequence remains gated

The latest immutable LC4 DEV v5 root at source
`12650977209760e244b7df8d551788bd3b33cddd` completed OpenAI Native's 60
canonical opportunities and OpenAI HACC's first 20 before the HACC episode
reached its first connection-rotation boundary. Across those two partial cells,
the retained run records 80/80 submitted/completed canonical opportunities, 86
completed generations including six registered repairs, and zero paid retries.
These are execution-custody counts, not result cells or efficacy evidence.

The retained run then failed before segment 2 opened:

- machine-recorded failure class: `transport`;
- failure message SHA-256:
  `5e7b140348c37e798dbdc66d3ecad0f1f66e573b992bc3c67cee4fcf83bfe7fa`;
- exact hash preimage proved offline:
  `LC4 rotation conversation text is invalid`;
- segment-2 provider sockets, generations, and calls: **0**;
- run:
  `32625a9fc35f26c75e27218554e7026ae1d23f1231e8e0788c4b2bc909cf1c56`;
- package:
  `a1c33fe35b832cc365b751375f84b35290a0390894fd16b71bce1ec06aadbea2`.

The stored `transport` label is immutable historical output but an inaccurate
diagnosis. Provider-free reconstruction found that one HACC tool-result turn
was 9,187 UTF-8 bytes because the provider-visible success payload duplicated
the full response plan. The local rotation validator rejected it against the
then-current per-turn bound before making a segment-2 provider call. This is a
local continuity/rotation compilation defect, not evidence of a provider
transport failure, model failure, HACC win, or Native/HACC comparison.

The v5 budget terminal conservatively settled **$5.00**, cancelled the four
unopened reservations, and retained **$0.00** active. Immutable conservative
paid-provider exposure for the current release epoch is now **$41.50**.
The earlier **$15.00 maximum** authority remains separately frozen and
non-reusable; it is neither settlement nor invoice evidence.

Only one next fresh-source paid sequence is authorized:

- `$1.00` maximum for xAI finite-manual Gate D;
- `$3.00` maximum for exact-source three-provider qualification;
- `$15.00` maximum for one one-shot six-cell DEV root.

That sequence would cap ordinary post-baseline exposure at **$60.50**. Adding
the frozen `$15.00` solely as an ultra-conservative liability view yields
**$75.50**. Both remain under the user's strictly-less-than-`$250.00`
remaining-work ceiling; neither is a spending target.

Paid rerun admission is currently **blocked**. Provider-free tests must first
prove lossless, ordered reconstruction of every provider-visible conversation
turn at both segment boundaries, including batched successful tool results and
pre-dispatch rejection results, and prove that history hydration completes
before caller audio begins. No paid rerun, completed benchmark, result score, or
launch graph is claimed by this entry.

A separate Fable/Claude Code rotation-architecture review cost **$0.57204** and
is preserved as
[unverified advisory input](../../docs/research/external/2026-07-29-lc4-rotation-fable.md).
It is auxiliary research spend, not realtime-provider spend or benchmark
evidence.

## 2026-07-29 — Provider-native continuity and qualification proof complete offline

The release branch now separates long-call continuity into three planes:

1. immutable audit evidence;
2. caller-heard provider conversation history;
3. bounded HACC control state and application-owned authority.

OpenAI and xAI hydrate ordered native conversation items with real per-item
acknowledgements. Gemini hydrates one ordered initial-history `clientContent`
frame and explicitly records that its protocol does not acknowledge individual
history items. The neutral contract preserves parallel `tool_batch` boundaries,
exact normalized arguments, canonical gateway results, source hashes, and
caller-heard assistant output. Generated-but-unplayed pre-tool speech is
suppressed from playback and future conversation history while remaining
content-free, hash-bound audit evidence.

The fresh qualification plan is now v7/schema 3. It signs the exact history
probe, provider-visible history hash, source-binding hash, and a distinct paid
configuration matrix requiring history hydration. Gate A setup sessions remain
non-generating setup checks; all three paid sessions must hydrate history before
caller audio. The retained-package verifier independently reconstructs the
history frames, item order, content hashes, acknowledgement boundary, zero
pre-input generation/tool/output activity, and first live-input observation.

Provider-free validation currently passes:

- OpenAI/xAI/Gemini hydration, batch, suppression, gateway, adapter,
  qualification, and live-runner focused suites;
- strict rejection of missing hydration, changed history hashes, fabricated
  Gemini acknowledgements, and pre-input model output;
- 33/33 deterministic gateway fault-injection scenarios, artifact
  `ab00c555a442345f1b7a1395c25d840e6b2bbc9d80f4a35beb4ff803da84ff77`;
- 96/96 offline claim-verification tests;
- full repository suite: 3,257 passed, 0 failed, 85 intentionally skipped;
- production build, full TypeScript, and ESLint checks.

This clears the history-hydration design gate but does not itself authorize a
provider call or support an efficacy claim. Paid admission still requires one
clean source commit, a fresh source-bound ASR environment receipt, and the
already bounded `$1 + $3 + $15` one-shot sequence. No score or launch graph is
claimed yet.

## 2026-07-29 — Voice-semantic calibration now fails closed on actual speech

The provider-free ASR admission gate exposed that the prior synthetic
calibration recited target phrases without asserting them. That was sufficient
for lexical ASR calibration but correctly failed the v3 negation-aware semantic
scorer. The calibration generator now:

- speaks explicit affirmative statements;
- preserves a separate canonical human transcript and transparent TTS prompt;
- preregisters spoken/ASR-equivalent forms for the collection identifier and
  visit time;
- omits prohibited claims from `contains_none` clips;
- scores every actual Whisper transcript against every required frozen
  criterion before signing; and
- independently verifies the exact 24-opportunity × 2-voice matrix, frozen
  criterion hashes, retained PCM, signatures, and semantic replay.

A fresh 48-clip development canary using macOS Samantha and Daniel TTS plus the
pinned local Whisper large-v3-turbo runtime completed with:

| Provider-free calibration metric | Observed | Wilson upper bound |
|---|---:|---:|
| Fixture coverage | 100.00% | — |
| Word error rate | 6.19% | 7.96% |
| Semantic false-negative rate | 1.16% | 5.04% |
| Semantic false-positive rate | 0.00% | 2.74% |

All 48 actual transcripts passed their frozen opportunity criteria, and the
offline signed-artifact verifier returned `valid: true` with no errors. This
canary opened **0** provider sessions and spent **$0.00**. It is development
evidence only because it preceded the clean source commit; the release gate
must regenerate and bind a fresh receipt to the committed source before any
paid session is authorized.

## 2026-07-29 — Qualification packet exposed provider-specific history semantics

The exact-source Gate D at `deea288` passed, but the subsequent one-shot
three-provider qualification failed closed and did not authorize DEV:

- Gemini hydrated the frozen caller/tool/assistant history and completed the
  spoken gateway roundtrip.
- OpenAI rejected the first client-supplied history item before caller audio.
  The retained packet hashes the provider error, so it proves the immediate
  rejection but not which field caused it. The new `item_hacc_hist_` identifier
  is a protocol-compatible hypothesis that must be validated by a fresh run.
- xAI acknowledged the seeded tool-call item/call identity but returned an
  empty-string arguments field. The old packet did not retain an independent
  tool-name projection, so it does not prove name echo. The new source does.

The repair keeps those evidence boundaries explicit:

- exact outbound history content is always wire-observed and hash-bound;
- OpenAI acknowledgements remain exact-content only;
- xAI may report `identity_acknowledged_content_unverifiable` only for the one
  observed shape: `conversation.item.added`, synthetic tool call, exact item
  and call identity, exact tool-name projection, and `arguments === ""`;
- absent arguments, omitted/empty tool output, nonempty mutations, wrong
  provider, changed item/call/name/type, or message omissions fail closed;
- condensed history evidence is now schema v2 and records four ordered
  acknowledgement scopes;
- exact-content evidence additionally proves field presence, JSON validity,
  and UTF-8 byte length; and
- the xAI live gateway result is selected by its replay causal hash, so seeded
  history tool items cannot be confused with an executed live result.

This is transport/evidence work, not a benchmark result. No Native/HACC score
or launch graph exists yet. The failed qualification root is immutable and
cannot be retried. A new clean source, fresh provider-free receipts, Gate D,
and one-shot qualification are required before any six-cell DEV execution.

Current provider-free validation for this source candidate is green:

- protocol/adapter/roundtrip/retained-package focus: **270/270**;
- full repository: **3,270 passed**, **0 failed**, **85 intentionally skipped**;
- TypeScript, ESLint, diff check, and the 44-route production build: passed.

## 2026-07-29 — Exact ID-limit proof and non-speech Gemini artifact repair

The next exact-source Gate D at `a9c2c66` passed, but its one-shot
three-provider qualification failed closed. No six-cell DEV run was authorized
and no score or benchmark graph is admissible.

The retained outcomes were:

- OpenAI rejected the first hydrated history item before audio.
- Gemini emitted a one-byte output-transcription containing only `"\n"` and no
  retained output audio; the runner immediately classified it as speech and
  disconnected before a tool call could arrive.
- xAI passed history hydration and the complete spoken gateway roundtrip,
  validating the narrowly scoped empty-arguments acknowledgement handling.

The OpenAI error was not guessed. A reconstruction of the exact outbound frame
matched the retained payload hash, and the retained diagnostic hashes resolve
to `string_above_max_length` and a maximum `item.id` length of 32. Three
zero-generation protocol sessions then established:

1. the 44-character current ID is rejected;
2. an omitted ID is accepted and assigned a provider `item_…` identity; and
3. a deterministic 32-character client ID is accepted and echoed exactly.

The correction keeps deterministic per-item acknowledgement evidence while
changing the generated format to exactly 32 ASCII bytes:
`item_hacc_<four-digit ordinal>_<17 hex>`. Runtime invariants reject overlong
or duplicate generated IDs, and tests assert exact length, shape, uniqueness,
and zero pre-input generation.

The Gemini failure was likewise a harness classification defect, not evidence
of audible model speech or proven model nondeterminism. The failed and
immediately prior passing runs were byte-identical through the activity-end
trigger; the pass received `toolCall` next, while the failure received the
newline transcription and was closed immediately. The classifier now retains
a whitespace-only transcript as a non-speech protocol artifact and continues
waiting within the existing bounded causal barrier. Any nonzero output audio or
non-whitespace transcript before the exact tool call still fails permanently.
Terminal-without-tool and timeout-without-tool remain failures.

Provider-free validation is green:

- exact history-ID and spoken-roundtrip mutation suites: **180/180**;
- full repository: **3,274 passed**, **0 failed**, **85 intentionally
  skipped**;
- claim-boundary verifier: **96/96**;
- TypeScript, ESLint, diff check, and the 44-route production build: passed.

The failed roots remain immutable and unscored. A new paid sequence is blocked
until these changes are committed, clean-source public audits pass, and a new
exact-source ASR receipt is created.

## 2026-07-29 — Second OpenAI 32-character boundary proved from retained wire

The fresh exact-source sequence at `f44aeb9` passed xAI Gate D. Its
three-provider qualification then passed Gemini and xAI but failed OpenAI
history hydration before caller audio, so DEV remained blocked and no score or
graph was produced.

The failure is exactly reconstructed from retained, content-free evidence:

- the first 32-character `item.id` was accepted by
  `conversation.item.added`;
- HACC sent the second, synthetic function-call item;
- OpenAI's later `conversation.item.done` for item one was valid and accepted
  while item two was pending;
- the exact item-two frame reconstructs to 270 UTF-8 bytes and SHA-256
  `18317d8fb688c7a92586e049232a1c128268539816d0730ff6e647c14ee11f52`,
  matching retained wire evidence;
- its deterministic `item.call_id` was 48 characters;
- retained diagnostic commitments resolve exactly to
  `string_above_max_length` and
  `Invalid 'item.call_id': string too long. Expected a string with maximum
  length 32, but got a string with length 48 instead.`

The repair uses
`call_hacc_<four-digit turn>_<three-digit call>_<13 hex>`, exactly 32 ASCII
bytes. Turn/call ordinals preserve uniqueness even under a digest collision.
Runtime checks reject overlong or duplicate synthetic call IDs. Tests cover
the exact late-`done` ordering and prove unique 32-byte item and call IDs at
the full 1,024-provider-item boundary.

Focused provider-free validation is **141/141**. The failed qualification root
is immutable and unscored. The next paid sequence remains blocked until this
repair, updated ledgers, full validation, public audits, and a fresh
exact-source ASR receipt are committed together.

## 2026-07-29 — Three-provider qualification passed; strict DEV loader caught history replay

Source `6dc5a65` cleared all offline gates, public audits, the fresh ASR receipt,
xAI Gate D, and three-provider qualification. The qualification retained:

| Provider/model | Result | History and spoken roundtrip |
|---|---|---|
| OpenAI `gpt-realtime-2.1` | passed | exact four-item provider-native history plus spoken gateway roundtrip |
| Gemini `gemini-3.1-flash-live-preview` | passed | ordered initial history plus spoken gateway roundtrip |
| xAI `grok-voice-think-fast-1.0` | passed | acknowledged history plus spoken gateway roundtrip |

All three executions replay-verified with zero retries. The qualification
terminal artifact is
`ddd1e92caef9fbe51039f068c2640ae3a2230a675f824f564e4bddde0eac25d9`.

DEV preparation then succeeded, but provider-free preflight refused before
authorization because the retained loader treated OpenAI's exact seeded
historical assistant-message acknowledgement as unquarantined live pre-tool
output. Retained wire proves the projection was an `item_hacc_…`
`conversationHistoryItem` with exact output-text hash and byte length. The
first live response contained a function call; caller-playable output began
only in the post-tool continuation.

The repair excludes only an exact message-history projection when:

- the typed history kind, role, and content type agree;
- the redacted text kind agrees; and
- SHA-256 plus UTF-8 byte length match exactly.

Audio, changed hashes or lengths, extra text entries, malformed history kinds,
and all unknown shapes remain fail-closed. The original retained qualification
now passes the strict DEV loader offline, and the focused verifier/operator
suite is **38/38**.

No DEV authorization, budget lease, ledger, provider call, score, or graph was
created. Because the repair changes source, Gate D and qualification must be
regenerated; the passing `6dc5a65` receipt will not be reused to authorize the
new source.

## 2026-07-29 — First DEV generation exposed a schema-v4 replay-version split

Source `985b3e8` cleared the clean-source audits, exact-source ASR receipt, xAI
Gate D, and three-provider qualification. Qualification passed all three
current realtime models with provider-native history hydration, the spoken
gateway roundtrip, package replay, and zero retries:

| Provider/model | Qualification |
|---|---|
| OpenAI `gpt-realtime-2.1` | passed |
| Gemini `gemini-3.1-flash-live-preview` | passed |
| xAI `grok-voice-think-fast-1.0` | passed |

The DEV preflight then authorized exactly six preregistered episodes and 360
repeated opportunities. The run stopped after the first OpenAI Native
generation:

- episodes started/completed: **1/0**;
- opportunities submitted/completed: **1/0**;
- provider calls and completed generations: **1/1**;
- paid retries: **0**;
- conservative DEV settlement: **$2.50**, with all other cell reservations
  cancelled and **$0.00 active**.

This was not a transport, model, ASR, or missing-evidence failure. The retained
root contains:

- the complete provider exchange under
  `f979c4b3ac3c4f8f16b41c97a9d7dea0e11ad7ee1dd969c4360ca009ac1821c3`;
- **404** terminal wire observations across the exchange and cleanup view;
- exact captured assistant PCM: **1,464,000 bytes**, SHA-256
  `dfda2b6b6ba8e449888af31cb506a2e3abc4a250b01eb9f3e99afa0bb986bde7`;
- signed listener evidence
  `e155be42299ef38ad4f30a5d25de9ba70cf66d791059992c814d04b3c55bebcb`;
  and
- a terminal budget ledger with no active reservation.

The adapter correctly emitted provider-exchange schema v4, introduced with
provider-native rotation history and pre-tool output suppression. The
independent replay verifier still admitted only schemas v2 and v3, so it
rejected the otherwise complete exchange after the paid generation returned.
Changing only the retained projection's version from 4 to 3 made the old
verifier replay every other contract successfully, proving the exact
version-split cause.

The then-current repair admitted schema v4 and matched its listener-consumed
output capture. The later strict v2 suppression contract supersedes that
legacy admission rule: a nonzero v1 suppression object cannot prove aggregate
hashes for unretained bytes and is intentionally non-admissible. Fresh
artifacts instead bind every suppressed chunk to an ordered redacted
wire-projection commitment and match the listener-admitted chunk count, byte
length, and PCM hash to the exact evaluator-consumed capture. The immutable
failed-run artifact remains historical rather than being silently upgraded.

The immutable failed-run report is
`5f5701cf2b4ee159d694172932f81a852aa1d1e2bb3dad22be45eb77069078c8`.
It remains incomplete and unscorable: this run contributes no Native/HACC
cell, score, comparative claim, or launch graph. A fresh source-bound gate,
qualification, and one-shot DEV root are required after the repair is
committed and all provider-free gates pass.

## 2026-07-29 — Two OpenAI cells completed; outer timeout obscured Gemini evidence

Source `09fad06` cleared the full repository suite, claim verifier, TypeScript,
ESLint, production build, public worktree/history audits, fresh exact-source
ASR receipt, xAI Gate D, and three-provider qualification. Qualification
passed the current OpenAI, Gemini, and xAI models with zero retries:

| Provider/model | Qualification evidence |
|---|---|
| OpenAI `gpt-realtime-2.1` | passed; 150 retained wire observations |
| Gemini `gemini-3.1-flash-live-preview` | passed; 115 retained wire observations |
| xAI `grok-voice-think-fast-1.0` | passed; 189 retained wire observations |

The strict DEV preflight authorized exactly six calls and 360 repeated
opportunities. The one-shot run then completed OpenAI Native 60/60 and OpenAI
HACC 60/60. Gemini HACC completed nine canonical opportunities before its
selected repair at opportunity 10 reached the runner's outer timeout:

- episodes started/completed: **3/2**;
- opportunities submitted/completed: **130/129**;
- generations requested/provider calls completed: **139/138**;
- completed repair playbacks: **8**;
- paid retries: **0**;
- conservative DEV settlement/active: **$7.50 / $0.00**.

Primary failure evidence
`4d71580defe95e7c660bda2cb19b8aff728ea8a08c366bca7e6e8caebe829a2a`
records `timeout / provider_response_timeout / provider_wait`, Gemini HACC
opportunity 10, repair playback, and the exact submitted repair PCM:
**201,280 bytes**, SHA-256
`0fc7bc34a4a79bfdb17607e66b08e55080aecc7a01bb6fd713aed613f667c676`.
Because the runner's generic 50-second fuse won, the primary artifact has no
adapter wire prefix or generation flags. Cleanup evidence
`0db7a4edbf3e122c148a58500076d2d6cdeae225f7c637dd389bcd9cd997bcec`
retains the failed segment close and the terminal wire view.

The failure is a local timeout-ownership race, not admissible model evidence.
The frozen corpus's longest paced input is **7,776.25 ms**. xAI can add a
**5,000 ms** control/commit acknowledgement barrier, and the adapter starts
its **45,000 ms** provider-response timer only after those earlier phases.
The old **50,000 ms** runner fuse and budget-operation window could therefore
preempt the adapter before it retained its sanitized diagnostic.

The repair centralizes every inner deadline in one shared timeout contract.
It preserves the 45-second provider policy and the pinned listener's
600-second Whisper subprocess limit. The outer runner watchdog and
budget-admission window are now 700 seconds: 8-second frozen input bound +
5-second provider barrier + 45-second provider wait + 600-second listener ASR
+ 30-second evidence margin = a 688-second inner bound, with 12 seconds of
emergency-fuse separation. Admission now rejects canonical, branch, or repair
PCM exceeding the 8-second premise.

The immutable partial run/report
`15b182d759ba6977e9e6cc1682330e822486af43bef6796c708c1b43c1a07048`
/
`4ae66633df0d5cc5a7dc4a2bd451480696771210c8d8905de04eabe917c25b3d`
remain incomplete and unscorable. The two completed OpenAI cells may not be
reused across a source change and may not populate a launch graph. All six
cells must be rerun from the repaired clean source.

## 2026-07-29 — Gemini post-terminal bookkeeping isolated from audible output

Source `35adfec77659501340dfe9b603b045a9981ee50b` cleared the full repository
suite, claim verifier, build, public audits, fresh ASR receipt, xAI Gate D, and
three-provider qualification. Its DEV root passed the previous Gemini repair
timeout boundary, completed both OpenAI arms, and completed 19 Gemini HACC
opportunities before opportunity 20 terminalized:

- episodes started/completed: **3/2**;
- opportunities submitted/completed: **140/139**;
- generations requested/completed: **149/148**;
- completed repairs: **9**;
- paid retries: **0**;
- conservative DEV settlement/active: **$7.50 / $0.00**.

Primary evidence
`b9de06a49860494a418b696ca64cac27561a1e02cf615e531c3383a5770c64c6`
retains Gemini HACC opportunity 20's complete caller delivery, normalized
response terminal, and **2,274,242** captured assistant PCM bytes across
**160** chunks, SHA-256
`651d88c398b718f305c316a1c0c346c6394804d203382851c7d04f786f045c34`.
The final observed wire union was `serverContent`, not a provider error frame.
The normalized client then emitted a fatal error, so the adapter correctly
refused to call the exchange complete.

The retained redaction boundary does not preserve the provider's raw late
frame, so its exact fields are not claimed. The lifecycle is strongly
consistent with a repeated post-terminal Gemini bookkeeping frame: after
`completeResponse()` marked the local generation trigger terminal, any later
`generationComplete`, `turnComplete`, or `interrupted` signal previously
called `ensureResponseStarted()` and became the generic fatal
`invalid_provider_message`.

The repair adds an explicit, identity-bound post-terminal metadata path:

- independently ordered input/output transcription and consistent duplicate
  terminal bookkeeping stay bound to the completed response;
- no second response lifecycle event is emitted;
- contradictory terminal state fails closed;
- any late model content, PCM, tool call, or tool cancellation fails before
  normalized output, execution, or cached replay; and
- a new local generation trigger closes the late-metadata window.

It also repairs the three public publication entrypoints that Node 24/tsx
could not transform because of top-level await, with a CommonJS-transform
regression test.

Provider-free validation on the final repair is **301 test files / 3,290
tests passed**, with **27 suites / 85 tests** explicitly inventoried as
environment-qualified skips. ESLint and TypeScript pass. The Gate 0 source
manifest now binds **330** source/configuration files under SHA-256
`e0c7c242541e9b0150dc73ce4e0ecc4a435beda05f3c2112ffe9779b26c67629`.

The immutable failed run/report
`d136124af3cd31254f554bb906293c11c619667706a9e3bbf53a6833114c31ed`
/
`75e215a26be1eb139d098dbd81847bfb92629a883a0097aaccf2f761fec19c1b`
remain incomplete and unscorable. No completed cell, comparison, or launch
graph may be reused from that root. A new clean commit, public audits,
exact-source ASR receipt, Gate D, qualification, and all six DEV cells are
required.

## 2026-07-29 — Gemini next-turn streaming transition repaired

The exact-source Gate D and three-provider qualification passed at `1dbcb68`.
The one-shot DEV run then completed both 60-opportunity OpenAI calls before
failing closed at Gemini HACC opportunity 2. It retained 121/360 completed
opportunities, 129 provider calls, eight repair playbacks, zero paid retries,
and zero active budget liability. The run is incomplete and contributes no
efficacy score or graph.

Failure evidence proves that Gemini accepted only three paced PCM chunks for
opportunity 2 before a `serverContent` frame made the client fail audio
delivery. The completed-response metadata guard had not accounted for the
expected interval in which the next input turn is open but its `activityEnd`
generation trigger is not yet armed.

The repaired transition permits exactly that `+1` open-input state while
keeping untriggered model output, PCM, tools, conflicting terminal state, and
wider turn gaps fail-closed. The exact regression, focused integration tests,
and complete sequential test/lint/typecheck gate pass. A new paid sequence
remains blocked on a clean commit, public audits, and a fresh exact-source ASR
receipt.

- Spend delta: **$11.50** maximum conservative settlement
- Current post-baseline conservative exposure: **$98.50**
- Active reservations: **$0.00**

## 2026-07-29 — Long streamed responses receive an honest terminal window

Source `ddc25e14afd8656bc17ecaa6d2d1808187fb994a` passed exact-source Gate D
and three-provider qualification. Its one-shot DEV root completed both
60-opportunity OpenAI calls and eleven Gemini HACC opportunities before
terminalizing during opportunity 12:

- episodes started/completed: **3/2**;
- opportunities submitted/completed: **132/131**;
- generations requested/completed: **140/139**;
- repair playbacks: **8**;
- paid retries: **0**;
- conservative DEV settlement/active: **$7.50 / $0.00**.

This run crossed the prior Gemini next-turn failure at opportunity 2 and
sustained ten additional caller/model turns. Opportunity 11 produced
**2,052,990 PCM bytes**—about **42.77 seconds** of 24 kHz mono PCM16—and
reported **1,074 output-audio tokens**. Opportunity 12 failed 52.6 seconds
after submission, strongly matching paced input plus the old 45-second
provider-response timeout.

The retained detail collapsed to a generic adapter failure because the failure
schema incorrectly required a response terminal before partial streamed audio
could be recorded. Realtime audio arrives before the terminal by design. The
repair now binds partial output to a started generation without inventing a
terminal, keeps lifecycle operations unique, and raises the provider-neutral
response fuse to 75 seconds. The emergency watchdog remains outside every
inner owner at 730 seconds. The run lease is six hours so paced long-form voice
episodes cannot exhaust a two-hour local wall-clock cap; the **$15** ceiling,
six cells, and zero-retry policy are unchanged.

Focused failure, adapter, runner, and budget tests pass **146/146**; TypeScript
and scoped ESLint pass. The failed root remains immutable, incomplete, and
unscorable. A new clean commit, exact-source ASR receipt, Gate D,
qualification, and all six DEV cells are required.

- Spend delta: **$11.50** maximum conservative settlement
- Current post-baseline conservative exposure: **$110.00**
- Active reservations: **$0.00**

## 2026-07-29 — Gemini physical-connection lifetime failure isolated

Source `4da599069d846fc84b000fd09e98c09f9ac8287a` cleared the provider-free
release suite, exact-source ASR receipt, xAI Gate D, and three-provider
qualification. Its one-shot DEV root completed both 60-opportunity OpenAI
calls and sixteen Gemini HACC opportunities before opportunity 17 failed:

- episodes started/completed: **3/2**;
- opportunities submitted/completed: **137/136**;
- generations requested/completed: **145/144**;
- completed repairs: **8**;
- paid retries: **0**; and
- conservative DEV settlement/active: **$7.50 / $0.00**.

Primary evidence
`29dfb88921a3d2106661d8d76ea3f571a1e39109e81d977961fc11591052f2e6`
retains the complete **147,244-byte** caller PCM submission and
**573,630 bytes** of partial assistant PCM across **46 chunks**. The response
started but never completed. Cleanup evidence
`d9837631272eede50cfa8fb58688de9adf58e8d0e2e3eb32146c667093318697`
is secondary.

The timing proves a deterministic local lifecycle boundary. The Gemini socket
opened at `2026-07-30T01:43:55.651Z`; opportunity 17 failed at
`2026-07-30T01:53:55.785Z`, **600.134 seconds** later. The production Gemini
factory configured a ten-minute maximum session duration, and the client
correctly emitted `session_duration_limit`. This is a transport-schedule
defect, not model-performance evidence.

The final release repair explicitly preregisters six 10-opportunity physical
provider sessions for every provider and arm while preserving all 60
opportunities and the corpus's three semantic acts. Each planned transition
must remain receipt-chained, losslessly hydrate the exact prior audible/tool
conversation, count against the 36-session run cap, and use zero retries and
zero unplanned reconnects. The five preregistered transitions per call are
planned rotations, not reactive reconnects. The same boundaries in both arms
prevent the transport repair from becoming an HACC-only treatment.

A proposed four-by-15 schedule was rejected before it could support a result.
The observed Gemini pace required approximately **8 minutes 51 seconds** for
15 opportunities, leaving only about **69 seconds** under the local ten-minute
connection limit for long-response variance, hydration, and transport jitter.
The six-by-10 schedule is therefore the conservative outcome-informed
amendment; it changes transport accounting, not the call count, semantic acts,
or repeated-opportunity estimand.

The immutable failed run/report
`35bb6b1b916c6207459fb80507a02bfb49e0b850cd5c68e8d372716b1cf119c8`
/
`38a3e94ade2a88e27e3a85f3935df6b9e6f89ba05b023bc79174939ab28cdf05`
remain incomplete and unscorable. No completed cell, comparison, or launch
graph may be reused. This is an outcome-informed development amendment, so a
new clean commit, exact-source ASR receipt, Gate D, qualification, and all six
DEV cells are required.

## 2026-07-29 — Gemini schema-v5 retained replay repaired

Source `32655f2142cb7d698b406cf46abcbc10df1b14c4` passed exact-source ASR,
xAI Gate D, and three-provider qualification. Its one-shot DEV run then
completed both 60-opportunity OpenAI calls across all twelve planned physical
sessions. Gemini HACC's first provider exchange and pinned listener evaluation
also completed, but the local replay verifier rejected the returned schema-v5
exchange:

- episodes started/completed: **3/2**;
- opportunities submitted/completed: **121/120**;
- provider calls/completed generations: **129/129**;
- repair playbacks: **8**;
- paid retries: **0**; and
- conservative DEV settlement/active: **$7.50 / $0.00**.

The retained Gemini artifact proves 42 activity-end-to-terminal interval
frames, 36 exact output chunks, 467,042 assistant PCM bytes, a completed
terminal, and signed listener evidence. Offline replay found a one-condition
version-routing omission: the verifier admitted schema v5 but sent only
schemas v3/v4 through the complete versioned Gemini attribution path. Schema
v5 fell into the older matcher and rejected valid audio-plus-transcript and
metadata frames.

The repair includes schema v5 in the versioned attribution path. A subsequent
adversarial review found that the legacy nested v1 suppression artifact
self-attested raw aggregate hashes for bytes it did not retain. The strict v2
contract therefore replaces those claims with replayable ordered chunk
commitments and verifies complete Gemini output attribution versus the exact
listener-admitted/evaluator-consumed suffix after suppressed pre-tool output.
The immutable failed-run artifact remains historical and is intentionally
non-admissible under v2 when it contains nonzero legacy suppression; it is not
silently upgraded. The regression fixture includes mixed
audio/transcript, transcript-only, empty metadata, session-resumption, and
terminal frames and still rejects a substituted interval preimage. A second
fake-adapter regression completes two non-empty Gemini gateway batches,
suppresses the pre-tool PCM, retains exact listener PCM, and passes the full
replay verifier, including rehashed aggregate-lie and unknown-field attacks.
OpenAI/xAI suppression is independently bound to ordered inbound wire
projections. Gateway bridge v5 binds accepted and rejected evidence to the
outer episode, opportunity, provider, arm, and phase; DEV rotations reject
metadata-free tool turns, and publication reconstructs the current schema-v2
batch contract. A provider-free six-session simulation proves rotations at
10/20/30/40/50, exactly one hydration before audio in sessions 2–6, exact
Gemini `clientContent` hashes, and receipt chaining. The complete web matrix
passes **3,307/3,307** executed tests, with **85** explicitly inventoried
skips; TypeScript passes. The regenerated provider-free gateway firewall
artifact passes **33/33** deterministic scenarios.

The source-bound run remains immutable, incomplete, unscorable, and unusable
for a graph. A new clean commit, exact-source ASR receipt, Gate D,
qualification, and complete six-cell DEV run are required.

- Spend delta: **$11.50** conservative settlement
- Current post-baseline conservative exposure: **$133.00**
- Active reservations: **$0.00**

## 2026-07-29 — Claimed Gate D failures became replayable terminal evidence

The clean source `f538fb2c051e317379e2d1bfa3461357f1da34b4` passed the
exact-source ASR receipt, 3,307-test web matrix, claim gate, production build,
dependency lock audit, gateway fault replay, and public worktree/history
secret audits. Its one-shot xAI Gate D then claimed invocation
`98c4d37a81bbea1d4200a0fd9966bdf80ac74513036b42a17354e73aee4d69ec`
and stopped without a passing receipt. A bounded credential-entitlement check
identified the retained xAI-only key as invalid. Qualification and DEV
remained closed, so this is not model-performance evidence and produces no
benchmark score or graph. The root is immutable and its `$1.00` authority is
conservatively settled.

The failure exposed a real operator gap: pre-hardening Gate D preserved the
private invocation marker but not a replayable terminal failure artifact.
The remediation keeps the passing Gate D v4 receipt unchanged and adds a
success-incompatible, terminal-key-signed `gate-d-failure.json`. It binds the
full invocation claim and physical marker custody, exact source/profile/
transport, precise lifecycle stage, a closed failure class, a nonce-salted
detail commitment, and exact `$1 / $1 / $0` budget state without retaining the
raw error, stack, PCM, credential, partial wire evidence, provider IDs, or
local paths. Provider authentication rejection is distinct from local
preflight, transport, and protocol failures, and the serialized failure
artifact is capped at 256 KiB before parsing.

Only the process that successfully created the marker can seal the failure.
`run`/`report` use exit code `2` for a verified claimed failure; malformed,
conflicting, racing, or unsealed roots remain exit code `1`; passing evidence
alone is exit code `0`. Status distinguishes `failed`, `claimed_unsealed`, and
`terminal_conflict`, and retry authority is false for every claimed root.
Provider-free tests cover pass/failure coexistence, racing marker ownership,
failure-file collision, terminal signature/privacy, and independently
re-signed semantic mutations. The focused Gate D/publication matrix passes
**37/37**; the complete web matrix passes **3,313/3,313** executed tests with
**85** inventoried skips. TypeScript
and ESLint pass. No provider call was made by the hardening.

- Spend delta: **$1.00** conservative Gate D settlement
- Current post-baseline conservative exposure: **$134.00**
- Active reservations: **$0.00**
- Publication status: **blocked; no score and no graph**

## 2026-07-31 — Release boundary after the 159/360 DEV terminal

The exact-source Gate D and three-provider qualification at
`ebae000fa68b0e9376095e216fbf4481bcb64055` passed. Its one-shot six-cell
DEV run then completed both OpenAI cells and 39 Gemini HACC opportunities
before failing during the repair response for opportunity 40:

- episodes started/completed: **3/2**;
- opportunities submitted/completed: **160/159**;
- provider calls started/made: **171/171**;
- generations requested/completed: **171/170**;
- repair playbacks: **10**;
- paid retries: **0**; and
- conservative DEV settlement/active: **$7.50 / $0.00**.

The primary immutable evidence is
`2427ad53e940942b0357cead46f22813b3148516764bd6c50760cfeee4c75fb4`.
Gemini emitted **12,078,750 PCM bytes** in **767 chunks**, equivalent to
**251.64 seconds** of 24 kHz mono PCM16, but never emitted a provider terminal
before the 75-second wall-clock fuse. Cleanup's `segment_close_failed` is
secondary. The report is incomplete, evidence-incomplete, task-result
unavailable, efficacy-claim ineligible, and therefore contributes no score or
graph.

Two release repairs now bound this failure mode independently:

1. Gemini Live requests `maxOutputTokens: 1536`, approximately 61.44 seconds
   at the provider's documented audio-token rate; and
2. the provider-neutral adapter fails closed after **65 seconds** of generated
   PCM, retains only the bounded partial-output commitment, closes once, and
   emits `provider_output_limit_exceeded` rather than waiting for a generic
   timeout.

The exact bounded-generation source
`d101005fbd4ceaf29bd2030abb0f8b7121588246` passed a fresh paid compatibility
qualification across pinned OpenAI, Gemini, and xAI models: three provider
calls, six physical provider sessions, three spoken tool roundtrips, six
generation phases, **466** replay events, zero retries, and **$3.00 / $0.00**
conservative settlement/active liability. This qualifies provider integration;
it does not complete LC4 or prove HACC efficacy.

The deterministic cap regressions pass **246/246** across Gemini Live,
production adapter, failure evidence, runner timeout ownership, exchange
replay, and provider profiles. Publication remains limited to the framework
and the latest already-completed benchmark. **LC4 remains blocked: no new
comparative score, superiority claim, or graph.**
