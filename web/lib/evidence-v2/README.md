# EvidenceTap v2

EvidenceTap v2 is a provider-neutral, append-only evidence format for voice-agent
runs. It is deliberately independent of the realtime transport and benchmark
runner: production and experimental runtimes can emit the same typed events,
then an offline process can verify custody and derive endpoints without calling
a model or trusting a live in-memory score.

## Evidence planes

Every complete bundle contains plans, capability catalogs, normalized provider
events, action attempts and policy decisions, authoritative receipts, worker
lineage, generated-audio ranges, playback ranges, world events, usage/pricing,
and one terminal journal event.

Events are sequence-bound and SHA-256 chained. The terminal manifest commits to
the chain head plus an independent ordered root for every evidence plane and is
signed with an expected Ed25519 identity. Replay rejects unknown fields,
noncanonical JSON bytes, missing planes, broken causal references, identifier
collisions, mutation, deletion, reorder, substitution, or a different signer.

Custody validity and agent quality are separate. A correctly recorded unsafe
effect remains valid evidence; its replayed `useful_mission_success` is false.
That prevents adverse outcomes from disappearing as malformed runs.

## Minimal use

```ts
import {
  EvidenceTapV2,
  createEd25519EvidenceSignerV2,
  replayEvidenceBundleV2,
  serializeEvidenceBundleV2,
} from "./evidence-v2";

const signer = createEd25519EvidenceSignerV2({
  signerId: "runtime-authority",
  privateKeyPem,
});
const tap = new EvidenceTapV2({ runId: "run-001", signer });

tap.append("plan.registered", planEvidence);
// Append the remaining evidence at the point each event becomes authoritative.
const bundle = tap.finalize({
  disposition_id: "terminal-001",
  status: "completed",
  reason_code: null,
});

const canonicalBytes = serializeEvidenceBundleV2(bundle);
const result = replayEvidenceBundleV2(canonicalBytes, {
  expectedRunId: "run-001",
  trust: { signer_id: signer.signer_id, public_key_pem: signer.public_key_pem },
  evaluationContract: independentlyFrozenContract,
  expectedEvaluationContractSha256: independentlyFrozenContractSha256,
  artifactResolver: independentContentAddressedStore,
});
```

The signing key is an external authority input. It is never embedded in the
bundle. Replay requires an independently frozen evaluation-contract digest and
an independently identified content-addressed resolver. It reopens every
referenced artifact, evaluates frozen predicates against raw world-state bytes,
and derives audible semantics from reopened alignment artifacts. Hashes and
signatures still cannot make a dishonest custody boundary truthful: production
integration must keep the signer, artifact resolver, semantic evaluator, and
model-controlled runtime separated.
