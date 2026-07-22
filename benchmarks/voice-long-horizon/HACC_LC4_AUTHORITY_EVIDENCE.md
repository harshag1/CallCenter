# LC4 authoritative obligation evidence

Status: provider-free evaluator contract. It authorizes no provider calls and
contains no efficacy result.

LC4 deliberately separates two questions:

1. **Audible semantics:** what an independent listener could recover from the
   exact played PCM.
2. **Authoritative tool/world obligations:** what trusted receipts and world
   state prove actually happened.

Neither can substitute for the other. Bounded useful completion conjuncts both.

## Frozen manifest

Before an episode opens,
`compileLc4AuthoritativeObligationManifest()` mechanically compiles the sealed
scenario into exact obligations for:

- all 24 checkpoint tools and their required authoritative outcomes;
- four worker-result dispositions;
- ten latest authoritative fact revisions;
- committed-after-error mutation followed by one later reconciliation;
- non-use of two invalidated confirmations; and
- one complete terminal world.

The manifest is content-addressed and bound to protocol, schedule, template,
and scenario hashes. Episode evidence contains only the manifest hash and an
opaque episode-subject hash; it contains no provider or arm label.

## Signed episode evidence

The episode artifact contains a hash-chained projection of source receipts and
separate complete source heads for tool, worker, fact, confirmation, and
terminal-world evidence. An Ed25519 signature binds the full artifact root.

Replay has exactly three outcomes:

- `pass`: every obligation is proven by a valid, complete artifact;
- `fail`: source ledgers are valid and complete, but prove an obligation was
  missed or violated; or
- `evidence_invalid`: evidence is absent, incomplete, detached, tampered, or
  signed by an untrusted key.

Only `pass` and `fail` are scorable. Missing evidence is reported as
`unscorable_missing_authority_evidence` with a null numerator and denominator.
Cryptographically invalid evidence is `unscorable_invalid_authority_evidence`.

## Listener applicability

An empty audible-semantic criterion set is now explicitly
`not_applicable/no_registered_audible_semantic_criteria`. Its semantic verdict
is `null`; it is never converted to a vacuous pass. Applicable audible criteria
continue to fail closed on missing or unverifiable listener evidence.
