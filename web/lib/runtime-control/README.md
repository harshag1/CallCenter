# Runtime control

`createProductionTurnContract` compiles the host's current authority snapshot
into a provider-neutral, state-derived Turn Contract. It is intentionally not
a prompt or a second effect authority.

The contract binds:

- the durable conversation revision and chain head;
- Flow and/or Mission revisions and state digests;
- the capability epoch and eligible intent/action frontier;
- public slot presence, receipt state, worker lifecycle, and claim policy;
- a host-derived response mode; and
- the exact canonical payload bytes through a domain-separated SHA-256 digest.

It cannot carry prompts, transcripts, arguments, result bodies, slot values,
worker payloads, or fixture answers. Strict schemas reject those fields. The
provider receives public identifiers, status, and commitments only; the host
gateway and speech-release gate remain the enforcing authorities.

Creation requires a separately read current-authority tuple. Any conversation,
Flow, Mission, or capability-epoch mismatch throws `turn_contract_stale`.
Indeterminate effects require an explicit quarantine. While quarantined, the
action frontier collapses to designated reconciliation actions and success
claims are removed; without a repair action it becomes `fail_closed`.

Before a live route uses a contract it should call
`assertProductionTurnContract(contract, { ...currentFreshness,
expected_contract_sha256 })` immediately before tool admission and again
before speech release. The expected digest must come from host-retained state,
never from provider-returned content. A subsequent authority change invalidates
the contract rather than mutating it.
