# Deep Flow v2 examples

These examples are provider-neutral workflow definitions for long, repeatable voice calls. They use the same Flow v2 semantic validator and pure transition engine as the live gateway; the deterministic tests make no provider, network, database, email, SMS, or telephony calls.

| Example | Longest path depth | Steps | Checkpoints | Domain tools | Maximum active tools |
| --- | ---: | ---: | ---: | ---: | ---: |
| [`service-appointment-lifecycle.json`](service-appointment-lifecycle.json) | 4 | 15 | 6 | 12 | 7 |
| [`warranty-and-incident-intake.json`](warranty-and-incident-intake.json) | 4 | 14 | 4 | 10 | 7 |
| [`membership-return-resolution.json`](membership-return-resolution.json) | 4 | 13 | 4 | 10 | 7 |

“Maximum active tools” includes the three always-available support tools. It is the largest lease at one step, not the number loaded when the call starts. All three flows begin with only `contact_support`, `request_recall`, and `end_call`; classification then reveals the minimum domain actions for the selected path.

## What the examples demonstrate

### Service appointment lifecycle

The booking path reaches:

```text
appointment.schedule.search.select.review
```

It verifies the caller, classifies book/change/cancel, searches real availability, and supports a bounded pre-commit slot-selection cycle. Re-entering `appointment.schedule` invalidates the previous selection subtree’s outputs and checkpoints. A separately gated `appointment.consent` step binds explicit consent before `appointment.commit`; the commit blocks progress on an indeterminate dispatch until reconciliation.

The example records notification submission as `notification_accepted`. It never calls that result delivered.

### Warranty and incident intake

The warranty path reaches:

```text
product_help.evidence.attachments.preference.consent
```

It separates warranty intake from product-incident reporting, binds eligibility to a policy action, uses explicit retention/submit consent, and routes exhausted retries or an active-hazard classification to a human handoff. The flow makes no warranty-approval, safety-certification, legal, medical, or reimbursement claim.

Evidence submission records `evidence_submission_accepted`. Acceptance is not evidence retention, validation, review, or approval.

### Membership and multi-item returns

The return path reaches:

```text
membership_return.return_items.select_item.item_details.eligibility
```

It preserves a membership goal, resumes a return goal, and handles one line item through selection, item details, policy evaluation, explicit consent, a reconciled mutation, and notification submission. It deliberately handles one item per Flow operation: another item needs a fresh bounded operation or a reviewed mission workflow, so evidence from item one cannot authorize item two.

The label request records `notification_accepted`, not label delivery. Creating a return does not imply that a refund was issued.

## Required integration work

The domain tool names are extension points, not built-in provider implementations. Before attaching one of these flows:

1. register each referenced tool with bounded input and output schemas;
2. enforce tenant, caller, and domain authorization inside the integration;
3. pin the tool catalog into the call runtime manifest;
4. provide idempotent downstream handling for every mutation;
5. for each reconciliation policy, register the named read-only query tool and validate the write/query pair as one closed trusted catalog;
6. persist Flow state, receipts, checkpoints, and reconciliation proofs atomically; and
7. test real provider interruptions, reconnects, and human-transfer behavior in your deployment.

The JSON validator proves shape, graph reachability, scoped grants, bindings, and policy placement. It cannot prove that a custom tool’s implementation is correct, that a downstream service honors idempotency, that a message arrived, or that a human transfer completed.

## Deterministic verification

From `web/`:

```bash
npm run demo:offline
```

This is the fastest runnable tour. It catalog-checks and loads the 15-step
service-appointment Flow v2 definition in memory, executes ten deterministic
fake integration calls, and drives a nine-step booking path through the same
receipt-backed scenario simulator used by the builder. The simulated write
loses its response after dispatch, survives a process restart, refuses a blind
retry, and completes only after authoritative read-back reconciliation. The
command needs no provider keys or database and exits nonzero with structured
evidence if catalog closure, a bound result, a terminal assertion, or the
receipt/replay proof set fails.

For the full example test suite:

```bash
npx vitest run lib/__tests__/deep-flow-examples.test.ts
```

The test suite:

- parses every JSON file through `validateAgentFlow`;
- requires zero validation diagnostics;
- parses every embedded reconciliation contract through `ActionReconciliationSpecSchema`;
- walks the three longest paths with receipt-bound outputs;
- verifies exact progressive tool sets and maximum exposure;
- proves an indeterminate appointment mutation blocks completion until proof-backed promotion;
- exhausts incident retries into the safe handoff; and
- executes membership help followed by one independently authorized return item.

This is deterministic framework evidence, not an STS quality benchmark. It does not measure speech recognition, synthesis, model reasoning, latency, provider compatibility, or real-world task success.
