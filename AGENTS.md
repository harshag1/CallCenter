# Workspace operating rules

These rules apply to the entire repository. More-specific `AGENTS.md` files may
add implementation guidance, but they may not weaken the spend, custody, or
publication boundaries below.

## Standing launch authority

The repository has standing operator authority, granted on 2026-08-02, to
continue the HACC open-source launch work without asking for another human
approval at each gate, source commit, provider, reconnect-safe continuation,
or cryptographic signing step.

- The hard ceiling is **strictly less than $300.00** in cumulative conservative
  exposure across covered provider benchmarks and Twilio launch validation.
- Exact-source plans, signatures, receipts, journals, and clean-tree checks are
  evidence and custody requirements. They are not requests for new human
  consent. Generate them as normal implementation steps under this standing
  authority.
- The currently registered LC4 sequence remains serial and bounded to $19.00:
  $1.00 xAI Gate D, then $3.00 OpenAI/Gemini/xAI qualification only after Gate
  D passes, then $15.00 six-cell DEV only after qualification and preflight
  pass.
- Twilio launch validation has a $30.00 sub-ceiling and is included inside the
  aggregate `< $300.00` ceiling, not added above it.
- No paid retries, reconnects, fallbacks, replacement cells, or reserve are
  authorized after network admission. A runner-enforced unopened or
  pre-network continuation is allowed; an ambiguous or post-admission unit is
  quarantined permanently.
- Stop before an operation whose pessimistic reservation would make cumulative
  conservative exposure greater than or equal to $300.00. Also stop on a
  failed or ambiguous gate, a custody-verification failure, or a request that
  expands beyond the covered HACC launch and Twilio-validation scope.
- A credit rejection may be continued after funds are added only when the
  retained runner proves the unit never crossed paid/network admission.

Operators may use the user's authenticated Chrome session or background-safe
computer control to obtain or rotate provider/Twilio keys, inspect account
configuration, deploy the standalone bridge, and configure the approved launch
canary. Never print credentials, place them in tracked files, commit them, or
copy them into benchmark evidence. Store new credentials only in private
mode-0600 environment files and retain redacted receipts.

The machine-readable authority contract is
`benchmarks/voice-long-horizon/HACC_STANDING_LAUNCH_AUTHORITY.json`. Historical
budget entries remain historical; the latest authority entry in `BUDGET.md`
controls approval cadence.

