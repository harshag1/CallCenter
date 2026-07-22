# HACC LC4 provider-control stress diagnostic v1

Status: core implementation complete, provider-free validated, no live result
or provider-limit claim yet.

This is a **separate diagnostic**, not a qualification gate and not an efficacy
benchmark. It asks a narrow question: for one exact provider/model/arm, what
happens when the realtime response-control material grows from one compact,
complete semantic checkpoint through meaningful 2 KiB and 8 KiB requests to
the largest request constructible from the current retained controls?

The implementation is
`web/lib/benchmark/lc4-control-stress-diagnostic.ts`.

## Why it is separate

Basic transport qualification should prove that the exact model, audio route,
gateway call path, usage capture, and terminal evidence work. A provider can
pass that gate while declining to echo an exact per-response instruction hash.
Conversely, a large-control experiment can fail after a healthy transport
session. Mixing the two would turn an exploratory provider limit into a false
transport failure.

Every plan and result therefore freezes:

- `basic_transport_qualification_impact: "none"`;
- `provider_parity_claim_allowed: false`;
- the diagnostic-only claim boundary;
- one attempt and one response generation per scheduled cell; and
- `paid_retry_allowed: false` / `paid_retry_count: 0`.

No control-stress result may qualify a provider, disqualify a provider from the
ordinary LC4 run, supply an LC4 outcome score, or establish provider parity.

## Admissible source material

A source is not an arbitrary string plus a claimed hash. It must be a complete
`control_authority` reference emitted by the production LC4 replay-evidence
store:

1. the CAS object is reopened by its SHA-256;
2. its bytes must be exactly
   `harshas-amazing-call-center/lc4-dev-control-receipt/v1\n` followed by
   canonical JSON;
3. the complete production receipt field set and all state/evidence hashes are
   checked;
4. provider, arm, episode, and opportunity identity must match the frozen
   source inventory;
5. Native controls must contain exact instructions whose retained hash
   recomputes; and
6. HACC controls must pass `assertHaccResponsePlan` and are rendered by the
   production `renderHaccResponsePlan` function.

The complete retained live ledger is also replayed from genesis through its
head. Each source must be attached to its exact `audio_submitted` event, and
provider/model/arm are derived from that episode's CAS-backed `episode_opened`
payload. Caller labels cannot relabel an OpenAI control as Gemini/xAI or move it
to another model.

The plan retains the complete CAS source inventory and a derived source
manifest hash. Verification reopens and re-renders every source; it does not
trust a magic `source_hash` field.

## Meaningful size ladder

The ladder is built independently for each exact provider/model/arm, with at
most one model per provider/arm ladder. The latest retained opportunity is the
current authority at **every** rung. Earlier distinct controls may be added only
as explicitly historical context, deterministically ordered by byte length and
opportunity. If an older and current checkpoint render identically, the current
receipt wins. Size therefore changes without silently changing the current
flow state or expected probe behavior.

The four pre-frozen rung names are:

1. `compact_semantic_baseline`: the latest complete retained control by itself;
2. `meaningful_2k`: the smallest deterministic set of distinct controls whose
   complete request is at least 2,048 UTF-8 bytes;
3. `meaningful_8k`: the equivalent set at 8,192 bytes; and
4. `actual_current_max`: every distinct retained control currently available.

There is no filler, repeated block, Lorem Ipsum, byte padding, truncation, or
fabricated control. Targets may overshoot because semantic controls are
indivisible. A target is frozen as `not_applicable` when the retained meaningful
material cannot reach it. Byte-identical requests are aliases and are not paid
twice. `maximum_paid_sessions` must equal the number of scheduled, non-aliased
cells.

## Frozen probe and custody

Before any connection, the plan fixes:

- source commit, Git tree object, independently derived tree SHA-256, and the
  retained control-source manifest;
- exact provider/model/arm/cell and exact CAS request bytes;
- one CAS-retained caller PCM probe, expected gateway name and argument hash,
  and speech-oracle hash;
- budget ledger, reservation, reservation-binding hash, starting ledger head,
  micro-USD ceiling, and exact paid-session count; and
- the one-attempt / one-generation / no-retry policy.

Result retention requires an injected durable one-shot budget authority. Before
credentials, socket construction, or any other paid action, the operator must
atomically claim the exact plan/cell/attempt-1 tuple. A second pre-open claim is
rejected. After terminal usage is retained, settlement binds that pre-open
claim, the derived usage evidence, computed (or conservatively reserved) cost,
and the new ledger head, and proves cumulative settlement remains below the
plan ceiling. A caller cannot retain a result by setting `attempt_ordinal: 1`
alone. The module deliberately does not load credentials or construct a
provider client; the live operator supplies this audited authority and exact
realtime exchange.

## Result classification

The production clients emit a privacy-safe `dynamicControl` projection on the
exact outbound frame, containing only the additional-control SHA-256, byte
length, and authority label. Result retention replays the complete wire hash
chain and requires this projection to match the frozen request CAS object.

Control acceptance has exactly three states:

- `accepted`: an inbound provider observation supplied an exact acknowledgement
  of the frozen request SHA-256;
- `unverifiable`: the request was processed but the provider supplied no exact
  acknowledgement; and
- `rejected`: an inbound, explicit `dynamicControlRejection` occurred, its
  evidence hash matches the recorded rejection code, and the response did not
  complete. A generic provider error can fail the response but cannot prove the
  additional control itself was rejected.

A completed response alone is **not** upgraded to `accepted`. This matters for
providers whose realtime API accepts per-response instructions but does not
echo them.

Empty, malformed, cross-provider, missing-delivery, or missing-terminal wire
traces fail closed. Adapter-local size rejection is not misreported as provider
rejection; it remains separate local failure evidence.

Each result separately records evidence-derived:

- completed/failed/cancelled/incomplete/interrupted terminal status;
- expected gateway-and-argument, other, or absent tool-call outcome;
- observed, absent, or unverifiable speech capture plus independently supplied
  satisfied/violated/unverifiable speech semantics;
- response-start, first-audio, and terminal latency from monotonic wire clocks;
- nullable input/output text/audio token totals and usage-event count from wire
  usage projections (a total is null if any contributing event omits it); and
- pricing-function-computed micro-USD cost, bound to the pricing
  snapshot/formula and rejected if it exceeds the plan ceiling; when no frozen
  pricing function is available, settlement conservatively charges the complete
  pre-authorized plan ceiling instead of asserting zero or an unknown cost.

Provider wire projections and plaintext IDs are not retained by this module.
The CAS wire artifact contains only provider/direction/order/timing/type,
payload and projection hashes/byte count, hash-chain fields, and already-hashed
identities. Usage retains normalized meters plus a hash of the raw provider
usage object. Tool arguments and provider IDs are represented only by hashes.
Speech semantic evidence binds the frozen oracle, evaluator manifest, output
audio chunk hashes, and exact wire-chain head. `satisfied` is impossible when
the wire contains no output audio.

## Allowed reporting

An admissible report may say, for example:

> On the frozen OpenAI `gpt-realtime-2.1` HACC control ladder, the 8 KiB cell
> completed with speech and an expected gateway call; exact control acceptance
> remained unverifiable because the API did not echo the request hash.

It may not say that OpenAI “supports 8 KiB better than Gemini,” that HACC
improves quality, or that a provider passed ordinary qualification unless those
claims come from separately preregistered evidence. Cross-provider differences
in acknowledgement surfaces, token accounting, latency clocks, and pricing
make this diagnostic descriptive and provider-specific.

## Provider-free validation

The focused test suite proves that:

- complete production-shaped Native receipts and production-rendered HACC
  sources resolve through CAS and a replayed ledger;
- the 2 KiB/8 KiB/max ladder contains meaningful control text and no padding;
- insufficient and duplicate rungs are not scheduled;
- provider/model relabeling, missing CAS bytes, source/plan tamper,
  budget-session drift, empty/invalid wire, retry attempt 2, and duplicate
  one-shot settlement fail closed; and
- wire plaintext, transcripts, raw call IDs, and raw response IDs do not enter
  retained diagnostic evidence.

The focused fixtures are synthetic production-shaped receipts; they test the
custody and derivation machinery, not live provenance or provider behavior. A
real diagnostic plan must use the actual retained LC4 ledger/control CAS from a
clean-source run. No provider API call is made by these tests or by plan
construction.

### Temporary Gate 0 integration state (2026-07-22)

The canonical Gate 0 source-manifest test currently observes 256 relevant test
and runner files while the checked-in inventory still records 254. One new file
is this diagnostic's focused test; another arrived in the coordinated provider
turn-contract commit. The inventory refresh is intentionally deferred until
the concurrent qualification-v3 test files land, so the hash/count is generated
once from the final combined source set. Until that canonical refresh passes,
Gate 0 remains red and this work is not a release packet.
