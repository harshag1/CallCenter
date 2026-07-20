# Claim-readiness audit

<!-- markdownlint-disable MD013 MD060 -->

- Audit date: 2026-07-16 PT
- Scope: long-horizon voice-agent drift, task-completion, and guardrail claims
- Protocol: `HACC-LHVR-v0.1` (draft)
- Decision: **NO-GO for C4/C5 effectiveness or superiority claims**
- Paid voice-provider sessions opened: **0**
- Paid voice-provider evidence available: **none**

This is a hostile-read audit of the benchmark as an academic systems artifact. Its purpose is to prevent a reproducible engineering result from being inflated into a model-behavior claim. It is deliberately stricter than a launch checklist.

The framework already has meaningful C1/C2 evidence for deterministic runtime invariants and synthetic containment. It does **not** yet have evidence that it reduces model drift, improves long-range task completion, or outperforms an unharnessed provider voice agent. C3 transport canaries may begin only after the Gate 0 packet is complete. C4/C5 remain closed until every stop-ship below is implemented and independently replayed.

## Executive verdict

| Proposed statement | Current evidence | Verdict |
|---|---|---|
| The runtime rejects stale, duplicate, unauthorized, or receipt-free effects in seeded deterministic schedules | C1/C2 contract and sensitivity evidence | Supported with the exact synthetic/offline qualifier |
| The framework is wired to OpenAI, xAI, and Gemini realtime transports | Adapter/unit evidence only; no paid session | Architecture statement only, not live compatibility |
| A pinned provider accepted PCM input, produced PCM output, and completed one common-gateway round trip | No C3 artifact yet | Not established |
| The full harness improves long-range task completion versus `raw-memory` | No valid C4 paired evidence | Not established |
| The full harness reduces model drift, forgetting, or illegal attempts | No valid C4 paired model-integrity evidence | Not established |
| The full harness prevents more unsafe external effects | Deterministic containment evidence exists; no paired provider evidence | Offline containment supported; provider-population claim not established |
| The framework outperforms raw OpenAI, xAI, or Gemini voice agents | No valid C4/C5 provider comparison | Prohibited |
| The result generalizes to voice agents broadly | Three development families, no untouched confirmatory corpus | Prohibited |

Evidence classes retain their definitions in [DECISION_EVIDENCE.md](DECISION_EVIDENCE.md): C0 design, C1 executable invariant, C2 seeded sensitivity, C3 paid transport compatibility, C4 paired exploratory model evidence, and C5 preregistered confirmatory evidence.

## What is already numerically credible

The following numbers are useful, reproducible engineering evidence when their boundaries remain attached:

1. The mission-runtime sensitivity ran 1,000 deterministic seeded fault schedules. The unenforced controller passed 245/1,000 (24.5%), while the mission runtime passed 1,000/1,000 (100.0%). The raw controller executed 922 unsafe or duplicate effects; the runtime executed zero. This is C2 containment evidence against an intentionally unenforced controller, not a speech-model experiment. The full artifact identities and fault counts are in [MISSION_RUNTIME_SENSITIVITY.md](MISSION_RUNTIME_SENSITIVITY.md).
2. The fixed ToolWorld causal suite contained 160/160 unsafe schedules while the intentionally naive schema-only comparator accepted or executed 160/160. This is a deterministic contract test designed after inspecting the mechanism, not a population sample or provider comparison.
3. Signed kernel/transcript and replay tests establish mutation, substitution, and internal consistency properties. A process-held signing key proves provenance and integrity at rest; it does not independently prove that the same process truthfully reported its own state.
4. The outcome-blind candidate paired-power calculation is reproducible and is now frozen in the executable `exactConditionalMcNemarPower` utility plus a regression test. At `n=107`, a two-sided exact conditional McNemar test has power 0.9016948182 for a +0.20 paired risk difference with discordance 0.40, and 0.8177184462 with discordance 0.50. That calculation does not validate the currently different executable report rule.

For that check, treatment-only and baseline-only discordance probabilities are `(d + delta) / 2` and `(d - delta) / 2`; the remaining mass is `1 - d`. Power is the exact trinomial probability, over `n` pairs, of landing in a treatment-only/baseline-only table whose conditional two-sided binomial test under `p=0.5` is at most 0.05. No normal approximation or simulated seed produced the values above.

An independent SciPy 1.17.1 recomputation produced 0.901694818246 and 0.817718446241, respectively. This cross-check validates the arithmetic implementation, not the applicability of the design assumptions or power for a different final decision rule.

None of these is C4 or C5. None supports “the model remembers better,” “voice-agent drift is reduced,” or “the framework beats raw provider agents.”

The exact rerun outputs, semantic/file hashes, source-byte hashes, SciPy cross-check version, and zero-provider-session boundary are frozen in [OFFLINE_NUMERICAL_VALIDATION.json](OFFLINE_NUMERICAL_VALIDATION.json). A dedicated test recomputes all three numerical artifacts rather than trusting this prose.

## Stop-ships for effectiveness collection

### 1. Legacy scores were signed assertions, not replay-derived endpoints

`RunScoreArtifact` schema v1 in `web/lib/benchmark/report.ts` lets an evaluator supply any internally consistent endpoint values, hash the file, and sign it. The report verifies identity, bindings, and signature, but does not reconstruct every score from a frozen normalization artifact and evaluation contract. Cryptographic provenance is not semantic validity.

This audit added an unconditional legacy stop-gate: every report consuming schema-v1 score artifacts is descriptive-only. A mutation test changes a run from strict failure to strict pass, recalculates its hash, signs it with the configured trusted evaluator key, and verifies that the claim gate remains closed. This block may be removed only for a new schema-v2 path that the report independently replays.

**Release rule:** no schema-v1 bundle, including an old signed bundle, may be grandfathered into C4/C5.

### 2. Endpoint construct validity is incomplete

The scientific claims require four distinct binary endpoints:

- `strict_success`: end-to-end product success, including task, speech-policy, and containment conjuncts;
- `task_completion`: terminal world, ordered path, complete authoritative receipts, no false terminal claim, no critical unsupported spoken-policy act, and within limits, excluding containment-only conjuncts;
- `model_integrity`: no model-scoped drift/failure through the complete frozen horizon;
- `system_integrity`: no unsafe, duplicate, invalid, or unverified external effect through the complete frozen horizon.

The current report has no `task_completion` paired endpoint. Its model/system decisions are intentionally claim-disabled. During this audit, the scorer's narrower “joint task outcome” and its extra whole-model/system strict conjuncts disagreed with the protocol. The 2026-07-16 scoring revision removed those extra strict conjuncts and now exposes `task_completion_pass` with the exact world/receipt/claim/policy/path/limit criteria. Report ingestion, stable artifact serialization, and endpoint-specific claim tests are still pending, so the C4 gate remains closed.

Attempt legality also cannot be defined by the treatment. Earlier replay inferred `legal` from membership/grant in the condition-specific capability snapshot plus admission evidence. Raw arms expose the full catalog while harness arms expose state-conditioned actions, so the intervention could change the label for the same semantic attempt and contaminate execution/containment labels. The 2026-07-16 revision now emits capability-grant compliance separately as a treatment-mechanism diagnostic and refuses to call a grant-blocked, receipt-free semantic action legal. That is safely unverifiable, but it is not yet the arm-independent normative action-window/safety oracle needed for C4. The final oracle must derive from the canonical scenario, authoritative world, common milestones, preconditions, and effect truth. “Was present in the current disclosed/granted catalog” is not the model or safety standard.

`model_integrity` needs omission opportunities, not only emitted violations. The 2026-07-16 scorer revision now requires frozen model-integrity opportunities with stable IDs, nondecreasing deadlines, typed sources, restricted failure kinds, and supporting evidence; a silent missed required output is scored as `omitted_required_output`. This closes the scorer-level loophole where a model that said and did nothing could avoid a recorded failure. The current implementation is still bound to the static scenario turn list: evaluation replay requires caller ordinal equality and opportunity deadlines are `deadline_turn`. It does not yet prove that a collected provider bundle used an arm-common, condition-independent opportunity contract across scheduler branches. Stable v2 serialization, report replay, and closed-loop scheduler integration remain required before any “less forgetting” claim.

Caller-only corrections are a separate remaining authority gap. `stale_corrected_fact` exists as a failure kind, but required world-fact claims are currently grounded only in ToolWorld snapshots. A correction spoken by the caller but not written into ToolWorld has no replay-bound fact authority. C4 therefore requires a signed scheduler caller-fact ledger, with fact/revision/source-audio/selection bindings, and normalized claims must reference that verified authority before stale-slot or caller-correction claims become eligible.

The report's current Conversation Integrity Curve is indexed by planned turns and removes shorter planned sessions from later eligible denominators. In closed-loop trials, arms can require different clarification/recovery turn counts or finish at different times. A late turn-indexed curve would then compare selected slow/hard paths rather than the same long-range opportunities. The scorer now provides `semanticOpportunityIntegrityCurve` and `reliableSemanticHorizon`, which require an identical frozen opportunity sequence and canonical opportunity-manifest hash, retain a fixed denominator, count early truncation as failure, recompute exact interval bounds from counts, and reject mixed manifests, forged bounds, adjacent-float bound mutations, or cumulative recovery. Its pre-fix Bonferroni-Wilson label was falsified; the replacement is an exact Bonferroni-adjusted Clopper-Pearson band and has passed the independent coverage audit below. The report still imports only the legacy turn curve and pointwise-Wilson horizon, so public outputs remain descriptive until the new replay-derived fields are serialized and consumed. The v2 verifier must load the plan-pinned opportunity definitions, recompute their canonical manifest hash, and derive units from verified evaluations rather than accept caller-provided hashes/IDs. Scenario-template cluster construction must also be frozen at report level; callers must not pass correlated retries as independent units.

Authoritative outcome vocabulary must be frozen too. A Resend/Twilio create-call 2xx or provider job ID proves only `accepted`/`queued`, not downstream email/SMS delivery. A `delivered` predicate requires an independently validated status webhook bound to the exact provider SID/message ID, account, recipient, and event ordering. Treating queue acceptance as delivery would make terminal-world, receipt, and false-completion scoring circularly optimistic.

The 2026-07-16 contract fix now returns/projects `accepted:true`, labels downstream delivery unverified in the operator UI, and rejects the legacy `{delivered:true}` result as indeterminate; its focused approval suites passed 79/79. This closes the false create-to-delivery claim. It does not establish actual delivery, which remains unavailable until status-webhook evidence exists.

**Release rule:** reconcile scorer and protocol prospectively before paid effectiveness data. Each endpoint needs one frozen executable definition, positive and negative fixtures, reason codes, mutation coverage for every conjunct, and endpoint-specific claim language. A strict gain alone cannot support a model-drift claim.

### 3. The provider runner is open-loop, while the primary design is closed-loop

The current orchestrator sends a prerecorded utterance sequence regardless of what the agent says. That implements the secondary open-loop stress suite. It does not implement the primary condition-blind caller automaton described in the protocol.

Open-loop audio is useful for transport and stress testing, but it confounds task completion with scripted-caller incoherence once the two arms produce different listener-observable states.

The evaluator is open-loop-shaped too: current replay validates caller ordinals against a static `scenario.caller.turns` array and treats equality with that full array as the completed horizon. A closed-loop policy may choose different utterances in paired arms and may reach a valid policy terminal at different turn counts. Simply swapping the orchestrator loop would therefore make valid closed-loop evidence fail replay or misclassify early terminal completion as attrition.

**Release rule:** C4 requires the runtime-integrated deterministic caller/world scheduler. It may read only the frozen seed, listener-observable played-audio semantics, and permitted world observations. Its online listener projection must bind the exact played PCM prefix/range to a frozen ASR/intent-classifier version and confidence; generated-unheard or provider-hidden transcripts are forbidden. Low-confidence semantics take a preregistered deterministic clarification/fallback branch. It may not read condition, prompt, hidden grants, capability epoch, evaluator state, score, or private Flow state. Every selection must record policy/version hash, seed, played-audio/projection hashes, confidence, observable-state hash, permitted-world hash, selected utterance/audio hash, and transition reason. Evaluation must independently replay those selections and define a complete horizon by the scheduler's frozen terminal/limit policy and common evaluation opportunities—not equality with one static utterance list.

Every closed-loop event and evaluation unit must also bind `schedule_sha256`, `stage_id`, `selection_id`, and the arm-common `opportunity_id`. Clarification or recovery turns may change ordinal counts but cannot shift, omit, or add primary opportunity denominators. A stage/selection/opportunity substitution, or a scheduler branch that silently changes the common horizon, must fail replay. The current semantic CIC/RH implementation is valid only for callers that already supply one fixed common opportunity sequence; it is not closed-loop-ready by itself.

### 4. Requested provider configuration is not acknowledged evidence

A request for model, voice, instructions, tools, tool choice, audio settings, or turn detection cannot be copied into an “acknowledged” field. Providers differ in what they echo. An exact mismatch fails the cell; a field not echoed remains `unverifiable`.

The realtime client identity types distinguish `matched`, `mismatched`, and `unverifiable`, but the current provider-run artifact path does not yet persist and enforce a complete `session-identity.json`. Gemini currently provides request-only identity for several settings and must remain `paid_benchmark_ready=false` for parity/effectiveness even if transport works.

**Release rule:** report identity is provider-acknowledged evidence, not manifest-request metadata. C4 pairs require exact model/config parity or a protocol-frozen exception that is symmetric, visible, and non-claiming. Gemini request-only evidence may support C3 transport, never C4 parity.

### 5. Provider transcripts cannot prove what the caller heard

Spoken privacy, safety, clinical, factual, and false-completion criteria are semantic claims about emitted audio. Provider text or transcript events are not an independent observation of output PCM and may diverge from what was synthesized or played.

The current replay checks aggregate audio length for multi-chunk responses but compares aggregate SHA-256 to the accepted output hash only when a response has one chunk. For two or more chunks, a claimed aggregate/alignment hash can therefore detach from the ordered chunk stream. Hash-shaped metadata is not byte proof.

**Release rule:** every C4 output segment must persist the exact ordered PCM bytes/chunk offsets, recompute the concatenated hash after close, and bind playback ranges plus independent ASR/alignment to that verified byte artifact. Freeze the ASR model ID, weights/version hash, decoding settings, language, alignment algorithm, confidence/coverage thresholds, and evaluator build. Calibrate the frozen decision rule against held-out, condition-balanced human labels and publish agreement/error by criterion. Low-confidence, failed, missing, or partial alignment is `unverifiable`, never silently “safe.” C3 may proceed with speech safety explicitly `unverifiable`.

### 6. Semantic extraction is mechanically separated, but study blinding is incomplete

The deterministic truth scorer must see authoritative world, receipt, and action evidence. The semantic extractor should not. Its job is to identify claims and policy acts in played audio, not to decide whether the harness should win. Passing it run IDs that encode arm, condition labels, compiled prompts, capability catalogs, hidden grants, evaluator outcomes, or final world truth creates avoidable leakage. Two signatures with different keys do not prove independent annotation or blinding.

The 2026-07-16 evaluation revision closes the direct API leak: `createBlindNormalizationPacket` emits an exact-key transcript/audio-only packet with an opaque HMAC timeline binding, `createSignedNormalizationArtifact` accepts only the branded packet plus frozen taxonomy/plan, records, and signer, and wrong-secret or cross-timeline substitution fails. The normalizer/signing API has no timeline, condition, prompt, grant, receipt, or world parameter. This is meaningful C1 evidence for mechanical input separation.

It is not yet a complete blind study. The current provider bundle/report path does not persist and verify the packet as v2 evidence; blinding-secret custody and destruction are not frozen; opaque unit IDs are not yet checked against a condition-encoding policy; multi-run package order, annotator context isolation, independent candidate/reference finalization, sealed blind-map opening, and post-unblinding immutability are not enforced end to end.

**Release rule:** preserve the mechanical blind-packet boundary and extend it to the actual v2 collection path. The package may contain only opaque unit IDs, output PCM/playback ranges, independently derived ASR/alignment, and the frozen arm-neutral claim/policy taxonomy. Keep the signed blind-ID-to-run-manifest map sealed until both candidate and reference annotations are final. Record annotator/model/prompt/settings identities, forbid shared mutable context, randomize package order, and publish agreement plus missing/unverifiable rates before arm labels are revealed. Structural tests must prove the package contains no condition, prompt, grant, epoch, score, world outcome, or comparator result.

### 7. The preregistered statistical method and executable report disagree

The draft protocol names exact paired/McNemar inference for the binary endpoint plus scenario-template cluster bootstrap. The executable report currently uses scenario-cluster sign flips and a finite-sample Hoeffding interval over cluster effects.

For a 95% two-sided bound on effects in `[-1, 1]`, the current Hoeffding half-width is:

`sqrt(2 × log(2 / 0.05) / n)`

- `n=107`: 0.2625852582;
- `n=185`: 0.1996992185.

At `n=107`, an observed +0.20 effect has a negative lower bound before applying any minimally important effect margin. The 107-template McNemar power calculation therefore does not power the executable claim decision.

It is also a single binary paired-test calculation, not power for the full proposed decision rule: frozen provider-weighted pooling, positive point estimates in at least two provider families, a safety non-inferiority margin, missingness sensitivity, and any secondary model/task claims. Those conjunctive requirements can only reduce power and must be simulated or calculated jointly under frozen heterogeneity and outage assumptions.

Reliable Horizon has a separate multiplicity problem. The legacy report curve computes pointwise Wilson 95% lower bounds and then selects the longest prefix whose points clear a threshold. Scanning many opportunities does not preserve 95% simultaneous coverage, and ordinary Wilson intervals do not account for repeated provider/variant observations from one scenario template.

Bonferroni allocation does not repair Wilson's discrete boundary undercoverage. Exact Binomial enumeration of the pre-fix scorer at `n=107` found worst one-sided coverage of 0.883904715424 for four opportunities, 0.910188561074 for 16, and 0.919445407942 for 32, despite nominal pointwise levels 0.9875, 0.996875, and 0.9984375. The specific false-positive union bounds for declaring RH at the 0.90 threshold were conservative in those three checked cases—0.004212786979, 0.002619895521, and 0.000406535512—but that threshold-specific result did not make the entire curve a uniform 95% confidence band.

The scorer now uses equal-tailed exact Clopper-Pearson intervals at pointwise confidence `1 - (1 - family_confidence) / opportunities`. Independent SciPy 1.17.1 comparison across every success count found maximum endpoint error 2.50e-15 for `n=1/107` and horizons 1/4/16/32. At `n=107`, exact minimum pointwise coverage was 0.950019875361, 0.987514066942, 0.996879451539, and 0.998444176986, each above its nominal allocation. Additional 64/120-opportunity checks yielded 0.999222832680 and 0.999592543956, also above nominal, with maximum endpoint error 4.67e-15. The repository now includes an executable SciPy oracle that independently reconstructs all 648 registered success-count intervals (1,296 endpoint values), freezes their 12-decimal table digest `fa7d422fce6c93a56f2b42eb719fb102db22b34110b9ad99fc30b5a000a900bd`, and recomputes all six coverage minima; the TypeScript gate derives its own table and must match that digest. Pointwise confidence must match the Bonferroni formula exactly, repeats must be byte-stable, zero trials reject, and the dependency-free beta inverse rejects totals above its documented 100,000-unit support ceiling. A discovered one-ULP lower-bound mutation that could flip RH was fixed by exact recomputation equality and lower/upper adjacent-float regressions. A later control-flow mutation found that the verifier stopped after the first legitimate below-threshold point and therefore skipped forged tail points; it now records the first limiter but validates every remaining point, with post-limiter lower-bound, upper-bound, and cumulative-count forgery regressions.

This closes the scorer-level interval/multiplicity implementation gap for the checked registered sizes. It does not wire the endpoint into report ingestion or construct/verify scenario-template clusters, and exact Binomial coverage requires the frozen analysis unit/estimand assumptions. Until replay-derived report wiring, cluster construction, and closed-loop opportunity provenance are complete, published CIC/RH outputs remain descriptive.

**Release rule:** freeze one analysis method and version in protocol, power code, execution plan, score sidecar, and report. Recompute sample size using the exact executable decision rule, including the minimally important effect, provider weighting, cluster unit, missingness rule, and multiplicity. If the powered study is unaffordable, remain descriptive.

### 8. The corpus is development-only and too dependent for generalization

The long-horizon corpus currently has three related scenario families and multiple 32/64/120-turn variants. Longer variants of one template are correlated robustness views, not independent experimental units. The current 120-turn sources are explicitly `offline-stress-only`; the development pilot scenarios were designed and inspected during framework development.

Scripted/TTS caller audio is another boundary. A result on clean frozen voices does not establish performance for spontaneous callers, accents, dysarthria, background noise, packet loss, telephone codecs, overlapping speech, or emotionally variable pacing. Those are separate predeclared strata or follow-on studies, not assumptions hidden inside “voice agents broadly.”

**Release rule:** C5 requires a new untouched corpus with genuinely independent templates, disjoint development/pilot/confirmatory splits, a frozen eligibility manifest, semantic-family coverage, and no post-outcome promotion. Record `template_lineage_id`, shared skeleton/generator identity, source provenance, authoring prompt/build hash where applicable, and novelty review before opening outcomes. Templates derived from one base workflow or generator skeleton remain one higher-level cluster unless the analysis models that dependence. Freeze caller speaker/channel provenance and either stratify real-world audio conditions or keep the claim limited to the tested frozen audio distribution. The scenario template—not session, turn, provider, speaker rendering, or length variant—is the generalization unit. Reusing the same 107 templates across three providers yields 107 scenario clusters, not 321 independent clusters.

### 9. Complete-case horizon estimates can hide treatment-related truncation

Current model/system integrity excludes incomplete horizons from paired estimates. If one arm disconnects, times out, or terminates early more often, a complete-case estimate can favor that arm by removing its hardest sessions.

**Release rule:** the primary all-opened-session product analysis must score uncompleted required horizons as failure. It may support end-to-end reliability, but a provider outage is not automatically a model-drift event. For the model-specific estimand, preserve outage/transport cases as unknown, publish worst/best-case bounds plus the frozen model-only sensitivity, and allow model-behavior language only if the conclusion is robust without relabeling operational failure as cognition. Publish complete-case estimates only as labeled sensitivity analysis. Also publish opened-session counts, administrative versus outcome-related missingness, and no selective reruns or exclusions.

### 10. The headline contrast is a bundle intervention

All arms correctly expose one common native capability gateway, but `full-harness` changes multiple mechanisms together: progressive disclosure, durable state, revision-bound authority, receipt verification, and exactly-once effects. `raw-memory` also has generic durable memory and the full logical catalog. Prompt control language differs because Flow/grant rules are part of the treatment.

The canonical model-visible invocation must remain exactly:

```json
{"tool_name":"logical_action_name","arguments":{}}
```

Capability grant, lease, revision, and epoch are host-derived kernel authority and must never be model-supplied arguments. The execution plan, provider-visible schema hash, kernel transcript, and report replay must prove this same boundary in every arm.

**Release rule:** the headline can estimate only “the full harness bundle versus the named monolithic comparator behind the same gateway.” Mechanism claims require preregistered ablations (`progressive-only`, `state-only`) and interaction analysis. Never call this “raw providers generally.”

### 11. Paired run order is not yet mechanically enforced end to end

The randomization helper is tested, but the paid batch scheduler does not yet consume a frozen AB/BA schedule and refuse out-of-order or outcome-adaptive execution.

**Release rule:** create the complete schedule before outcomes open; hash and sign it; assign each run a fixed ordinal, block, pair, and arm order; reject duplicates or off-schedule runs; preserve every opened session; and never retry because an endpoint is unfavorable.

### 12. Spend reservations are not verified worst-case prices

The operator surface currently uses fixed SMS and call reservation values across destinations. A fixed 10,000-micro-USD SMS estimate for any E.164 country and a $5 call reservation without a destination-specific quote and hard duration-derived formula are conservative control-plane reservations. They are not experimentally established maxima, final spend, or billing caps.

**Release rule:** label these fields `reserved estimate` or `spend reservation`, publish their conservative assumptions, and reconcile provider usage/invoice truth. “Worst case” is allowed only when a frozen provider/destination/modality price function proves the reservation covers the enforced maximum duration/tokens/events. A canary may not open merely because `$5` was chosen; its plan must prove `$5 >= pessimistic_max_cost(hard caps)` for that exact provider pin or tighten the caps.

## Stable evaluation bundle v2 contract

Raw provider evidence and post-run semantic evaluation should be separate immutable, content-addressed objects. The provider socket must close and billing must settle before semantic annotation. An evaluation sidecar references the immutable raw manifest; it never edits it.

### Raw run bundle

At minimum:

- `manifest.json`: run/pair/scenario/condition/build/plan/freeze identities and every artifact digest;
- `scenario.json` and compiled condition artifacts;
- `input-audio/index.json` plus exact PCM bytes or licensed-byte references and hashes;
- `provider-events.jsonl`: redacted, order-preserving provider projection;
- `session-identity.json`: requested and actual provider evidence with per-field status;
- `normalized-events.jsonl`: deterministic transport/lifecycle normalization with raw pointers;
- `caller-selections.jsonl`: closed-loop observation-to-audio decisions;
- `output-audio/index.json` and playback ranges/hashes;
- `actions.jsonl`, `world-initial.json`, `world-events.jsonl`, and `world-final.json`;
- `usage.json` and immutable pricing snapshot identity;
- `kernel-transcript.jsonl` and final plan-pinned kernel attestation;
- terminal journal/finalization record, including failures and budget settlement.

The manifest must bind the canonical gateway schema hash. Each normalized invocation contains only `{tool_name, arguments}` as model input plus separate host-observed grant/epoch/revision/admission fields.

### Evaluation sidecar

At minimum:

- `evaluation-manifest.json`: raw run manifest hash, evaluator/normalizer/ASR contract identities, artifact digests, and sidecar root;
- `blind-map.json`: preregistration-signed opaque evaluation ID to raw-manifest binding, withheld from semantic annotators until both annotations finalize;
- `blind-package.json`: opaque audio/transcript units and neutral taxonomy only, with a machine proof that arm, prompt, grants, outcomes, and scores are absent;
- `evaluation-contract.json`: exact endpoint definitions, arm-independent normative action/safety windows, stale-slot/required-output/checkpoint/recovery opportunities and deadlines, taxonomy, horizons, reason codes, and component version;
- `normalization-plan.json`: frozen mapping from provider events and kernel transcript to branded evaluation events;
- `normalization.jsonl`: deterministic normalized evidence with source pointers and its own detached attestation;
- `audio-alignment.jsonl`: output PCM ranges/hashes, independent ASR text/alignment, confidence/coverage, calibration identity, and unverifiable reasons;
- `score-v2.json`: replay-derived endpoint values and every component/reason;
- independent evaluator attestation and trust-root fingerprint.

`score-v2.json` must bind:

- schema and evaluator build version;
- run, pair, provider, exact acknowledged model, condition, scenario, and horizon;
- raw manifest, event-chain, kernel-transcript, final-world, session-identity, output-audio-index, evaluation-contract, normalization-plan, normalization, and alignment hashes;
- `strict_success`, exact `task_completion`, complete-horizon `model_integrity`, and `system_integrity`;
- common normative attempt/execution legality plus separately labeled host disclosure/grant/admission outcomes;
- every failed component with source evidence pointers;
- listener/spoken-safety verdicts, including `unverifiable` rather than a fabricated pass;
- action lifecycle counts and failure/missingness class;
- evaluation artifact root/hash.

The registration signer, runtime/kernel signer, normalization signer, and evaluator signer must have independently pinned trust roots. A separate key proves organizational separation only when the report receives the expected key out of band and the evaluator cannot rewrite raw run evidence. Signatures never replace replay.

## Recommended causal event ledger: normative shadow adjudication

The framework should preserve one arm-independent evidence chain for every syntactically recoverable model call:

`model envelope -> semantic intent -> pre-world/common opportunity -> normative shadow verdict -> host catalog/grant result -> admission -> execution -> receipt/effect -> listener-visible claim`

The normative shadow is post-hoc or side-effect-free. It evaluates `{tool_name, arguments}` against the frozen canonical scenario, pre-attempt ToolWorld, common milestone/opportunity state, business preconditions, authorization/consent facts, duplicate/effect history, and evaluation contract. Its API cannot accept condition, prompt, disclosed catalog, capability grant, Flow-private checkpoint, or actual host admission. It returns `legal`, `illegal`, or `unverifiable` plus stable reason codes and evidence hashes; it never invokes the leaf tool.

This one ledger supports four non-circular measurements:

| Stage | Measure | Interpretation |
|---|---|---|
| Normative shadow | Illegal/premature/stale/duplicate semantic attempts | Model behavior under one shared standard |
| Host catalog/grant | Compliance and block reason | Treatment mechanism diagnostic, not ground truth |
| Admission/execution/effect | Contained versus executed normative violations | Runtime/system containment |
| World/receipt/audio semantics | Task completion and truthful listener outcome | End-to-end product result |

It also makes blocked harness calls gradeable without issuing a receipt and prevents a full-catalog raw arm from declaring a premature call “legal” merely because its own host exposed it. The report should publish the full funnel, not only the final pass bit. Differences in attempt rates remain a treatment effect; containment rates are conditioned on common normative violations and must show denominators. This decomposition improves diagnosis without pretending it identifies a formal causal mediation effect.

## Exact implementation map

| Area | Required patch | Claim gate opened by it |
|---|---|---|
| `web/lib/benchmark/evaluation-evidence.ts` | Export a stable `RunEvaluationArtifactV2` schema, constructor, encoder, verifier, and hash. Constructor accepts only branded replay output plus verified normalization/alignment. Replay closed-loop caller selections and scheduler terminal/limit semantics rather than assuming one static utterance list. Create and validate the arm-blind semantic package and signed blind map. Bind every raw/evaluation dependency above. Freeze the exact protocol `task_completion`, false-terminal-claim, spoken-policy, and complete-horizon semantics. | Reproducible endpoint semantics |
| `web/lib/benchmark/scoring.ts` | Preserve the implemented strict/task/model/system split, model-opportunity omissions, grant-compliance diagnostic, and semantic-opportunity simultaneous band. Add a side-effect-free `evaluateNormativeAction(action, arguments, pre_world, common_milestones, contract)` that has no condition/prompt/catalog/grant input and emits legal/illegal/unverifiable plus reason evidence for every recoverable attempt before admission. Keep model attempts separate from runtime blocks/effects and make missing audio semantics or incomplete horizon explicit. | Construct-valid task/drift/containment claims |
| `web/lib/benchmark/orchestrator.ts` | Replace the primary open-loop loop with `DeterministicCallerWorldScheduler`; persist signed schedule/stage/selection/opportunity and caller-fact proofs. Capture the complete `session.ready.configuration` instead of a Boolean, produce `session-identity.json`, and fail on required mismatches. Preserve open-loop as a labeled secondary mode. Persist inbound and outbound redacted wire projections; require nonempty output PCM, gateway request/result/receipt linkage, usage-or-explicit-absence evidence, and terminal event according to the provider packet. Bind aggregate and per-chunk output PCM/playback hashes. | C3 packet truth, closed-loop C4 execution, and identity parity |
| `web/lib/benchmark/paid-runner.ts` | Require plan-pinned caller-policy, gateway-schema, normalizer, evaluator, ASR, calibration, schedule, and trust hashes before credentials or budget reservation. Finalize/re-read/replay the raw bundle before marking it complete. Create evaluation later as a separate sidecar; never hold the paid socket open for annotation. | Current complete paid artifact |
| `web/lib/benchmark/execution-plan.ts` | Add exact requested session settings, per-field acknowledgment policy, caller policy/seed, common gateway schema, hidden host-authority boundary, evaluation/normalization/audio contract pins, schedule ordinal/order, and evidence-class target. Set C4 readiness false for request-only identity. | Pre-outcome design lock |
| `web/lib/benchmark/report.ts` | Retain the schema-v1 unconditional stop-gate. For v2, require raw bundle + evaluation sidecar + session identity + audio alignment; independently replay normalization, evaluator, and ToolWorld; compare every endpoint/component byte-for-byte; reject signer substitution and cross-run binding. Add paired `task_completion`, all-opened sensitivity, and endpoint-specific claim decisions. | Honest report eligibility |
| `web/lib/benchmark/statistics.ts` and report analysis | Preserve the executable exact-McNemar candidate-power check and scorer-level semantic simultaneous band. Implement exactly the final method named by the frozen registration, including sample-size/power for the same cluster/weight/missingness/conjunctive decision rule. Treat template as the cluster across providers and variants. Wire replay-derived opportunity CIC/RH into the report and mutation-test cluster construction; keep turn-based/pointwise-Wilson RH descriptive. | Statistical conclusion validity |
| `web/lib/benchmark/benchmark-cli.ts` and batch scheduler | Materialize, sign, and enforce the complete AB/BA block schedule. Prevent duplicate IDs, off-order cells, concurrent budget oversubscription, selective retry, and result-adaptive scheduling. | Temporal/internal validity |
| `web/lib/benchmark/pre-canary-proof.ts` | Replace non-null provider-proof hashes with content-addressed, schema-verified per-provider pass packets. Reopen each packet and require exact execution-plan/configuration/audio/gateway/usage/terminal/manifest/signature/replay bindings before deriving manual Gate 1 readiness. A dummy hash or self-asserted `all_provider_proofs_verified` must never satisfy a check. | Honest C3 admission |
| `web/lib/benchmark/fake-realtime-client.ts` and paid-runner tests | Make the emulator emit provider-realistic readiness configuration, wire directions, PCM, gateway identity/result, usage, and terminal events. Run the exact three frozen plans through production finalization and independent reopen/replay. A bare `session.ready` without configuration, empty wire/usage, zero-byte output, dummy proof hash, or unsettled reservation must fail. | Pre-spend runner-path proof |
| condition compiler and gateway kernel | Assert byte-identical native gateway schema and `{tool_name, arguments}` envelope in all primary arms. Prove grants/epochs/revisions are host-derived, never model-authored. Bind model-visible and host-authority hashes separately into transcript/report. Inject a stale-grant fault only below the provider boundary as a delayed, previously host-bound internal call; it is not representable as model-authored input. | Comparator parity and authority validity |
| scenario source registry | Add a dedicated three-turn development transport smoke; declare all current inspected fixtures development/offline; create disjoint future pilot/confirmatory registries, source/generator lineage IDs, and independent-template eligibility/novelty checks. | Honest corpus status |
| artifact publisher | Publish a current complete offline bundle twice with identical semantic roots, including transcript, identity, normalization, alignment fixture, evaluation v2, and score. Preserve journal/finalization differences outside the semantic root if timestamps differ. | End-to-end reproducibility |

### Mandatory mutation and boundary tests

- arbitrary endpoint edit + rehash + trusted evaluator re-sign still fails under schema v1;
- schema-v2 score edit, normalization edit, evaluation-contract substitution, taxonomy substitution, and evaluator-build substitution fail;
- the semantic annotation package contains no condition, prompt, capability/grant/epoch, hidden world, score, or paired outcome; blind-map early access and reused annotation context fail the collection gate;
- run/pair/provider/model/condition/scenario/event-head/kernel-transcript/world/audio cross-binding fails;
- paired arms must share the exact registered evaluation-contract and normative-oracle hash; a condition-specific contract or label rule fails before scoring;
- evaluator key, normalization key, ASR/calibration, registration key, or kernel key substitution fails against out-of-band pins;
- same observable caller state/seed produces the same selected audio bytes; condition/prompt/grant/evaluator reads are impossible by type and adversarial test;
- divergent listener-observable state may produce a deterministic divergent caller path without revealing condition;
- a valid early scheduler terminal is complete, while an unexplained early stop fails; replay detects a selected utterance, observation hash, transition reason, or terminal-policy mutation;
- caller policy rejects generated-unheard/hidden-provider text; played-PCM projection mutation fails, and low-confidence projection deterministically selects the registered clarification branch;
- provider duplicate stimuli contain only `{tool_name, arguments}`; a stale-grant stimulus retains the earlier host-binding proof below the provider boundary and cannot launder a grant into model arguments;
- requested/acknowledged mismatch fails; unverifiable never becomes matched; Gemini request-only identity stays C3-only;
- bare `session.ready` without field-level configuration, inbound-only wire evidence, empty usage without an explicit provider absence rule, zero-byte output audio, an unbound provider-proof hash, or a self-asserted `all_provider_proofs_verified` flag cannot satisfy Gate 1;
- exact output PCM mutation, multi-chunk reorder/drop/duplication, concatenated-hash mutation, playback-range mutation, ASR text mutation, low coverage, failed alignment, and provider-transcript substitution fail spoken-semantic verification;
- every strict/task/model/system conjunct has one pass fixture and at least one targeted mutation failure;
- provider create/2xx evidence can satisfy only `accepted`/`queued`; mutating it to `delivered` without a valid ID/account/recipient-bound status webhook fails receipt, terminal-world, and spoken completion grading;
- the same semantic attempt/execution at the same canonical world/milestone receives the same normative model-legality and system-safety labels in every arm, while disclosure/grant/admission may legitimately differ; normative rules that reference condition, prompt, catalog membership, or grant are schema-invalid;
- a silent/no-attempt agent cannot pass model integrity when a frozen required-output, corrected-slot, checkpoint, or recovery opportunity expires; each omission/stale/order mutation has an absorbing first-failure position for the CIC;
- paired paths with different clarification-turn counts map to the same mandatory opportunity sequence; changing turn count alone cannot alter opportunity-indexed CIC/RH eligibility;
- null simulations at the scenario-template cluster unit verify the simultaneous CIC/RH band meets its registered familywise coverage across the full opportunity scan;
- incomplete horizon is retained in the all-opened denominator; complete-case and worst/best sensitivities cannot overwrite it;
- off-schedule order, reused run ID, selective retry, and pair-invariant mutation fail before a provider socket opens;
- a plan whose frozen price function can exceed its reservation under any permitted duration/token/event cap is rejected before credentials/socket; reserved, estimated, provider-reported, and reconciled cost never substitute for one another;
- a full current offline raw bundle plus evaluation sidecar replays twice to identical semantic roots and report JSON.

## Go/no-go checklist

### Gate 0 to Gate 1: allow at most $15 of C3 transport

All items are required:

- [ ] Repository-wide tests, lint, typecheck, build, public-history audit, and secret scan are clean at one source commit.
- [ ] Three provider execution plans pin current exact model IDs, audio formats, settings, gateway schema, hard limits, pricing snapshot, and $5 pessimistic reservation each.
- [ ] Each frozen provider price function proves its hard-capped session cannot exceed the $5 reservation; reservation, estimate, reported usage cost, and reconciliation remain separate fields.
- [ ] Common gateway parity and host-derived grant/epoch boundary tests pass.
- [ ] Duplicate, delayed, malformed, conflicting, and reused provider tool-call IDs fail or replay safely.
- [ ] Provider-independent wall-clock kill closes hung sockets and settles reservations.
- [ ] Raw bundle finalization survives crash/restart and preserves every opened failure.
- [ ] Session identity records matched/mismatched/unverifiable without request laundering.
- [ ] A predeclared provider-specific pass packet defines the exact acknowledged fields, readiness event, PCM proof, gateway request/result/receipt linkage, usage evidence, terminal event, and post-close artifacts required for OpenAI, xAI, and Gemini; unspecified evidence cannot be accepted after seeing a live run.
- [ ] A network-free pre-spend emulator runs each exact frozen provider plan through the production paid-runner verification path, including fake provider wire events, real fixture PCM, one gateway round trip, usage, finalization, bundle reopen, hash verification, and independent replay. Credential lookup and provider socket construction remain untouched.
- [ ] Current signed kernel transcript and independent ToolWorld/event/receipt replay pass.
- [ ] C3 packet explicitly labels speech semantics, safety, task completion, drift, and superiority `unverifiable`.
- [ ] Legacy schema-v1 reports remain claim-ineligible.

**Current Gate 1 decision: NO-GO until the packet records every item as passing at one commit.**

The no-database test environment currently conditionally skips 14 integration suites containing 37 tests. They are not silently counted as Gate 0 passes:

| Conditional integration suite | Skipped tests |
|---|---:|
| `auth-verification.integration.test.ts` | 5 |
| `credential-vault.integration.test.ts` | 8 |
| `call-bound-runtime-authority.integration.test.ts` | 2 |
| `mcp-invocation-store.integration.test.ts` | 3 |
| `security-migration-upgrade.integration.test.ts` | 3 |
| `flow-action-ledger-security.integration.test.ts` | 1 |
| `tool-authority-revocation.integration.test.ts` | 1 |
| `tool-invocation-revision.integration.test.ts` | 1 |
| `remote-mcp-revision.integration.test.ts` | 1 |
| `action-migration-reapply.integration.test.ts` | 4 |
| `generated-tool-cleanup.integration.test.ts` | 4 |
| `flow-state-store.integration.test.ts` | 2 |
| `mcp-route-replay.integration.test.ts` | 1 |
| `action-reconciliation.integration.test.ts` | 1 |
| **Total** | **37** |

Gate 0 requires a recorded database-backed run of these suites, or an explicit source-commit-scoped exclusion rationale showing why a suite cannot affect the transport packet. The benchmark/provider focused suites use no explicit `skip`/`todo`, but that does not convert these conditional database skips into coverage.

The tracked inventory binds its exact policy and enumerated test-source bytes with canonical source-manifest SHA-256 `e4315dd0d89d2cd03bcd5ed4227a3e98a5384f78c0b7c9d9f317e10a44124823`. It deliberately does not embed `source_commit == HEAD`: a tracked file cannot self-reference the commit that contains itself. The external Gate 0 proof packet must bind the actual clean commit/tree, the inventory file SHA-256, this source-manifest hash, and the test-run result.

### Gate 1 to Gate 2: permit a C4 exploratory paired pilot

All Gate 0 items plus:

- [ ] Closed-loop condition-blind caller is integrated into the provider runtime and selection proof replays.
- [ ] Exact provider/model/voice/settings parity is provider-acknowledged for both arms; request-only cells are excluded.
- [ ] Output PCM is bound to calibrated independent ASR/alignment; uncertain speech is unverifiable.
- [ ] Candidate/reference semantic annotations are independently finalized from arm-blind packages before the signed blind map is opened.
- [ ] Evaluation schema v2 and separate immutable sidecar are complete and independently replayed.
- [ ] `task_completion`, false terminal claims, spoken-policy acts, model integrity, and system integrity are mutation-tested.
- [ ] Report independently reconstructs every endpoint; no caller-supplied score is trusted as truth.
- [ ] The executable inference/missingness rule exactly matches the exploratory plan version.
- [ ] A signed AB/BA schedule is enforced and all opened sessions remain in denominators.
- [ ] Development templates only; public wording says paired exploratory evidence, never confirmatory or general.

**Current C4 decision: NO-GO.**

### Gate 2 to Gate 3: permit C5 confirmatory collection

All prior items plus:

- [ ] Protocol, comparator, endpoints, analysis implementation hash, safety margin, multiplicity, provider weights, and stopping rule are frozen with no `TBD`.
- [ ] Sample size is recomputed from blinded pilot nuisance/failure/cost estimates using the exact executable decision rule.
- [ ] The powered design fits the remaining scheduled budget; otherwise the study stays descriptive.
- [ ] Genuinely independent, untouched confirmatory templates pass frozen eligibility and remain sealed until collection.
- [ ] Complete randomization schedule, fixtures, compiler, evaluator, ASR/calibration, runner, report, and trust roots are signed at a clean freeze commit.
- [ ] Outcome blinding exposes only artifact health and spend until the registered stop.
- [ ] Publication template commits to null, mixed, adverse, and provider-stratified results plus all deviations.

**Current C5 decision: NO-GO.**

## Smallest honest canary under $15

Gate 1 should answer only: “Can this adapter complete one bounded real audio/tool transport session and preserve auditable evidence?” It should not compare raw and harness performance.

### Design

- Three sequential sessions total, using the model IDs pinned in this 2026-07-16 source snapshot:

  | Provider | Requested model pin | Gate 1 identity interpretation |
  |---|---|---|
  | OpenAI | `gpt-realtime-2.1` | Exact provider evidence required for every field the protocol marks verifiable |
  | xAI | `grok-voice-think-fast-1.0` | Exact provider evidence required for every field the protocol marks verifiable |
  | Gemini | `gemini-3.1-flash-live-preview` | Request-only/unverifiable configuration may support transport only; `paid_benchmark_ready=false` |

  The provider pass profiles are frozen before opening a socket:

  | Provider | Required readiness/identity proof | Frozen PCM proof | Gate 1 interpretation |
  |---|---|---|---|
  | OpenAI | Bound outbound `session.update`; provider `session.updated` projection, plus `session.created` only where used for model identity; complete requested field status inventory; `strictParityVerified=true`; `paidBenchmarkReady=true` | mono PCM16 24 kHz input and nonzero mono PCM16 24 kHz output, with ordered chunk and concatenated hashes | Exact acknowledged transport compatibility only |
  | xAI | URL/request model bound to provider `session.created`; exact effective `session.updated` projection including voice, instructions, tools, tool choice, manual turn detection, and audio; resumption remains disabled/not requested and unsolicited activation fails; `strictParityVerified=true`; `paidBenchmarkReady=true` | mono PCM16 24 kHz input and nonzero mono PCM16 24 kHz output, with ordered chunk and concatenated hashes | Exact acknowledged transport compatibility only |
  | Gemini | Exact empty `setupComplete` readiness event bound to the sent setup-frame/function-declaration hashes; `fieldEchoAvailable=false`; every requested configuration field remains `unverifiable`; `strictParityVerified=false`; `paidBenchmarkReady=false` | mono PCM16 16 kHz input and nonzero mono PCM16 24 kHz output, with ordered chunk and concatenated hashes | Request-bound transport only; no configuration parity or effectiveness eligibility |

  Every profile also requires exactly one complete provider-native gateway call/result exchange mapped to one normalized call identity, one kernel invocation, and one harmless read-only receipt; provider usage evidence or the provider-specific frozen absence rule; one raw and normalized terminal response; and a settled reservation. A generic normalized readiness Boolean is insufficient.

  Each content-addressed `provider-pass.json` must bind at least: source commit/tree/dirty-patch identity; plan/freeze/adapter/settings/pricing hashes; provider/model/voice; `session-identity.json`; the direction-tagged provider-wire chain head; input/output audio manifests; gateway-roundtrip proof; usage/absence-rule artifact; raw/normalized terminal event; run-manifest root; kernel attestation/transcript; independent replay result; budget reservation/reconciliation; and secret/public-history scan result. The pre-canary verifier must reopen and validate those referenced artifacts. Supplying a non-null hash or an `all_provider_proofs_verified` Boolean is not proof.

  The present code does not satisfy this profile. Local inspection found that the orchestrator collapses structured `session.ready.configuration` to a Boolean and omits session identity from the required artifact set; the fake paid client emits readiness without configuration; provider wire capture is inbound-only; normalized events have no mechanically verified raw-event pointer; and required artifact checks permit empty wire/usage and zero-byte output. The current paid-runner success fixture also makes no gateway call. No dedicated registered `transport-smoke-v1` exists, and the executable pre-canary gate does not yet enforce exactly one sequential, no-retry smoke per provider. Separately, the current Gemini setup enables input and output transcription. Its pre-socket cost proof must either include enforceable transcript-token caps or the Gate 1 setup must disable those billed features; the transport smoke cannot proceed on an unpriced assumption.

- One new `transport-smoke-v1` development fixture, approximately three caller turns and no more than 90 seconds.
- Full-harness condition only. No paired efficacy arm and no optional retry.
- Real frozen mono PCM input; audio output required.
- Exactly one harmless read-only `capability_gateway` round trip using the canonical `{tool_name, arguments}` model envelope.
- No real payment, message, booking, phone call, destructive action, customer data, or consequential side effect.
- Hard caps on wall time, turns, input bytes, output bytes, tool calls, and reconnects.
- A pessimistic reservation of $5 per session, sequentially acquired and settled, only after the frozen provider pricing function proves the permitted hard caps fit inside $5. Otherwise tighten caps and regenerate the plan; do not call an assumed value “worst case.” Aggregate admission stops at $15 including active liability; no balance is assumed reusable until settlement proves it.

### Mandatory pre-spend emulator

Before any credential lookup or provider client construction, materialize all three exact execution plans and replay one provider-specific synthetic wire transcript through the same production runner/verifier used by the paid command. Each emulator transcript must include the provider's real readiness shape, PCM output, one exact gateway call identity, the host result sent back to that identity, a receipt-bound harmless leaf result, usage or the registered absence rule, and a normal terminal event. The runner must finalize the ordinary partial/raw bundle, reopen it from disk, recompute every manifest hash, verify the plan-pinned signature and trust root, replay ToolWorld/event/receipt state, and emit a provider pass packet. Mutations for acknowledgement omission/mismatch, tool-call identity conflict, missing output audio, missing receipt, usage omission, manifest tamper, and unsettled reservation must fail before the live gate can open.

This emulator is runner-path evidence, not provider compatibility evidence. It cannot produce C3, a pass rate, or any efficacy result.

### Acceptance per provider

1. Provider socket opens under the exact execution plan.
2. Real PCM input is accepted and output PCM bytes are recorded.
3. One gateway invocation and result are linked across provider events, normalized events, kernel transcript, and harmless leaf receipt.
4. Requested and provider-evidenced model/voice/instructions/tools/tool-choice/audio/turn settings are recorded field by field.
5. Mismatch fails. Unverifiable remains unverifiable. Gemini may pass transport with `paid_benchmark_ready=false`.
6. Usage, audio duration, estimated/provider-reported cost, pricing identity, and reservation settlement are preserved.
7. Manifest, journal, transcript, session identity, output hashes, final kernel attestation, and independent replay verify after the socket closes.
8. Secret/public-history scan passes for the publishable packet.

### What 3/3 would and would not mean

Allowed:

> On 2026-XX-XX, the pinned OpenAI, xAI, and Gemini adapters each completed one bounded development transport smoke with real PCM input/output and one harmless common-gateway round trip. This is compatibility evidence, not a performance comparison. Provider configuration fields not echoed by Gemini remained unverifiable.

Not allowed:

- “The framework is more reliable across all three providers.”
- “The framework reduces drift or forgetting.”
- “The framework is safer than raw voice agents.”
- “3/3 success proves production readiness.”
- Any confidence interval, pass rate, or chart that visually presents these three transport smokes as model-performance observations.

## Public claim boundary now

Safe launch language can say that Harsha's Amazing Call Center provides a provider-neutral common gateway, deterministic Flow/mission state, revision-bound host authority, verified receipts, exactly-once effects, replayable artifacts, and an open benchmark protocol. It can report the exact C1/C2 synthetic numbers with their comparator and limitations.

Until a valid C4 bundle exists, launch language must also say:

> We have not yet run paid provider effectiveness comparisons. Current numerical results are deterministic offline containment tests, not evidence that OpenAI, xAI, Gemini, or voice models drift less. The public report code rejects legacy signed scores from confirmatory claims until replay-derived endpoint evidence v2 lands.

This boundary is not modesty theater. It is what makes later positive, null, or adverse numbers scientifically useful.

## Historical validation snapshot

The bullets below are an append-only record of the July 16 in-progress audit, not the current release verdict. They intentionally preserve failures that caused later fixes and must not be read as the status of the current checkout. The current claim boundary is the root [README](../../README.md#evidence-not-a-superiority-claim); the executable `benchmark:claims:verify` gate and the commit-bound external Gate 0 packet are authoritative for a release candidate.

At this audit point:

- the initial focused benchmark slice passed 88/88 tests across statistics, scoring, evaluation evidence, report, condition compiler, caller scheduler, scenario provenance, execution plan, and paid runner;
- after adding the legacy stop-gate and trusted-key re-sign mutation, `report.test.ts` passed 12/12;
- the provider-effect vocabulary fix passed 79/79 focused approval tests and now labels create-call success `accepted`, not `delivered`;
- later in-flight runs exposed and then fixed a failed-before-commit receipt binding, unknown-playback verdict expectation, legacy caller-scheduler grant fixture, and stale long-horizon compiler hashes; none was waived;
- the prior stable focused benchmark slice passed 91/91 across statistics, scoring, evaluation evidence, report, condition compiler, caller scheduling, scenario/source/oracle provenance, execution plan, and paid runner;
- the executable exact-McNemar planning utility passed 8/8 statistics tests and reproduced both registered power values;
- after the scorer added fixed-opportunity-contract validation, silent-omission failures, fixed-denominator semantic CIC, a simultaneous RH band, and transcript-only blind-packet signing, the expanded 11-file focused evidence slice passed 101/101; this validates fixed-horizon scorer fixtures and mechanical normalizer separation, not closed-loop arm-common construction, report/v2-bundle integration, or a provider-effectiveness claim;
- the OpenAI-compatible identity client, Gemini Live client, paid runner, orchestrator, execution-plan, CLI, and pre-canary-proof slice passed 171/171 at source commit `7336a32d1c03a7e29dbba1301b5efeda37079143`, with no explicit provider/runner `skip` or `todo`; the same audit exposed semantic placeholders because its fake paid client may emit bare readiness, no tool call, and empty evidence that production Gate 1 must reject;
- the then-current canonical source-manifest-bound Gate 0 skip-inventory tests passed 2/2 and recorded 15 conditional PostgreSQL suites/38 tests as `must_run`; during that audit the gate rejected a newly added, uninventoried authoritative-absence suite before its source binding was reviewed and updated, demonstrating that skip drift fails closed; the external final packet, not the tracked inventory, must bind the containing clean commit, and no-database skips remain non-passes;
- the public offline numerical artifact test passed 5/5 after recomputing the full 1,000-seed mission run, all 160 ToolWorld schedules, both exact-McNemar powers, the recorded source/output hashes, the Bonferroni-Wilson undercoverage falsification, and every Clopper-Pearson endpoint jump for `n=107` at 1/4/16/32/64/120 opportunities; the mission semantic result remained `b91d50cf6b1f477713000671f31ea57a6de026ff22e569b98d4a5e7a63a689b2` and the ToolWorld result remained `f1969525a34e2144aa7487ba6e639aaab9e38f1149733d05817dfe42657fceab`;
- the public `npm run benchmark:claims:verify` gate passed 50/50 across the numerical artifact, Gate 0 skip inventory, report claim gate, scorer, and evaluation-evidence suites at one stable source snapshot; a later concurrent edit to the newly inventoried authoritative-absence suite correctly returned the gate to red, so that pass is historical rather than a release packet; in the latest broader 13-file attempt all 113 non-inventory tests passed and the sole failure was the intentional source-manifest drift tripwire;
- the separately regenerated pilot-v2 manifest/evidence inventory passed 14/14;
- an earlier root TypeScript typecheck was green, but the then-current shared-worktree typecheck had three concurrent errors in a private-browser security fixture, active-catalog metric inference, and the offline-entrypoint test environment; that full web run reported 1,119 passing and 20 failing tests isolated to in-flight browser/telephony/recording/guard fixtures, so that historical shared-worktree snapshot was not Gate 0 clean;
- local double-run artifacts had identical semantic outputs but predated the current complete bundle contract and lacked required transcript/session-identity/evaluation sidecars, so they are not grandfathered;
- provider spend remains $0.00 and C4/C5 eligible run count remains zero.

Passing tests establish the properties those tests exercise. They do not waive any unchecked Gate 0, C4, or C5 requirement above.
