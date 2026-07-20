# Paid-canary operator runbook

This is the fail-closed path for preparing and, only after explicit Gate 1
approval, executing one paid transport canary. Sections 1–6 are offline: they
do not read provider credentials or open a provider socket. Section 7 is the
single paid boundary and is labeled separately. The identity directory,
machine ledger, provider env file, and generated plan belong under `.local/`,
which is gitignored.

The operator CLI emits one canonical JSON object to stdout. It never emits
private-key bytes. A nonzero exit means no release should proceed.

## 1. Create a fresh signing identity

Create the local parent once, then ask the CLI to exclusively create a new
private identity directory:

```bash
cd web
mkdir -p ../benchmarks/voice-long-horizon/.local
chmod 700 ../benchmarks/voice-long-horizon/.local
npm run benchmark:canary:operator -- identity generate \
  --directory ../benchmarks/voice-long-horizon/.local/canary-signing-v1 \
  --key-id canary-signing-v1
```

Generation refuses an existing directory rather than replacing or reusing key
material. The directory is mode `0700`; the PKCS#8 private key, SPKI public key,
and identity manifest are each mode `0600`, non-symlinks, and single-link
regular files. The CLI also writes a deny-by-default `.gitignore` inside the
identity directory as defense in depth. If writing the identity fails, the
newly created partial directory is removed.

The command prints only:

- the identity-manifest path;
- the public-key path;
- the key ID;
- the SHA-256 fingerprint of canonical Ed25519 SPKI DER; and
- `private_key_material_printed: false`.

Inspect and prove possession locally:

```bash
npm run benchmark:canary:operator -- identity inspect \
  --manifest ../benchmarks/voice-long-horizon/.local/canary-signing-v1/canary-signing-v1.identity.json
```

Freeze all three public values into the new freeze/plan:

1. `key_id`;
2. the exact canonical public PEM from `public_key_path`; and
3. `public_key_fingerprint_sha256`.

Never copy the private PEM into a freeze, result, issue, shell transcript, or
tracked file. A freeze made with an older or different fingerprint is
intentionally unusable with this identity.

## 2. Initialize the machine spend ledger paused

Initialization is atomic and starts paused in event sequence 1; there is no
initialized-open crash window and no implicit resume:

```bash
npm run benchmark:canary:operator -- ledger init \
  --ledger ../benchmarks/voice-long-horizon/.local/gate1-budget.jsonl \
  --ledger-id gate1-budget-v1 \
  --operation-id initialize-gate1-budget-v1 \
  --operational-ceiling-usd 15
```

Record the returned `ledger_id` and `head_sha256` in the Gate 0 packet. Inspect
without mutation:

```bash
npm run benchmark:canary:operator -- ledger inspect \
  --ledger ../benchmarks/voice-long-horizon/.local/gate1-budget.jsonl \
  --expected-ledger-id gate1-budget-v1 \
  --required-ancestor-head-sha256 GATE0_PAUSED_ZERO_HEAD
```

The adjacent ledger key and signed head files are private, integrity-checked
machine state. Do not edit, copy over, truncate, or recreate them. A reused
human-readable ledger ID is not lineage: the signed Gate 0 head must be present
in the append-only event chain.

## 3. Dry-run the exact readiness binding

Before a release decision, verify the plan-pinned identity and Gate 0 ledger
ancestor while the ledger is still paused:

```bash
npm run benchmark:canary:operator -- readiness \
  --identity-manifest ../benchmarks/voice-long-horizon/.local/canary-signing-v1/canary-signing-v1.identity.json \
  --expected-key-id canary-signing-v1 \
  --expected-public-key-fingerprint-sha256 FROZEN_PUBLIC_KEY_FINGERPRINT \
  --ledger ../benchmarks/voice-long-horizon/.local/gate1-budget.jsonl \
  --expected-ledger-id gate1-budget-v1 \
  --required-ancestor-head-sha256 GATE0_PAUSED_ZERO_HEAD \
  --expect-state paused
```

Success reports `provider_credentials_read: false`. This command verifies the
canonical Ed25519 public key, private/public correspondence, private
permissions, exact frozen identity, signed ledger ID, ancestor head, and
expected state. It does not mutate or resume the ledger.

## 4. Materialize the exact $5 cost envelope offline

While the Gate 0 packet and its paused-zero ledger lineage remain intact, and
before creating the execution plan, materialize the provider-specific envelope:

```bash
npm run benchmark:voice -- cost-envelope \
  --gate0-packet ../benchmarks/voice-long-horizon/.local/PRE_CANARY_PACKET.json \
  --freeze-lock ../benchmarks/voice-long-horizon/.local/FREEZE_LOCK.json \
  --scenario ../benchmarks/voice-long-horizon/scenarios/transport-smoke-v1.json \
  --provider PROVIDER --model MODEL --voice VOICE \
  --ledger ../benchmarks/voice-long-horizon/.local/gate1-budget.jsonl \
  --out ../benchmarks/voice-long-horizon/.local/PROVIDER.cost-envelope.json
```

This is a `$0`, credential-free, socket-free command. It verifies the
packet-selected pricing proof against the frozen provider pin; derives the
runner's session, audio, and tool limits from the proof's hard caps plus the
frozen delivery profile; domain-hashes the exact runner configuration; requires
the pessimistic envelope to total exactly `$5`; and exclusively writes one
canonical JSON object without replacing an existing file.

Pass that file unchanged to `plan --cost-envelope`. Both `plan` and `run paid`
independently rederive and check the provider-cap and runner-config hashes.

## 5. Resume through an explicit compare-and-append

Only after Gate 1 is approved, inspect the current signed head and use that
exact value:

```bash
npm run benchmark:canary:operator -- ledger resume \
  --ledger ../benchmarks/voice-long-horizon/.local/gate1-budget.jsonl \
  --expected-ledger-id gate1-budget-v1 \
  --expected-head-sha256 CURRENT_SIGNED_HEAD \
  --operation-id resume-gate1-approved-v1 \
  --reason-code gate1-approved \
  --evidence-sha256 GATE1_APPROVAL_EVIDENCE_SHA256
```

Resume fails if the ledger ID differs, the head changed after inspection, the
ledger is not paused, the operation ID conflicts, or any signature/file
invariant fails. The operator must then run readiness again with
`--expect-state open` before creating the frozen execution plan. No doctor,
inspect, readiness, plan, or run command performs a resume.

## 6. Materialize and inspect the exact paid plan offline

Re-run readiness against the open ledger head, then create one exclusive
full-harness canary plan from the registered transport-smoke scenario and
fixture:

```bash
npm run benchmark:canary:operator -- readiness \
  --identity-manifest ../benchmarks/voice-long-horizon/.local/canary-signing-v1/canary-signing-v1.identity.json \
  --expected-key-id canary-signing-v1 \
  --expected-public-key-fingerprint-sha256 FROZEN_PUBLIC_KEY_FINGERPRINT \
  --ledger ../benchmarks/voice-long-horizon/.local/gate1-budget.jsonl \
  --expected-ledger-id gate1-budget-v1 \
  --required-ancestor-head-sha256 GATE0_PAUSED_ZERO_HEAD \
  --expect-state open

npm run benchmark:voice -- plan \
  --gate0-packet ../benchmarks/voice-long-horizon/.local/PRE_CANARY_PACKET.json \
  --freeze-lock ../benchmarks/voice-long-horizon/.local/FREEZE_LOCK.json \
  --scenario ../benchmarks/voice-long-horizon/scenarios/transport-smoke-v1.json \
  --fixture-root ../benchmarks/voice-long-horizon/fixtures/transport-smoke-v1 \
  --provider PROVIDER --model MODEL --voice VOICE \
  --condition full-harness --mode canary \
  --ledger ../benchmarks/voice-long-horizon/.local/gate1-budget.jsonl \
  --cost-envelope ../benchmarks/voice-long-horizon/.local/PROVIDER.cost-envelope.json \
  --kernel-attestation-key-id canary-signing-v1 \
  --kernel-attestation-public-key ../benchmarks/voice-long-horizon/.local/canary-signing-v1/canary-signing-v1.public.pem \
  --out ../benchmarks/voice-long-horizon/.local/PROVIDER.plan.json
```

`plan` is credential-free and socket-free. It prints the exact
`plan_sha256`, `maximum_micro_usd`, and `exact_confirmation_max_usd`. Inspect
the canonical plan file and confirm that provider, model, voice, scenario,
fixture, condition, limits, pricing proof, ledger ID/open head, attestation
identity, output root, and `$5` maximum are exactly the reviewed cell. A plan
expires after 24 hours and its reservation authority is bound to the current
open ledger head; any intervening ledger mutation makes it unusable.

## 7. Explicitly confirm and execute once — paid boundary

Stop here unless the clean-commit Gate 0 packet, network-free pre-spend
emulator, provider-specific pass profile, frozen cost envelope, and human Gate
1 approval all apply to this exact plan. Put only the required provider key in
an ignored, mode-`0600` env file under `.local/`. The paid command reads that
key lazily only after the one-shot plan authority and `$5` reservation boundary
have been durably consumed and a private crash-durable partial has recorded the
reservation. If credential resolution fails, no provider client is constructed:
the partial is preserved and the full `$5` reservation remains active for
explicit operator recovery rather than being silently released.

Copy the exact `plan_sha256` emitted by Section 6; do not calculate, shorten,
or substitute it. The maximum confirmation is the exact string `5`:

```bash
chmod 600 ../benchmarks/voice-long-horizon/.local/PROVIDER.env

npm run benchmark:voice -- run paid \
  --gate0-packet ../benchmarks/voice-long-horizon/.local/PRE_CANARY_PACKET.json \
  --plan ../benchmarks/voice-long-horizon/.local/PROVIDER.plan.json \
  --freeze-lock ../benchmarks/voice-long-horizon/.local/FREEZE_LOCK.json \
  --fixture-root ../benchmarks/voice-long-horizon/fixtures/transport-smoke-v1 \
  --ledger ../benchmarks/voice-long-horizon/.local/gate1-budget.jsonl \
  --kernel-attestation-private-key ../benchmarks/voice-long-horizon/.local/canary-signing-v1/canary-signing-v1.private.pem \
  --env-file ../benchmarks/voice-long-horizon/.local/PROVIDER.env \
  --confirm-paid-sha256 EXACT_PLAN_SHA256_FROM_SECTION_6 \
  --confirm-max-usd 5
```

This command may spend money and open exactly one provider session. Run only
one provider at a time. Do not start another command, edit the ledger, replace
the plan, or reuse its confirmation while it is running. A nonzero exit,
timeout, partial directory, provider refusal, missing terminal artifact, or
uncertain settlement is a completed no-retry outcome for this reviewed
operation. Preserve the plan, journal, partial/final artifact, provider
evidence, and ledger. Do not rerun the command or attempt the same plan on
another machine.

## 8. Pause after the bounded canary

When a canary completes, fails after credential readiness, or is cancelled,
first let the paid runner preserve and settle its reservation. A failure during
credential resolution is intentionally different: inspect the preserved
partial and confirm the still-active pessimistic `$5` reservation before any
explicit recovery; do not report it as settled or retry it. Once the ledger
liability has an explicit operator disposition, inspect the new head and
explicitly pause:

```bash
npm run benchmark:canary:operator -- ledger pause \
  --ledger ../benchmarks/voice-long-horizon/.local/gate1-budget.jsonl \
  --expected-ledger-id gate1-budget-v1 \
  --expected-head-sha256 POST_SETTLEMENT_SIGNED_HEAD \
  --operation-id pause-after-gate1-canary-v1 \
  --reason-code gate1-canary-ended \
  --evidence-sha256 CANARY_ARTIFACT_OR_FAILURE_SHA256
```

Do not retry a refused or partial paid run. Preserve its journal and ledger,
reconcile the conservative liability, create a new reviewed operation/run ID,
and obtain the next explicit release decision.
