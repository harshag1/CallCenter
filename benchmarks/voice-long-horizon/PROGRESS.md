# Research progress log

<!-- markdownlint-disable MD013 MD060 -->

This file is append-only after the protocol freeze. Entries use Pacific Time and distinguish implementation evidence from scientific evidence. Provider spend is recorded in [BUDGET.md](BUDGET.md).

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

Source state at audit: branch `codex/pre-evening-batch-2026-07-02`; research documents were being edited in a dirty worktree alongside in-progress framework changes.

Completed:

- Pinned primary research targets to OpenAI `gpt-realtime-2.1`, xAI `grok-voice-think-fast-1.0`, and Gemini `gemini-3.1-flash-live-preview`, subject to freeze-time reverification.
- Documented provider tool mutability, audio formats, transcript semantics, session limits, resumption differences, usage records, and July 2026 pricing in [PROVIDERS.md](PROVIDERS.md).
- Chose manual turn boundaries for the primary semantic comparison and one stable capability-gateway tool for provider parity.
- Separated estimated, provider-reported, and invoice-reconciled cost.
- Added a $900 automatic scheduling ceiling so metering lag and in-flight work cannot consume the $100 hard-ceiling reserve by design.

Evidence: first-party provider links are embedded in [PROVIDERS.md](PROVIDERS.md). No provider session was opened.

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
