# HACC-LC4-DEV retained failed attempts

Date: 2026-07-22

These are development mechanism runs, not efficacy results. They are retained
because each failure changed the harness or its evidence protocol. None may be
used as a model score, omitted from an intention-to-test denominator, or shown
in a launch benchmark graph.

## Exact-model qualification at `ffccb47`

- Source commit: `ffccb47fe4fb2c04f5e1ff9825899853b259d3eb`
- Git tree: `74321025f04efc582eaffa632c5ecbcc42315edd`
- Qualification plan: `73fad6c4317dce164cfc44356bdcc6d699549193342bc6bd96b0c8dd89801de2`
- Qualification terminal: `0646cc8ce4d2c419334248e76ffff7b938bf6ef69b01329d209a6add718330d1`
- OpenAI `gpt-realtime-2.1`, Gemini
  `gemini-3.1-flash-live-preview`, and xAI
  `grok-voice-think-fast-1.0` each completed one zero-caller-audio gateway
  generation.
- Totals: three response generations, zero caller-audio bytes, zero retries,
  and three provenance-bound gateway calls.

## Six-episode attempt 3

- Completed 94 of 360 canonical opportunities: all 60 OpenAI Native
  opportunities and 34 OpenAI HACC opportunities.
- Opened 101 response generations: 94 canonical plus seven bounded repairs.
- Paid retries: zero.
- The run stopped fail-closed on OpenAI HACC opportunity 35 when the provider
  terminalized the response as failed.
- Run artifact: `3932b750f79b56517042a556daed6a4bef102a19479778a38a3f3a17a5fd5507`
- Report artifact: `ff6df484e52fc397740aab653e485b32c4131a00fd36254036dba8b132f9357e`
- Interpretation: incomplete operational evidence only. No Native/HACC score
  is admissible from this attempt.

## Six-episode attempt 4

- OpenAI rejected the first session before caller audio or response
  generation.
- Totals: zero submitted opportunities, zero provider generations, zero
  retries.
- Run artifact: `f39f42c3cb32dd99bc3ad16c457e1725cb3369d141ff7f9eac94b9d35af3a8a0`
- Both distinct local OpenAI project keys subsequently authenticated against
  the same organization/project and listed the requested realtime model, but
  realtime generation returned `insufficient_quota`.
- Interpretation: external project quota failure, not an OpenAI model score.

## Gemini/xAI diagnostic

One early four-call draft diagnostic was stopped and permanently marked
inadmissible because it reused a consumed authorization and did not write the
official signed ledger. Its outputs must never be scored or published.

A fresh one-shot diagnostic then bound four exact episodes and 240 canonical
opportunities before opening a socket:

- Protocol: `HACC-LC4-DEV-GX-DIAGNOSTIC-v1`
- Signed subset intent: `c45be7c085f1f368ca9f2177a70b8ae5e0a93cfcce586d6a0880467b7bad5549`
- Driver: `39359db19df4c09ac77e0e3465e9e1051be769038f25a154e6ba28e664b47706`
- Completed 41 Gemini HACC canonical opportunities and four repair playbacks.
- Opened 45 response generations with zero retries.
- Terminal: `f09bc66c82ec3d74b0961d346fe093bded5486035e02a6ca76bc48e67ae80815`
- CAS terminal: `dcc619fd728a6f6b1784cdb76b31bb9c0519bdfd7f383e58a74d5109bb4f0cbf`
- Ledger head: `7febca85a727ffbbaa279003ab3a4f7c0c8972e66943b59a5a57feef0936239f`

The diagnostic stopped at opportunity 42 because Gemini had omitted the
opportunity-35 mutation, then requested reconciliation. The control plane
threw while trying to synthesize an original mutation identity that correctly
did not exist. The exact retained failure-message SHA-256 maps to
`LC4-DEV reconciliation lacks the original mutation invocation identity`.
This is a harness failure, not a Gemini outcome.

## Changes forced by the failed diagnostic

- `92a57b5` makes missing or fabricated reconciliation sources non-mutating,
  receipt-grounded failures and derives effect status only from accepted
  actions.
- `86ab684` delivers the exact grant-free HACC capability catalog on every
  response plan and host-binds quarantined reconciliation identities while
  recording model versus effective arguments.
- `57dbb21` completes the live handoff, gives Native an equivalent safe opaque
  reconciliation handle, and prevents missed critical mutation/reconciliation
  windows from being retroactively credited.

At `57dbb21`, validation passed 227 test files and 2,298 tests, with 21 files
and 59 tests conditionally skipped. TypeScript, ESLint, and the production Next
build also passed.

## Completed Gemini/xAI transport diagnostic at `61a1b22`

**Non-efficacy evidence only.** This diagnostic completed its signed
four-episode Gemini/xAI horizon, but its terminal explicitly sets
`efficacy_claim_eligible: false`. It must not be converted into model scores,
a HACC-versus-Native comparison, or a launch benchmark claim.

- Source commit: `61a1b22d4e6800ff4da99533ca1277086166543b`
- Protocol: `HACC-LC4-DEV-GX-DIAGNOSTIC-v1`
- Episodes: Gemini HACC, Gemini Native, xAI Native, and xAI HACC; no OpenAI
  episode or provider call was observed.
- Completed: four of four episodes and 240 of 240 canonical opportunities.
- Playback accounting: 240 canonical generations plus 16 bounded repair
  generations, for 256 total; zero paid retries.
- Retention/accounting: 240 mechanism-receipt count, 256 listener records, 256
  retained caller-audio objects, and 256 retained assistant-audio objects.
- Terminal: `251f1cb758439cb6e45222094dbfe21c99c3dbb3cdbd4b91f605e4d4a86946d4`
- Terminal envelope: `abb9e4645c8eefc5d49ec5f5bf0dca62e1a6cf47a5ca9d27ef1e7c8721c66727`
- Terminal CAS object: `6d527eb2c4458df9a46306fd90e4593a36e98386791debd29b6ceeed319a8091`
- Ledger: 762 valid chained events; head
  `4862217197b21216497000a182d0fb92e10ffc1990db0c963a785ddeb150bc7d`;
  raw artifact
  `40661b8f3452801fe50622c0c1d2a741fb1a9111d2154b8070b3a76b1fa56cf5`.
- CAS audit: 1,412 content-addressed regular files with no symlinks; audit
  `745f54bf6b0e8cf67decc8816d1119311ac8a3ce35c1c53cb2ba5b15fca1ccb9`.

The retained listener transcripts expose two gaps that block efficacy scoring.
At opportunity 35, Gemini HACC spoke a success claim without a retained
accepted-action or commit receipt; Gemini Native reported an argument mismatch;
and both xAI arms reported that the submission capability was absent from the
catalog. At opportunity 42, the arms variously reported unavailable
reconciliation/status capability or made an unsupported status claim. These
are descriptive spoken outcomes only, not authoritative action outcomes.

The fixed semantic evaluator recorded an empty criterion list for every one of
the eight opportunity-35/opportunity-42 arm records, then projected each as
`final_required_criteria_pass: true`. Those are vacuous listener passes. In
addition, this root retains HACC response-plan hashes but no response-plan,
control-receipt, or tool-action request/result object that can prove action
acceptance, rejection, idempotency, or commitment. Before another efficacy run,
the catalog must expose the exact mutation and reconciliation capabilities, and
the evidence/evaluator contract must require receipt-grounded action outcomes
with non-empty criteria for action-bearing opportunities.

### Retrospective evaluator disposition

The repaired evaluator classifies all eight retained opportunity-35/42 records
as `unscorable_missing_authority_evidence`. Their score numerator and denominator
are both `null`: this packet is neither `0/8` nor a pass. Response-plan hashes
and listener transcripts do not prove tool acceptance, authoritative rejection,
commit state, idempotency, reconciliation, or terminal world state.

This is locked by the provider-free regression in
`web/lib/benchmark/__tests__/lc4-authoritative-obligation-evidence.test.ts`.
Future episodes become scorable only when an arm-neutral signed authority
artifact binds a pre-frozen manifest, a complete tool/worker/fact/confirmation/
terminal source-head set, and a replay-valid event chain. A complete trusted
ledger may yield ordinary `pass` or `fail`; missing or invalid ledger authority
yields `evidence_invalid` and cannot enter a benchmark denominator.

## Current release boundary

The earlier xAI manual-turn qualification path is superseded in source as of
2026-07-22. LC4 now freezes xAI's documented provider-native `server_vad`,
requires the per-turn compact control and exact tool frontier to be sent before audio behind a `session.updated` ordering barrier; the exact outbound frontier is hash-bound, while any provider field echo is retained separately and may remain unverifiable
before caller PCM, records ordered speech-start/speech-stop/automatic-commit/
automatic-response observations, prohibits interruption, and permits only the
single post-tool continuation request. This is a code and provider-free test
correction, not new live evidence; all previously retained xAI attempts remain
historical and unmodified.

The next admissible provider run requires a fresh clean-source qualification
and fresh signed execution root. Fresh zero-audio probes against the current
OpenAI realtime target still fail before response creation with zero usage; the
latest sanitized probe did not preserve a provider subcode specific enough to
attribute that failure to quota alone. Until OpenAI generation succeeds and the
catalog/evaluator gaps above are fixed under a newly frozen protocol, the
six-episode comparison is incomplete and no benchmark number or launch graph is
authorized.

## 2026-07-28 six-episode attempt at `021c70e`

**Retained failure/mechanism evidence only. No partial score is admissible.**

The attempt was preceded by a fresh qualification v3 pass for the exact pinned
models:

- source commit:
  `021c70e68e3edcf32172a3d89bf8611b5b011001`;
- OpenAI `gpt-realtime-2.1`, Gemini
  `gemini-3.1-flash-live-preview`, and xAI
  `grok-voice-think-fast-1.0` all passed their spoken gateway round trip;
- three paid sessions, six provider connections, three tool round trips, and
  zero retries;
- qualification terminal:
  `0d1d18a1aaa9df9d3322151a592e3e2c9cf3fce51bd2c3034f5870db90f28295`;
- qualification package:
  `980b586bcaacb460a9f77adc5d8ff67c0715c1752f5b5f2376149f74cf38e02b`;
- retained replay artifact/head:
  `7bd1cc0dc62f91c3822f593a986485cd5bb4354de4af9f022a0a0609fbe5162d` /
  `562937e27efdbd295cdcab5743ccfdc1dbed068415d69cb3da3d9259002e970f`.

The qualification root is currently retained at
`/private/tmp/hacc-lc4-qv3-evidence-021c70e-20260728T180032Z`.

The six-episode DEV attempt then recorded:

- episodes started/completed: **3 / 2**;
- canonical opportunities submitted/completed: **122 / 121**;
- response generations requested/completed: **130 / 129**;
- provider calls: **129**;
- bounded repair playbacks: **8**;
- paid retries: **0**.

It failed on Gemini HACC opportunity 2. Primary failure evidence
`a6271cf4bf164e9ce0945df1bd80ccf6856ce011a8d0d32ea7efab1f1e87f437`
records `failure_class: audio_delivery`, `failure_code:
audio_delivery_failed`, and `failure_stage: response_prepare`. It also records
that all 170,334 caller PCM bytes had already been appended, while response
generation had not been requested or started.

Independent reconstruction from the retained control CAS object and
`renderHaccResponsePlan` found that the canonical response plan was exactly
4,096 UTF-8 bytes. The required
`<hacc_response_plan>\n...\n</hacc_response_plan>` envelope adds 43 bytes, so
the client received a 4,139-byte control against Gemini's 4,096-byte default
dynamic-control limit. The stop was therefore caused by a harness/client bound,
not evidence of Gemini model behavior.

Retained identities:

- run: `6af4008d7a516062ae33e08efbe9ccd8f8f17494a959dab8ba53e0304e51524c`;
- report:
  `f1a6999ca108a4032c45918654e91cdc12c07becbe04904448590fa5c5628846`;
- run package:
  `0bd50172100019941f1ed204b5d85d47008d9623ce603db1a744b40e88b4ac73`;
- run ledger head:
  `c349b669fac0989fbd3ea83dc1be26a82e3d0a95d094c40237aa8f8cb72acef4`;
- budget evidence:
  `7f82455c4bdd24a2ea5a5d580ffe1f25bee0194e4c0f9888d6e5b02d28328372`;
- budget terminal ledger head:
  `0f653d854bf2c6eeda322da9eead414e50639b1e83b8a40f1b178f8fac5d2f07`.

The filesystem ledger conservatively settled **$7.50** and has **$0.00** in
active reservations. This is pessimistic reservation settlement, not
provider-reported or invoice-reconciled spend.

The root is currently retained at
`/private/tmp/hacc-lc4-dev-evidence-021c70e-20260728T180121Z`. The checked-in
evidence-root verifier reopened it on 2026-07-28 and reproduced its ledger,
budget, package, and report. It remains replayable development failure
evidence, but `/private/tmp` is not durable publication storage. Its report is
explicitly incomplete, claim-ineligible, and unscorable; no score from the two
completed episodes may be extracted. C4/C5 and all HACC-superiority claims
remain **NO-GO**.

## 2026-07-28 six-episode attempt at `deda084`

**Retained failure/mechanism evidence only. No partial score is admissible.**

This fresh root ran from source commit
`deda084a14b803b40de1ef6835a80fe389bd0e1a`. It completed the OpenAI Native
episode and all 60 canonical OpenAI HACC opportunities, but failed while
finalizing the HACC episode:

- episodes started/completed/finalized: **2 / 1 / 1**;
- canonical opportunities submitted/completed: **120 / 120**;
- response generations requested/completed: **128 / 128**;
- provider calls: **128**;
- bounded repair playbacks: **8**;
- paid retries: **0**.

The retained opportunity-42 provider exchange
`e4b1dd3886e2e07464a247a23719ab51089d7355ce2a730ca09cefbb9a562672`
contains an OpenAI HACC request for `archive.observe_worker_result` with empty
model arguments. The host correctly rejected the undisclosed action at
capability epoch 44. Its authority projection records `disposition: rejected`,
`model_arguments: {}`, and `effective_arguments: null`; projection
`12888c1947abe59af3339392187b839c08962c79addc2b1151adbbc46cf3207a`.
The episode-finalization path then treated that null effective argument set as
an accepted worker-observation object and threw. The run's exact retained
failure-message SHA-256,
`bae40ad824d132df902e010126ece0ec1c6f6f338398606a72badaa61cac37f8`,
maps to `LC4-DEV worker observation must be a retained JSON object`.

This is a harness authority-projection bug, not an OpenAI model score. A
rejected tool attempt must remain a scored failed authority event; it must not
crash finalization and must not satisfy a worker obligation. Commit `79501bb`
implements that fail-closed behavior by retaining rejected, argument-free
attempts under a non-authoritative `@unbound` identity. That later code change
does not retroactively make this attempt scoreable.

Retained identities:

- run: `2a9fb6d0228d51df3af6f306868956a637230b178344a4fed36ed4f5a59f686e`;
- report:
  `234b88b9ff8016eb6cc7afc455d4240e3fc5473adec63b34077ff1cefffa491f`;
- run package:
  `55fa39c7d7dd2b30b4b6a7b8422c0c992cb0f1658a82245a08c32b90bd86c50d`;
- run ledger head:
  `9db867994e83de030eabc63c0b34284f52a4d41c1841923f04d5e74a05cd0d0f`;
- budget evidence:
  `8a5319fc8682415778c20c517ee56164902b01906ec5934e3ff764b67d846323`;
- budget terminal ledger head:
  `142c0864b57468022bd54ddeef2fb6c7cc6a098613da9bab3c5298b54a7f121f`.

The report is incomplete, claim-ineligible, and
`unscorable_missing_authority_evidence`; it records five invalid authority
packets and no task results. The filesystem ledger conservatively settled
**$5.00** across the two opened OpenAI reservations, cancelled the four
unopened reservations, and has **$0.00** active. No provider-reported cost was
retained, so this is pessimistic reservation settlement rather than billed
spend.

The root is currently retained at
`/private/tmp/hacc-lc4-dev-evidence-deda084-20260728T183654Z`.
`/private/tmp` is not durable publication storage.

## 2026-07-28 six-episode attempt at `79501bb`

**Retained failure/mechanism evidence only. No partial score is admissible.**

A fresh exact-source qualification passed the pinned OpenAI, Gemini, and xAI
gateway paths before this run. The six-episode root then ran from source commit
`79501bb50d8442b2e5c16db35fbb336061692f30` and recorded:

- episodes started/completed/finalized: **3 / 2 / 2**;
- canonical opportunities submitted/completed: **162 / 161**;
- response generations requested/completed: **174 / 173**;
- provider calls: **173**;
- bounded repair playbacks: **12**;
- paid retries: **0**.

Both OpenAI episodes reached terminal completion, which confirms that the
argument-free rejected-worker finalization crash above no longer reproduced.
The run nevertheless stopped fail-closed before sending Gemini HACC
opportunity 42.

The signed caller-branch decision
`a4e1867f8a4ae3887bb42e02d9058f5544a2c6cd50691087e755647db024d138`
records the prior mutation outcome as `no_call` and selects the registered
`status_followup` branch: 248,840 bytes of 16 kHz PCM with SHA-256
`f3e2db59c84b652a955b34668c9a8ba8bcd1fded17024e606ce9b347d429bbd8`
and source-text SHA-256
`edfcab50cd6ee1cd781aa9dafdf3b22061c1f9f9db4a1e3175cb3275735ab172`.
The frozen episode manifest's non-branch canonical binding for the same
provider/opportunity is instead 180,128 bytes with PCM SHA-256
`08b0d59c946eda69502edb5cda81befa8c0014b113de80ee3d0b91a2dcfea1ed`
and source-text SHA-256
`987cacd9682725100e36da3d0b596158c5d91bba262415ff820a4137ce14c661`.

The runner retained the signed branch decision and selected PCM, but the
provider adapter validated only against the static episode binding. It
therefore rejected the legitimate branch-selected audio before provider
delivery. Primary failure evidence
`bafa7762fdcad13f171242fec1a32649fee1fab1f41428f0844ce8150c1830d1`
records `failure_class: adapter_contract`, `failure_code: invalid_contract`,
and `failure_stage: pre_send_contract`; zero PCM bytes were appended and no
response generation was requested for that opportunity. The outer run records
`failure_class: transport` and failure-message SHA-256
`69e19763e753f86092c1615de18425a5c776f9dcef3f719432e016b61b498c3f`.

This is a harness custody-contract bug, not a Gemini model outcome. A correction
must accept alternate canonical audio only when the exact opportunity,
prior-outcome branch, PCM identity, sample rate, and signed branch-decision
authority all verify; simply bypassing the frozen audio binding would weaken
the benchmark.

Retained identities:

- run: `2b69e2551d50272477dd9c141d31e12267820f2fb69825aeadbe235480bf657c`;
- report:
  `f55c4524c7725cc475f98e8f99ba230d03f0c3b50d3c0eb0483a93e434f24238`;
- run package:
  `ac14cf464ab5fdb56d2bfc9b3d9be46d5972b844ea863ffcede46804ba762b6e`;
- run ledger head:
  `f953555fe56c2bcb13ab055de06577b118d4a159250001b3591078599aa55012`;
- budget evidence:
  `dac04ce270a673f691c6dc5690625613d838bcc8f58504df4d5ec8b86245acae`;
- budget terminal ledger head:
  `ef3b7ca6ca36b34d311d0a891204af87c1e248b277d69570b90197c3caee6e5e`.

The report is incomplete, claim-ineligible, and
`unscorable_missing_authority_evidence`; it records four invalid authority
packets and no task results. The filesystem ledger conservatively settled
**$7.50** across the two completed OpenAI reservations and the failed Gemini
HACC reservation, cancelled the three unopened reservations, and has **$0.00**
active. No provider-reported cost was retained.

The root is currently retained at
`/private/tmp/hacc-lc4-dev-evidence-79501bb-20260728T190631Z`.
The two completed OpenAI episodes cannot be extracted as a partial benchmark.
No public graph or Native/HACC efficacy claim is authorized, and the temporary
root must move to durable release storage before cleanup.

## 2026-07-28 six-episode attempt at `f956647`

**Retained failure/mechanism evidence only. No partial score is admissible.**

A fresh exact-source qualification passed all three pinned provider gateways
before this run. The qualification was rooted at
`/private/tmp/hacc-lc4-qv3-evidence-f956647-20260728T200956Z` and records:

- source commit:
  `f95664760510016b4da5389982a11e6c8e428883`;
- signed terminal artifact:
  `4736fd083bfa9791f3b61479b7b5a96ece3aa3da613e4aee45fd7421268bca5d`;
- terminal-body SHA-256:
  `52ebc6eb0c963c95ca86c9e2d9d593fdbd8213554f30b451aee393509f8b1fca`;
- signed package artifact:
  `8b9a63f812e38eb34ec2f85d9ac4e9eacb41bacde690c3508458e0302398dfdd`;
- qualification budget evidence / final head:
  `aa331c229f57358a1f4572ffd4b2b50325c907c94d83100fb5071d7050de3f76`
  /
  `0650dd20498ceee3d50381fd1f61038b5d52b953c01028280c0da244b0d97551`.

It opened three paid sessions and six provider sessions, completed six
generation phases and three tool round trips, and used zero retries or
reconnects. The OpenAI, Gemini, and xAI roundtrip evidence hashes are,
respectively:

- `2e22ac3e3434eb4ad19fb5aec0561bce2961eb4297ba3252cf2fe1af68741d57`;
- `3ce08513cf9ff42bcbec478ab9b80f14a9edffb1c6acd6f62e975729fd18cd26`;
- `44ea3c9eed065dfe30af4b982c1f3e01ef5b5d9e694cd82cc75a9f15ba596714`.

The following six-episode DEV attempt ran from the same source commit and
recorded:

- episodes started/completed/finalized: **2 / 1 / 1**;
- canonical opportunities submitted/completed: **70 / 69**;
- response generations requested/completed: **75 / 74**;
- provider calls: **75**;
- bounded repair playbacks: **4**;
- paid retries: **0**.

OpenAI Native reached terminal completion. OpenAI HACC then selected registered
repair `lc4-dev-repair-01` at canonical opportunity 10. The signed repair
decision is
`246a0677c347bb8260929e83cc9d6503266e17c9be27b96c548393bc4d962c84`;
it binds 301,920 bytes of 24 kHz PCM with SHA-256
`9b3e1e0dae3962c42cf6391cc12df2fd722024eeb1dd39f3d4669ef8c48d65ab`.

The repair reached the pinned OpenAI `gpt-realtime-2.1` gateway. Primary
failure evidence
`cd6758a4b60320dd8548a7e46e0988a17cea61249ba572cd95d0e83655d5a48a`
records:

- `failure_class: gateway`;
- `failure_code: gateway_fatal`;
- `failure_stage: gateway_dispatch`;
- `gateway_fatal_class: parse`;
- `playback_kind: repair`;
- a terminal wire response was observed;
- 256,800 output PCM bytes were captured, but `response_completed` remained
  false.

Segment close retained secondary cleanup failure evidence
`a4847c11afb7c32cafd98128070691606da3844fb67068f26927cfbae8523104`,
which is hash-linked to the primary gateway failure. The outer run therefore
records `failure_class: evidence` and failure-message SHA-256
`0bec2e0373b578b4300f0dcfda8252559c5ee53e3665fe86b1f1b3563272f2bb`.

This is a harness gateway/evidence-path failure, not an OpenAI model outcome.
The terminal response and captured audio do not authorize treating the repair
as completed when the adapter retained a parse-fatal state.

Retained identities:

- run: `e981290743e1120866078717f319e468efe19832e33a1651dad0c01e12c41313`;
- report:
  `7edc0be39165d06dbeacb5ce6bb28719ab557c6327e2a9550fe83becc4ecaf0a`;
- run package:
  `d1313acb4515e78093d7f4cf4b1e22f3c9961554ff1dc1f588e9fba2e5a0b947`;
- run ledger head:
  `75145f11526eea19eb9273f2652d440d7be19df38e485bfeec43c4be5a690351`;
- budget evidence:
  `eb33dcc8cd03e91416d15c2819c3f8ceb235f78913f413cd0e067674fb627c72`;
- budget terminal ledger head:
  `28af6280dd58d20120e0ab9717897a4cbc25b79d3e46dafbfd82339125b54684`.

The report is incomplete, claim-ineligible, and
`unscorable_missing_authority_evidence`; it records five invalid authority
packets and no task results. The filesystem ledger conservatively settled
**$5.00** across the completed OpenAI Native and failed OpenAI HACC
reservations, cancelled the four unopened reservations, and has **$0.00**
active. No provider-reported or invoice-reconciled cost was retained.

The DEV root is currently retained at
`/private/tmp/hacc-lc4-dev-evidence-f956647-20260728T201032Z`. Both roots live
under `/private/tmp`, which is not durable publication storage. No completed
episode or opportunity subset may be extracted as a score, no public graph is
authorized, and all Native/HACC efficacy claims remain **NO-GO**.

## 2026-07-28 six-episode attempt at `4e47774`

**Quarantined custody failure. No partial score is admissible.**

The exact-source qualification passed OpenAI `gpt-realtime-2.1`, Gemini
`gemini-3.1-flash-live-preview`, and xAI
`grok-voice-think-fast-1.0` with three paid sessions, six provider sessions,
six generation phases, three tool round trips, and zero retries. Its trust
root is
`4119bace3de85da3dd55701977cabb1c0b60db1df239f5ec3e5ef3d64a0b7ae8`
and its terminal artifact is
`d62343dc1f90cd76266bfa05d860ff4d27b66adab0604f559473cc418034781e`.

The DEV attempt then completed:

- OpenAI Native: **60/60** canonical opportunities;
- OpenAI HACC: **60/60** canonical opportunities;
- Gemini HACC: **60/60** canonical opportunities;
- Gemini Native: **60/60** canonical opportunities;
- registered repairs across these episodes: **16**;
- provider turns completed: **256**;
- paid retries: **0**;
- pre-dispatch semantic rejections: **0**.

The four terminal event hashes are:

- OpenAI Native:
  `3fbe09ece622fa8e1a01f22ee8363ea8f91cb23a019055f8bd8b58f59716c14d`;
- OpenAI HACC:
  `727b64f5c67898968788cdc7b98f8b48be2362f50a7d158bdf1f61d160509bb8`;
- Gemini HACC:
  `71c64ca495ea6b462057c349c5f7037f1b1360d70fdeb41f6a204c1c8a3efbc4`;
- Gemini Native:
  `041ea4b7a0033ad7c2232ffa7e5ae0b80b6c3b8dc1a356ac93bff8ea72dd8776`.

The runner next recorded xAI Native `episode_opened` event
`9f3c562f768d21eb93fb2434f24c9ba8105fc360c283ce179898dbe8130dab90`
and signed budget `reservation.connection_intent` event
`7f0ede4f0c73c796c28b8ca9d86da01e3455b8d8a5c43412766f80d3da9b6564`.
A provider network connection attempt began, but no xAI audio submission,
response generation, or provider exchange is retained.

A signed-ledger reload then rejected a transient unsafe filesystem observation.
The file later observed as regular, mode `0600`, and `nlink=1`, but the
aggregate failure message did not retain which predicate differed. The
in-memory failed run was subsequently masked when budget finalization performed
another ledger inspection. The root therefore has no immutable run, terminal
budget evidence, run package, report, or public artifact.

All six $2.50 reservations remain nonterminal in the quarantined signed ledger
(four `opened`, one `opening`, one `reserved`), so its unreconciled local
authorization exposure is bounded by the original **$15.00** ceiling. That is
not a settlement, provider-reported bill, or cash-spend claim. The root must
not be resumed or repaired in place.

The next source version replaces pathname-only reads with descriptor-bound
`O_NOFOLLOW` custody, retains the same descriptor through append, revalidates
identity/link/mode and exact size after fsync, persists the primary terminal run
before secondary cleanup, and atomically publishes terminal budget evidence
with its run package. A new qualification and one-shot DEV root are mandatory.

## 2026-07-28 six-episode attempt at `c0592ae`

**Failed finite-clip xAI server-VAD turn. No partial score is admissible.**

The exact-source qualification at
`c0592aed6d770dd06cdecac15846e4b91dc7ebee` passed OpenAI
`gpt-realtime-2.1`, Gemini `gemini-3.1-flash-live-preview`, and xAI
`grok-voice-think-fast-1.0` with three paid sessions, six provider sessions,
six generation phases, three tool round trips, and zero retries. Its trust
artifact is
`d3536c9c25fa727d7a1f97673e15bb2c9f8c84eab1d25717f38568118e55cfcf`;
its terminal artifact is
`d06f11a0066d606d6f0e2213b4813d94b0525d9a2d760f9c0951195bd4b356bf`.

The DEV run then completed OpenAI Native, OpenAI HACC, Gemini HACC, and Gemini
Native. Its terminal accounting records:

- episodes started/completed: **5/4**;
- canonical opportunities submitted/completed: **241/240**;
- provider calls started/made: **256/256**;
- response generations requested/completed: **257/256**;
- registered repairs: **16**;
- paid retries: **0**.

On xAI Native opportunity 1, the adapter delivered all 197,100 bytes of caller
PCM in 206 chunks. xAI emitted `input_audio_buffer.speech_started` but did not
emit `input_audio_buffer.speech_stopped`, automatic commit, response start,
output, or a terminal response before the bounded 45-second operation timeout.
xAI HACC was cancelled without opening. The primary failure evidence hash is
`9b367b950d06ddb22220374634b831c0aa3564931aeb992dab0c476ee4fb6943`,
and the cleanup evidence hash is
`17540699e8550d0f1d168e56eb9dfcf8c72b8842d69d50ab27eae17b3922b1b1`.

Unlike `4e47774`, the hardened failure path retained its primary terminal run,
budget evidence, and package:

- run:
  `0e2b0e1726bed14130f0bca1d2996a168d0f8cbd0f82c24070b578b7cc83b967`;
- package:
  `fe73edce47d78aabe227dfbedf548c6366fd0471b14cdec98f2ec5241d54de39`;
- budget evidence:
  `b051bd6a70b3635df956dfbec908d3d7dd689dd775bb18dc8cfbc9afb86b59af`;
- budget terminal head:
  `1f240ee49d7ca9e31db4b4e309270d5c17b3c50c97346f82d422365b67e22e5a`.

The official failure report ran once. Its hash is
`c562b13ac2961f257067608666d100a18eb72a40ad2440eed56fe78eff7ef071`;
it records `completed: false`, `evidence_complete: false`,
`task_results_available: false`, `efficacy_claim_eligible: false`, and
`budget_replay_verified: true`.

The DEV ledger conservatively settled **$12.50** across the four completed
reservations and failed xAI Native reservation, cancelled xAI HACC, and has
**$0.00** active. The exact-source qualification separately settled **$3.00**.
Cumulative LC4 conservative settlements are therefore **$55.50**. The earlier
`4e47774` ledger's **$15.00 maximum** quarantined nonterminal authority remains
outside the settled total and is neither reusable authority nor a provider
invoice.

The root cause is a source-proven transport composition mismatch:
qualification already sent the frozen, separate, deterministic zero-PCM
end-of-speech delimiter after preserving caller PCM byte-exact, while the DEV
production adapter sent only the caller PCM and omitted that existing suffix.
The finite clip therefore did not expose enough streamed silence for the
configured native server VAD to close the turn.

This diagnosis does not validate the current uncommitted remediation. The
failed root is immutable and nonpublishable, cannot be retried or resumed, and
contributes no Native/HACC score or graph. Any next paid attempt requires a new
source commit, qualification, evidence root, keys, authorization, and full
one-shot six-cell execution.

## 2026-07-28 six-episode attempt at `f75d1d2`

**Failed xAI server-VAD liveness turn. No partial score is admissible.**

The exact-source qualification passed all three pinned providers; its xAI
receipt covers the retained server-VAD transport and does not qualify the later
finite-manual efficacy transport. The DEV run then completed OpenAI Native,
OpenAI HACC, Gemini HACC, Gemini Native, and the first eight xAI Native
opportunities. Its terminal accounting records:

- episodes started/completed: **5/4**;
- canonical opportunities submitted/completed: **249/248**;
- registered repairs submitted/completed: **16/16**;
- response generations requested/completed: **265/264**;
- paid retries: **0**.

At xAI Native opportunity 9, the adapter delivered all 101,142 caller PCM
bytes, observed `speech_started`, and delivered the full frozen 800 ms
zero-PCM transport delimiter. No `speech_stopped`, automatic commit, response
start, output PCM, provider fatal, or terminal response followed. Five
heartbeats arrived during the wait, proving inbound socket liveness but not
media ingestion. The exact cause therefore remains an unresolved xAI
server-VAD/media-liveness boundary, not a proven network transient.

- primary failure evidence:
  `e51ee7c631fc6aa3ca8c816ca4d4c5172e9b09b0791db3d9dbeb2d4caab119c1`;
- cleanup failure evidence:
  `2f8b8e7abc76bcb0421e24103dd0d808e4be3818a8132b8fc2c566f9638d0a52`;
- run:
  `d98b0d6e1b009dde600f37986904f082b9e52dab098a935420c191d537aa880a`;
- package:
  `5d2ecd3f17f8474db4ec400ca5b9f3101bed290059a4f3a0ecefcb3df4570de3`;
- budget evidence/head:
  `9ccf17639c355402fbbd19cc2b9ebd1bafe7231ab193c1712ea0dbac7d9589b4` /
  `d7f48980a0a2e25ea668ce33ea40347de89e7686fbce30b654af958e45906122`.

The filesystem ledger conservatively settled **$12.50**, cancelled unopened
xAI HACC, and has **$0.00** active. The root is immutable, cannot be retried or
resumed, and contributes no result cell or launch graph. No xAI efficacy cell
may be admitted from this receipt; a fresh source/profile-bound Gate D manual
clip must first produce a signed replay-verifiable receipt, and that receipt is
transport compatibility evidence rather than a Native-versus-HACC result.

## 2026-07-29 six-episode attempt v5 at `1265097`

**Failed local rotation compilation. No partial score is admissible.**

The immutable source was
`12650977209760e244b7df8d551788bd3b33cddd`. The attempt completed one full
OpenAI Native episode and the first 20 canonical opportunities of OpenAI HACC:

- episodes started/completed: **2/1**;
- canonical opportunities submitted/completed: **80/80**;
- response generations requested/completed: **86/86**;
- registered repairs: **6**;
- paid retries: **0**;
- unopened Gemini/xAI reservations: **4**, all cancelled.

The failure occurred while compiling the OpenAI HACC history for segment 2.
No segment-2 provider socket opened, no segment-2 generation was requested, and
no segment-2 provider call was made. The retained terminal artifacts are:

- machine-recorded failure class: `transport`;
- failure message SHA-256:
  `5e7b140348c37e798dbdc66d3ecad0f1f66e573b992bc3c67cee4fcf83bfe7fa`;
- run:
  `32625a9fc35f26c75e27218554e7026ae1d23f1231e8e0788c4b2bc909cf1c56`;
- package:
  `a1c33fe35b832cc365b751375f84b35290a0390894fd16b71bce1ec06aadbea2`;
- budget evidence/head:
  `563e90511f93a85b4665bb96f0c62e596630a34020e0a6971f887c3b67a6f6a5` /
  `e5ee1a0969647aa1f594a50a3f264fc3505d1f48ce7135ab4a26742d8b0afd83`.

The recorded `transport` class is preserved but was disproved as the causal
classification. SHA-256 of the exact local error text
`LC4 rotation conversation text is invalid` equals the retained failure hash.
Provider-free reconstruction found a 9,187-byte provider-visible HACC
tool-result turn: the successful gateway output repeated the full response plan
under two fields. The local validator rejected that turn before any segment-2
provider interaction. This root is therefore evidence of a local
continuity/rotation defect, not provider transport behavior or comparative
model performance.

The DEV budget conservatively settled **$5.00** for the completed OpenAI Native
reservation and failed OpenAI HACC reservation, with **$0.00** active after
terminalization. Current release-epoch conservative exposure is **$41.50**.
The separate **$15.00 maximum** custody-failure authority remains frozen and
non-reusable. See the [budget ledger](../BUDGET.md) and
[progress checkpoint](../PROGRESS.md) for the bounded next sequence.

The failed root is immutable, cannot be resumed or repaired, and contributes no
result cell, score, or launch graph. A new paid root is blocked until offline
tests prove lossless, order-preserving history reconstruction across both
rotation boundaries, including batched successful tool results and
pre-dispatch rejection results, before any caller audio is sent.

## 2026-07-29 qualification v3 at `deea288`

**Failed provider-history hydration. DEV was not authorized and no efficacy
score is admissible.**

The source-bound xAI finite-manual Gate D v4 passed first, retaining:

- provider sessions: **1**;
- generation phases: **2**;
- gateway tool roundtrips: **1**;
- retries/reconnects/fallbacks: **0/0/0**;
- conservative settlement: **$1.00**;
- claim boundary: transport qualification only, not efficacy.

The subsequent qualification opened all six bounded provider sessions, of
which three were paid, attempted six logical generation phases and three
tool-roundtrip probes, and used zero paid retries. Its provider results were:

| Provider/model | Result | Caller PCM | Retained boundary |
|---|---|---:|---|
| OpenAI `gpt-realtime-2.1` | failed `history_hydration_failed` | 0 bytes | first `conversation.item.create` rejected immediately; hashed provider error does not prove the rejected field |
| Gemini `gemini-3.1-flash-live-preview` | passed | 53,506 bytes | history hydration and spoken gateway roundtrip completed |
| xAI `grok-voice-think-fast-1.0` | failed `history_hydration_failed` | 0 bytes | user item acknowledged; seeded tool-call acknowledgement retained empty arguments instead of the 53-byte outbound JSON |

The qualification terminal is bound by artifact
`eb0a8bc53fbc7e5ed36c2bf980de22fe6ba17035f49ac52b016a35a584ff884c`
and file SHA-256
`e0c6bce6abcaaf812a2ce9d9a6b1323bb4d52438f77aa43c767113454cc299dd`.
Its conservative settlement is **$3.00**, budget evidence is
`d5da03d47ad2330a8ab89dd4a2708c9046a52f644410a8ded20438c6218b7299`,
and terminal ledger head is
`1fd5e04266c2fc6537602b87c8b58228929402722f06e26be416d1e2ba0a0cb3`.
Active reservation after terminalization is **$0.00**.

The source root and both paid artifacts are immutable and cannot be retried.
Gemini's passing probe is qualification evidence only; it is not a Native/HACC
cell. OpenAI's identifier-prefix repair remains a hypothesis until a fresh
source-bound qualification passes. xAI's next-source allowance is deliberately
restricted to the one observed empty-string tool-call-arguments echo and does
not permit missing arguments or omitted/empty tool output.

## 2026-07-29 qualification v3 at `a9c2c66`

**Failed closed. DEV was not authorized and no efficacy score is admissible.**

The source-bound xAI finite-manual Gate D v4 passed first:

- source:
  `a9c2c664d0aba47e05f462a220bf514e6a43b059`;
- provider sessions: **1**;
- generation phases: **2**;
- gateway roundtrips: **1**;
- retries/reconnects/fallbacks: **0/0/0**;
- conservative settlement/active: **$1.00 / $0.00**;
- receipt artifact:
  `f79e88456d00437501e2c00980e892a450a5e19ef89a45bdad23d1071a5920cc`;
- receipt file:
  `a8ea97e6c4c6eca3d7fc9e8dc8b8f3e43343a05c45255c14dd9d64e0f6f9f647`.

The subsequent qualification opened six provider sessions, three paid, and
attempted six generation phases and three tool roundtrips with zero retries:

| Provider/model | Result | Caller PCM | Retained boundary |
|---|---|---:|---|
| OpenAI `gpt-realtime-2.1` | failed `history_hydration_failed` | 0 bytes | first client history item rejected before audio |
| Gemini `gemini-3.1-flash-live-preview` | failed `speech_before_tool` | 53,506 bytes | one-byte newline transcript; no retained output-audio evidence |
| xAI `grok-voice-think-fast-1.0` | passed | 80,260 bytes | full history hydration and spoken gateway roundtrip passed |

The qualification terminal artifact/file are
`693c296382c2e90b0a4569a0d6a1aa458007e6186703fcf61580c4b8d80477a3`
and
`8a3f6467595c4c838be108f7aa889237b4140efe6978f189d80e1829af9bbc99`.
The retained payload root is
`1fe5de56fed8dbd6ab31c274e757ed205602316609980c1803cd757ac1561c79`.
Replay artifact/head are
`ca5d1bd06f9dec754cfab37c6dad510d00a3356bcd5349d571eee9595c15f919`
and
`ebceb5374dc97d8eba5574bf51b5bf2098d74c0f317cd5eb3d1cc403c78766b3`.
Budget evidence/head are
`a9bf8f6bce2cc083d687f59d7cdcc9e0433b28bb2389b94d5bec5700d7c66bba`
and
`eb97f71e15776c3586eeef5c26f36d69da52ff89a4bb8824b4eaa348f5fb4937`.
The qualification conservatively settled **$3.00** with **$0.00 active**.

The OpenAI root retained only content-free hashes, but the failure is now
proven exactly. Reconstructing the deterministic first frame produced the same
223-byte payload SHA-256
`b0a4c69f8524cdd38c6dceb0d54f9d9d1ac933145c68feb749d4f4c36c5b02b0`.
The exact 44-character ID was
`item_hacc_hist_0001_6010c058ae1f45f00f4668e7`. Its provider diagnostic
commitments resolve to code `string_above_max_length` and the message that
`item.id` permits at most 32 characters. A zero-generation probe accepted and
echoed a deterministic 32-character client ID exactly. The repair therefore
shortens IDs without weakening per-item identity acknowledgement.

The Gemini terminal classification is preserved, but its causal interpretation
is corrected: the only output was SHA-256
`01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b`,
the one-byte string `"\n"`. No output-audio evidence exists. The harness closed
immediately, so this root cannot establish whether a tool call would have
followed. It is not evidence that the caller heard speech. The repair retains
whitespace-only transcription as non-speech metadata while leaving any audio,
non-whitespace transcript, terminal-without-tool, or timeout-without-tool
fail-closed.

The failed root is immutable and cannot be retried or rescored. Package
integrity replay passed, but the attempt is not a fully replay-verified
three-provider qualification. It contributes no Native/HACC result cell,
comparative score, model-superiority claim, or launch graph.

## 2026-07-29 DEV preflight refusal after qualification at `6dc5a65`

**Three-provider qualification passed, but DEV was never authorized or run. No
efficacy score is admissible.**

The source-bound xAI Gate D passed with receipt
`f41a7cce16efbb1376e66eed710fae961bac3520339c957f2eeec9aa03b419af`.
The subsequent qualification passed OpenAI, Gemini, and xAI with:

- terminal artifact:
  `ddd1e92caef9fbe51039f068c2640ae3a2230a675f824f564e4bddde0eac25d9`;
- terminal file SHA-256:
  `0f058ef30fb5b6229a549cd949856c425190e55d7eaf1357d79f6c8a8bd4ab6f`;
- budget evidence/head:
  `88fecf03562c431940a12bcf7f1d524fa6567e6d77f47cfb0a59c7f6c7cdda18`
  /
  `04498cac292c12d78d918a688d5178a294d43009d0a555ce1dfafebd5eff052f`;
- payload root:
  `8d8b3c9787e53d664ffaf8d696d787d0bd2d65761eaab9f069508d0925e5d40b`;
- replay artifact/head:
  `452fd2f7b8e352bcce20b9297e7109b1b07000940b78c1661b3e6c8177d9a995`
  /
  `92df4e7b5e9e3dd264efa1962b35dd0f25088d2239b30a588152437c923a2c02`;
- provider sessions/paid sessions/generation phases/tool roundtrips:
  **6/3/6/3**;
- paid retries: **0**;
- conservative qualification settlement/active: **$3.00 / $0.00**.

DEV wrote only `operator-intent.json` and `prepare.json` under the fresh
evidence root. Preflight then failed locally with
`LC4-DEV qualification v3 openai emitted unquarantined output before its
required tool call`. It wrote no authorization, preflight, budget lease,
ledger, terminal run, or package and opened no DEV provider session.

The refusal was a verifier bug, not live pre-tool speech. Before the live tool
call, the OpenAI wire included the frozen provider-native history probe's
assistant message. Its redacted projection carried both:

- an exact `conversationHistoryItem` typed as `assistant_message`; and
- the matching `output_text` SHA-256 and UTF-8 byte length.

The loader counted that historical acknowledgement as possible model output.
The repair recognizes only exact hash/byte-matched hydrated user/assistant
message shapes. It still treats audio, mismatches, extra text, malformed
history, and unknown shapes as possible assistant output.

This prepared-only root is not a failed efficacy episode and contributes no
Native/HACC cell, score, comparison, or launch graph. The passing qualification
is immutable source evidence but cannot authorize a changed source.

## 2026-07-29 qualification v3 at `f44aeb9`

**Failed closed. DEV was not authorized and no efficacy score is admissible.**

The source-bound xAI finite-manual Gate D v4 passed:

- source:
  `f44aeb92637478096a98b7f96449d4ffdc4498aa`;
- provider sessions/generation phases/gateway roundtrips: **1/2/1**;
- retries/reconnects/fallbacks: **0/0/0**;
- conservative settlement/active: **$1.00 / $0.00**;
- receipt artifact:
  `736c1e40e73e714a83dfa9ceca8b70d77748e51de4d8a29f89b2d4904d63b700`;
- receipt file SHA-256:
  `8e7b08eaa1108417069d664ffee39542d011ac11d09f75e69bb8146b3c758ab5`.

The subsequent qualification opened six provider sessions, three paid, and
attempted six generation phases and three tool roundtrips with zero retries:

| Provider/model | Result | Caller PCM | Retained boundary |
|---|---|---:|---|
| OpenAI `gpt-realtime-2.1` | failed `history_hydration_failed` | 0 bytes | user item accepted; synthetic tool-call item rejected |
| Gemini `gemini-3.1-flash-live-preview` | passed | 53,506 bytes | full history hydration and spoken gateway roundtrip passed |
| xAI `grok-voice-think-fast-1.0` | passed | 80,260 bytes | full history hydration and spoken gateway roundtrip passed |

The qualification terminal artifact/body hashes are
`e57a24e2d93592c8b7e3d6e1f1ca9ac00ae5f9fb9f02f170dfea42a374cecfeb`
and
`08cd828e64346dc892bdca6f6e9e808758dd9267bede432f6bc25c05b699a369`.
Package payload root is
`242102c45bd3086137f85ebc91af8504a6541a58c3e7a6632ca92cdedf413138`.
Replay artifact/head are
`f2c9391352f3abab44fe4c5ae2accdead753d3262075bdedf89cdd61273c6ff9`
and
`b2a991270798ec9d7809d92d72aac7ab3d25a4eaa7bd1eb81a84ca92ac14f345`.
Budget evidence/head are
`dab0cc2dfaa3c1f4a7de64b05b38ee09b068930421b3c6438cc9ec497cc665d9`
and
`18ec75395a8a44cb87349a5112747b23cd8ebbc1a4a7ccb8a67a363d2d3005aa`.
The ledger conservatively settled **$3.00** with **$0.00 active**.

The OpenAI failure is proved without another provider session. Wire sequence
4 sent the user item; sequence 5 accepted it; sequence 6 sent the synthetic
tool call; sequence 7 completed the already-accepted user item; and sequence 8
returned the provider error. Reconstructing sequence 6 yields:

- exact payload bytes: **270**;
- exact payload SHA-256:
  `18317d8fb688c7a92586e049232a1c128268539816d0730ff6e647c14ee11f52`;
- exact rejected call ID:
  `hacc_hist_call_0002_001_c283d5f283d5be165bf2089d`;
- call-ID length: **48**;
- provider raw code: `string_above_max_length`;
- exact provider message:
  `Invalid 'item.call_id': string too long. Expected a string with maximum
  length 32, but got a string with length 48 instead.`

The reconstructed payload, raw-code commitment, and message commitment match
the retained evidence exactly. The late `conversation.item.done` was a valid
lifecycle event, not the cause. The new source shortens deterministic call IDs
to exactly 32 ASCII bytes and separately regression-tests the observed
lifecycle ordering.

This root is immutable and cannot be retried or rescored. Its Gemini/xAI passes
are qualification evidence only. It contributes no Native/HACC result cell,
comparative score, model-superiority claim, or launch graph.

## 2026-07-29 DEV terminal at source `985b3e8`

**Failed closed after one OpenAI Native generation. No efficacy score is
admissible.**

The source-bound xAI Gate D and three-provider qualification both passed:

- Gate D trust/receipt:
  `e97f95a91d073d7c6ab85b10acb8df4c3bbe5bbd2805e1add7e6b5ae78a7bac1`
  /
  `80c4590f34ca21ac8f2c8e6138604d27ccdc9d7d44f9caa0b0b769c61765f323`;
- qualification trust:
  `33a3b3d0e4cb62d441b4ee8e8fd288dfa65a7eaed00ede5a6f048e89ad150991`;
- qualification terminal artifact/file:
  `4b736feb7959342a14d0878b0b5099c9cf06b6ee6838b801e3138d686acc7444`
  /
  `1a55783580d593cb90ebc7409a60bb33bcba83f50c18f3dbad63a4688d69f91b`;
- qualification payload root:
  `8986ac5ce3182ae233a4655d63bf15838939231cac69df973eb4d2038113b5e8`;
- qualification budget evidence/head:
  `937290f1793fe08a1ae8d3e05545c27389f1fd7c8897d332e00dbbe0d588a131`
  /
  `a26c9adbd29dc48e4ce5fbbbe870cf1ee2e013841ebdc67e4fc1b992991cf61e`;
- retries: **0**; settlement/active: **$3.00 / $0.00**.

The strict DEV preflight authorized six episodes and 360 opportunities. The
one-shot execution terminalized at the first OpenAI Native opportunity:

- run/package:
  `30128376f0cb1477b9b40be2e791675b368c436a81276a6328922da1d9ae20b4`
  /
  `ef42779d22ae9c0ae893a40650e145153e0f6475e954500d4327f3beac9bddbe`;
- primary failure evidence:
  `495060576c23d4549fdb908463767d27fd02e71247348dd64c1d6602910fdc2a`;
- failure class/code/stage:
  `evidence_retention` / `evidence_assembly_failed` / `exchange_evidence`;
- episodes started/completed: **1/0**;
- opportunities submitted/completed: **1/0**;
- provider calls/completed generations: **1/1**;
- paid retries: **0**;
- DEV settlement/active: **$2.50 / $0.00**.

The retained artifacts prove that the paid exchange itself completed:

- provider-exchange evidence:
  `f979c4b3ac3c4f8f16b41c97a9d7dea0e11ad7ee1dd969c4360ca009ac1821c3`;
- signed listener evidence:
  `e155be42299ef38ad4f30a5d25de9ba70cf66d791059992c814d04b3c55bebcb`;
- exact assistant PCM: **1,464,000 bytes**, SHA-256
  `dfda2b6b6ba8e449888af31cb506a2e3abc4a250b01eb9f3e99afa0bb986bde7`;
- terminal cleanup view: **404** wire observations and terminal observation
  `c230cfdccf78756bf059394a50e60bbf2bb105e32f510dd854ae48c8ee72a89d`.

Offline reproduction against these exact retained bytes identified a local
contract-version split. The adapter emitted the current schema-v4 exchange;
the replay verifier admitted only schemas v2/v3. Mutating only the in-memory
version to 3 made the old verifier pass the remainder of the exact exchange.
After the repair, the original immutable schema-v4 artifact passes replay
without mutation, including the caller-heard output capture and suppression
receipt.

The failed-run report is
`5f5701cf2b4ee159d694172932f81a852aa1d1e2bb3dad22be45eb77069078c8`
(file SHA-256
`86e466be1fe8f36d58ebc6f7b85d5f14ff6cd1a2e176e3ae551404248793ccd6`).
It reports `completed: false`, `evidence_complete: false`,
`task_results_available: false`, and `efficacy_claim_eligible: false`.
Nothing from this root may populate a comparative graph.

## 2026-07-29 DEV terminal at source `09fad06`

**Failed closed after 129/360 completed opportunities. No efficacy score is
admissible.**

The source-bound xAI Gate D and three-provider qualification both passed:

- Gate D receipt/file:
  `b3e0195daeea3177106db8ed64367feda14c503d01ad67c5da2680030cfd8298`
  /
  `e53d9aaaed04ba6bfdeef8ba7bf8b7137cbe3a7c2e1279f543feb3c705dfcadfe`;
- qualification terminal artifact/body/file:
  `0bc9eb17a7c44ff4102d8580f371d7f390def526d22292857c4622f23c3415a7`
  /
  `7ff9ff8be343f4157e872757c9af01afd29de122e65751675a43991002239c06`
  /
  `3f72db3f3e3341d646cebebd4c4a73caffcad066c68c6b8ba3c07a643acb4179`;
- qualification budget evidence/head:
  `5c7b29953f3c9f22fd300abfa83d1e05545b338c95b46ebcd9f0ba0eadfcbbe1`
  /
  `cfcf868bb500b31b43eb1d633cdfbeee3ef42e0adb0e3f042fe1acbeb4ffa74b`;
- provider sessions/paid sessions/generation phases/tool roundtrips:
  **6/3/6/3**;
- retries: **0**; settlement/active: **$3.00 / $0.00**.

The one-shot DEV root terminalized while executing Gemini HACC opportunity 10:

- run/package:
  `15b182d759ba6977e9e6cc1682330e822486af43bef6796c708c1b43c1a07048`
  /
  `fbdf2e7b66911db29af9d83f3e5ca62c38105c02641f5330d0344ed8a5d88e1a`;
- primary failure evidence:
  `4d71580defe95e7c660bda2cb19b8aff728ea8a08c366bca7e6e8caebe829a2a`;
- failure class/code/stage:
  `timeout` / `provider_response_timeout` / `provider_wait`;
- playback:
  Gemini HACC opportunity 10 repair, **201,280 PCM bytes**, SHA-256
  `0fc7bc34a4a79bfdb17607e66b08e55080aecc7a01bb6fd713aed613f667c676`;
- episodes started/completed: **3/2**;
- opportunities submitted/completed: **130/129**;
- generations requested/provider calls completed: **139/138**;
- completed repair playbacks: **8**;
- paid retries: **0**;
- DEV settlement/active: **$7.50 / $0.00**.

OpenAI Native and OpenAI HACC each completed 60/60 opportunities. Those cells
remain trapped inside an incomplete source-bound run and cannot be mixed with
a later rerun.

The outer error commitment
`771cde19f703fc5d227cb5e843f6853e2d8d2702234cd20041ffdfc8cc1e32c7`
resolves to `LC4-DEV exchange failed: provider_response_timeout`. The primary
failure has zero wire observations and false generation flags because the
runner's 50-second `Promise.race` rejected first. The adapter's own 45-second
timer begins only after real-time audio delivery; the submitted Gemini repair
alone takes **6,290 ms** to pace. The adapter could not own that timeout before
approximately 51.29 seconds, even before its listener/evidence handoff.

The full frozen audio set confirms a **7,776.25 ms** maximum paced input. The
repaired source centralizes the timeout contract, preserves the 45-second
provider response policy and 600-second listener ASR timeout, and moves the
outer runner/budget watchdog to **700 seconds**. Its explicit inner bound is
8 + 5 + 45 + 600 + 30 = **688 seconds**. Audio admission rejects any future
canonical, branch, or repair binding above the 8-second premise.

The failed-run report is
`4ae66633df0d5cc5a7dc4a2bd451480696771210c8d8905de04eabe917c25b3d`
(file SHA-256
`ce3cfc004713ab754ef10ac8316e3da9c5c638d66a7118af4da2e0c4015c8dfd`).
It is incomplete, evidence-incomplete, task-result unavailable, and
efficacy-claim ineligible. Nothing from this root may populate a comparative
graph.

## 2026-07-29 DEV terminal at source `35adfec`

**Failed closed after 139/360 completed opportunities. No efficacy score is
admissible.**

The source-bound release gates passed first:

- xAI Gate D receipt/trust:
  `d1c01125d052e19565aadb93c30223fadd9cb9c003438a68b995faadecdc4922`
  /
  `9fc01779a4209ed1744ff2e91af2f4e37cc1991617e97da83380763421617ec7`;
- qualification terminal artifact/body:
  `359e023c736985ceff9f6fda0eafc847c8de6a79f2b2937ee3fb9da8a84b1b7b`
  /
  `caa7bbe5d30e952a71532e2644e05e2cf5a362190e1d4a92e77354a2d8b73e03`;
- qualification trust:
  `762611659a1893a77799acb04fae6bea955a31e67a6f4e8a0fb6c1ef023be842`;
- qualification provider sessions/paid sessions/generation phases/tool
  roundtrips: **6/3/6/3**;
- qualification retries/settlement/active: **0 / $3.00 / $0.00**.

The DEV execution root
`/private/tmp/hacc-lc4-dev-release-20260729T221746Z` retained:

- run/package:
  `d136124af3cd31254f554bb906293c11c619667706a9e3bbf53a6833114c31ed`
  /
  `0e03c600c27c1e9bf407311f84b5096fc0319c258c495b009b697685763c1cbc`;
- episodes started/completed: **3/2**;
- opportunities submitted/completed: **140/139**;
- generations requested/completed: **149/148**;
- provider calls/completed repairs: **149/9**;
- paid retries: **0**;
- DEV settlement/active: **$7.50 / $0.00**.

Both OpenAI cells completed 60/60. Gemini HACC completed opportunity 19 and
then failed during opportunity 20's canonical playback. Those partial cells
remain trapped in this source-bound failed root and cannot be mixed with a
later run.

Primary failure evidence
`b9de06a49860494a418b696ca64cac27561a1e02cf615e531c3383a5770c64c6`
records:

- `provider_external / provider_fatal / provider_wait`;
- caller PCM: **85,828 bytes**, SHA-256
  `9709f3e0a52c062d8e3e1b87c2ebeb155703efefe6a7591895c0ca832d438231`,
  all **135/135** chunks delivered;
- response generation requested and started;
- a normalized response terminal observed;
- assistant PCM: **2,274,242 bytes** across **160** chunks, SHA-256
  `651d88c398b718f305c316a1c0c346c6394804d203382851c7d04f786f045c34`;
- final wire observation
  `41d350abc37bf96debff0344cb094e8452663acb32c9891308e8340c5119b0d5`;
  and
- final wire type commitment
  `2ef871697891e67d2f02f30ee665f9a0670a06eebe922df0bf65678f108c4a2d`,
  which resolves to `serverContent`, not a provider error union.

Cleanup evidence
`aedbc51fbd89b0b541b97884b69e5f2299a88f16abebdb16a64dfdb41355f43d`
is secondary to that primary failure. The terminal budget evidence/head are
`19ecc9a6bc005c78064bc93a53ffdae91e55174d6a6d4978e8984d10e134b15a`
/
`bbe75024a8fe7761e6291a98174e63299a2484ad902499c5ff2e481ac7bba0a0`.

The raw provider frame is intentionally not retained, so its precise fields
cannot be reconstructed. The proven client lifecycle explains the failure
class: after `completeResponse()` moved the generation trigger to `terminal`,
a later terminal-bearing `serverContent` attempted
`ensureResponseStarted()`, which rejected the absence of a new local trigger
and surfaced as `invalid_provider_message`. This is strongly consistent with
post-terminal provider bookkeeping and is not evidence of missing model
output or a provider error frame.

The repair accepts only consistent post-terminal metadata and independently
ordered transcription on the existing response identity. It rejects
post-terminal model content, PCM, tool calls, tool cancellation, and
contradictory status before any side effect. Focused Gemini/publication tests
pass **61/61**; the complete suite passes **3,290** tests across **301** files,
with the remaining environment-qualified skips source-inventoried.

The failed-run report is
`75e215a26be1eb139d098dbd81847bfb92629a883a0097aaccf2f761fec19c1b`
(file SHA-256
`5ba47c9f3df0bb8a8ecb2674655e20a55a2918f6512bef56243c567cd4019e62`).
It reports `completed: false`, `evidence_complete: false`,
`task_results_available: false`, and `efficacy_claim_eligible: false`.
Nothing from this root may populate a comparative score or graph.

## 2026-07-29 DEV terminal at source `1dbcb68`

**Failed closed after 121/360 completed opportunities. No efficacy score is
admissible.**

The exact-source release gates passed before the DEV run:

- xAI Gate D receipt/trust:
  `6cea733b0d3df68241b2b10610622c572581463c361c09283d11806a8c1b2a0c`
  /
  `f15226074a6ff3bac7192a8b42e5e0b37baa3adc972e3e27020dafcf389e805f`;
- qualification terminal artifact/body:
  `c33e6105ab24041d33abcdab80567be4d4c9dc0887e3df582a1e1ee62de90ba0`
  /
  `5ed35af8f50bdeb83d60ebc5f26e7bedc2ffa486c5d5420622d6b12962491aa9`;
- qualification trust:
  `d1db65770589c70b86ce54068394dc3d93146a730d79a500b7a7385fce7e11f9`;
- qualification provider sessions/paid sessions/generation phases/tool
  roundtrips: **6/3/6/3**; and
- qualification retries/settlement/active: **0 / $3.00 / $0.00**.

The DEV execution root
`/private/tmp/hacc-lc4-dev-release-20260729T232239Z` retained:

- run/package:
  `15c909b82d55903009f8a761c06053d904d54d251e30ba20f45f9b3bab3cb193`
  /
  `495a24391afa5a9192eea49cc27d09c9e79a6bbf8d88685edf3125129d9a0605`;
- episodes started/completed: **3/2**;
- opportunities submitted/completed: **122/121**;
- generations requested/completed: **130/129**;
- provider calls/repair playbacks: **129/8**;
- paid retries: **0**; and
- DEV settlement/active: **$7.50 / $0.00**.

OpenAI Native and OpenAI HACC each completed 60/60 opportunities, including
both planned history-rotation boundaries. Gemini HACC completed opportunity 1
and failed while streaming opportunity 2's caller audio. Those partial cells
remain trapped inside the failed source-bound run and cannot be mixed with any
later rerun.

Primary failure evidence
`7148c7d1f0d4b0793b68553198985975f52f35e77853a77fe1851f0b9f974614`
records:

- `audio_delivery / audio_delivery_failed / audio_append`;
- caller PCM: **170,334 bytes**, SHA-256
  `d8bec01869f6ccc26c5d6ccbce8539280df9773d012d975bf093fcb337eec590`;
- only **3/267** chunks and **1,920/170,334** bytes appended;
- no response preparation, commit, request, start, terminal, or output audio;
- final wire observation
  `7ef093d076d736ea59f34b3c9b5d30749f0b439893aeb925a74bce13ad6fe55b`;
  and
- final wire type commitment
  `2ef871697891e67d2f02f30ee665f9a0670a06eebe922df0bf65678f108c4a2d`,
  which resolves to `serverContent`.

Cleanup evidence
`63bf7ccae6500538423b7fb8754e193cc727e717af9062cd09ba2f4a0b73ddfb`
is secondary. The failure occurred before Gemini opportunity 2 could trigger
generation, so it is not a model-performance result.

The client-state regression is deterministic: after opportunity 1 completed,
`startActivity()` advanced the input turn while paced caller audio was still
being appended, but `activityEnd` had not yet armed opportunity 2's generation
trigger. The post-terminal metadata guard required the completed response's
input-turn number to equal the now-current input turn. A legitimate
`serverContent` frame during that narrow streaming interval therefore poisoned
the socket as conflicting metadata.

The repair admits only the completed terminal turn or exactly its successor
while that successor's input activity is open. It still rejects untriggered
model content or PCM, contradictory terminal status, post-terminal tools, and
all wider turn gaps. The exact regression completes response 1, begins paced
audio for response 2, receives input transcription before `activityEnd`,
appends more audio, then proves response 2 requires and receives its own
terminal. Focused Gemini tests pass **59/59**, the adapter/runner integration
set passes **158/158**, and the complete sequential suite passes **3,291**
tests across **301** files with **85** source-inventoried skips.

The failed-run report is
`cbac33ef74c7e276b01f49b87aa17a0b9b6a6e26185c7b6ab26a84a7cdf96e2f`
(file SHA-256
`43be67428fd6bacc595ed074b377bd3da721e95f841d86e64ba758c39046b92a`).
It reports `completed: false`, `evidence_complete: false`,
`task_results_available: false`, and is unscorable. Nothing from this root may
populate a comparative score or graph.
