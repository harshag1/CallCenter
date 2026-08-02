# HACC proof program execution ledger

<!-- markdownlint-disable MD013 MD060 -->

## Objective

Establish, or falsify, the narrow claim that the same realtime speech-to-speech model completes long, stateful, policy-constrained voice work more reliably behind Harsha's Amazing Call Center than behind a registered best-practice Native integration, without increasing critical effects or caller-playable policy breaches.

This program does not claim improved ASR, voice naturalness, or underlying model intelligence.

## Authority and spend envelopes

- API/provider implementation testing: hard aggregate maximum **$100 USD**.
- Comparative benchmarking: separate hard aggregate maximum **$100 USD**.
- Offline development, simulation, replay, static analysis, and provider-fake tests: **$0 expected provider spend**.
- Paid sessions remain closed until protocol, parity, evidence, runner, and budget admission gates pass.
- No paid retry, fallback, replacement episode, or outcome-adaptive extension is allowed.
- An opened session remains in the intention-to-treat ledger even if it fails.

These envelopes are independent. Unused testing authority cannot silently enlarge the benchmark envelope, and unused benchmark authority cannot enlarge testing authority.

## Frozen starting point

- Branch: `open-source`
- Source commit: `d499f69cf41cc46910721f2954f9d50ee8eb6d54`
- Upstream at start: `origin/open-source` at the same commit
- Working tree at start: clean
- Start date: 2026-08-02 PT

## Baseline verification

| Gate | Command | Result |
|---|---|---|
| Provider-free entry point | `npm run demo:offline:check` | Passed; explicitly reported no provider/database/telephony/email/paid API use |
| Existing claim guards | `cd web && npm run benchmark:claims:verify` | Passed: 10 files, 99 tests |
| Type safety | `cd web && npm run typecheck` | Passed |

The existing claim-readiness audit remains authoritative until HACC-Proof-v1 replaces each stop-ship with replay-derived evidence. Existing LC4 provider results remain incomplete and do not support superiority.

## Execution waves

### Wave 0 — contracts and treatment boundary

- [ ] Freeze HACC-Proof-v1 protocol and machine-readable endpoint contract.
- [ ] Freeze independent `$100` testing and `$100` benchmark ledgers.
- [ ] Freeze Native/Full-HACC treatment manifests and parity proof.
- [ ] Freeze evidence-v2 manifest and offline replay requirements.
- [ ] Freeze exact paired analysis and claim-decision implementation.

### Wave 1 — production authority convergence

- [ ] Production state-derived Turn Contract.
- [ ] Canonical ConversationProgram projection.
- [ ] Default governed effect admission and reconciliation.
- [ ] Provider lifecycle/evidence conformance contract.
- [ ] Production EvidenceTap integration.

### Wave 2 — falsification before providers

- [ ] Fault matrix for stale/forged authority, races, reconnects, workers, audibility, and tampering.
- [ ] Provider-free reference vertical demonstrating detour, recovery, worker, and replay.
- [ ] Clean independent replay from frozen artifacts.
- [ ] No benchmark-only behavior absent from the production treatment.

### Wave 3 — paid qualification and development pilot

- [ ] Reserve every session pessimistically before opening it.
- [ ] Run testing/qualification sessions only within the `$100` testing ledger.
- [ ] Admit D24 only after all offline and identity/parity gates pass.
- [ ] Run D24 within the independent `$100` benchmark ledger.
- [ ] Publish D24 as descriptive regardless of result.

### Wave 4 — terminal decision

- [ ] Independently replay every opened episode.
- [ ] Decide whether a powered confirmatory design fits the remaining benchmark envelope.
- [ ] If it does not fit, publish exploratory evidence and keep superiority unproven.
- [ ] If it fits, freeze untouched confirmatory cases before collection.
- [ ] Publish the exact pass, null, adverse, incomplete, or invalid result.

## Public claim boundary

No superiority graph or "HACC is better" statement is permitted until the preregistered primary endpoint passes, all opened episodes are included, critical safety gates pass, and a clean independent verifier regenerates the result. Offline containment numbers must remain labelled as deterministic mechanism evidence.

## Spend log

| Time (PT) | Envelope | Operation | Reserved | Observed | Status |
|---|---|---|---:|---:|---|
| 2026-08-02 | Testing | Program initialization and offline baseline | $0 | $0 | Complete |
| 2026-08-02 | Benchmark | Program initialization | $0 | $0 | Closed pending gates |
