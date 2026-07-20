# Flow v2

Flow v2 makes long voice workflows recoverable and enforceable without loading every branch and tool into the initial prompt.

## Shape

```json
{
  "schema_version": 2,
  "tool_exposure": "gateway",
  "max_step_entries": 200,
  "always_tools": ["contact_support", "request_recall", "end_call"],
  "always_action_policies": [
    { "tool": "request_recall", "max_calls": 3, "idempotency": "per_call_arguments" },
    { "tool": "end_call", "max_calls": 1, "idempotency": "per_call" }
  ],
  "nodes": [],
  "edges": []
}
```

There is exactly one `incoming_call` entry. `topic` nodes carry routing context and recursive steps. A `fallback` node defines out-of-scope handling.

`max_step_entries` is an optional call-level circuit breaker across entries and retries. When omitted, Flow v2 does not add its own entry ceiling, so production callers should normally set it above the longest validated scenario and retain independent session, turn, tool-call, and cost limits.

A step may contain:

- `entry`: explicitly mark a top-level step as selectable immediately after classification.
- `instructions`: exact behavior revealed on entry.
- `context`: additional knowledge for this layer only.
- `tools`: actions granted to this step and descendants.
- `required_outputs`: durable keys required by `complete_step`.
- `output_bindings`: authoritative mappings from a successful action receipt and result path to a typed durable output.
- `action_policies`: call-count and idempotency rules (`none`, `per_step`, `per_arguments`, `per_call`, or `per_call_arguments`).
- `success_criteria`: reviewable natural-language criteria.
- `steps`: nested substeps, up to eight levels.
- `transitions`: explicit absolute target paths, human-readable `when` guidance, and optional machine-enforced output conditions.
- `on_failure`: absolute recovery/escalation path.
- `max_attempts`: retry ceiling, default 3.
- `checkpoint`: persist a recovery marker after completion.

## Runtime lifecycle

`classify(topic)` selects one topic and returns only its entry step paths. If no top-level steps set `entry`, the runtime infers entries by excluding any top-level transition and failure targets. `enter_step(path)` verifies reachability, increments attempts, and returns instructions plus leased action definitions. `run_action(name, arguments, capability_grant)` verifies that the signed grant matches the call, immutable runtime digest, capability epoch, step attempt, and action. `complete_step(outputs)` resolves bound values from successful receipts before it unlocks children or transitions. `get_flow_state()` reconstructs the durable checkpoint and mints fresh short-lived grants. `reconcile_action(receipt_id)` derives a pinned read-only proof query server-side and promotes an indeterminate receipt only after an exact authoritative read-back.

Every Flow v2 business action—including an always-available action—travels through `run_action`. A grant is intentionally unusable after classification, step entry/retry, completion, or another grant-changing transition. The model proposes an action; the runtime remains the authority.

Consequential execution is transactional:

1. verify the current grant and schema;
2. derive the configured semantic idempotency key;
3. reserve an action receipt atomically before dispatch;
4. execute only for the reservation owner;
5. persist a successful, failed, or indeterminate outcome; and
6. allow receipt-bound state to commit only from a successful current-attempt result.

An exception after dispatch becomes `indeterminate`, not an automatic retry. This provides exactly-once admission and at-most-once dispatch. End-to-end exactly-once effects additionally require an idempotent or reconcilable downstream API; the framework does not make that claim for an arbitrary opaque HTTP endpoint.

Transition results include their labels and `when` conditions. For deterministic branching, add `condition: { "output": "eligible", "operator": "equals", "value": true }`; supported operators are `equals`, `not_equals`, `exists`, and `in`. Conditions are evaluated against the outputs just persisted for that step, so unmatched branches never become reachable. Bind any value that controls a consequential branch to a receipt instead of trusting model-authored output. A step's `on_failure` path becomes reachable at its `max_attempts` ceiling and is excluded from successful completion paths. Repeated `complete_step` delivery is idempotent, and per-call row locking serializes transitions and receipt mutations.

Transitions and failure paths may cross topic boundaries. A topic whose top-level steps are all inbound transition targets is treated as an internal stage and is omitted from initial classification; set `entry: true` when a target should also remain directly routable. Reclassification cannot abandon an incomplete active step.

Always-available tools should be rare. Human escalation, callback, and hangup are reasonable defaults, but they still receive runtime leases and admission policies. Account mutation, payment, fulfillment, and data-writing tools should normally be scoped to the exact step that needs them. Agent-triggered `end_call` is admitted only after Flow completion or fallback selection and when no receipt remains reserved or indeterminate. A human can always disconnect independently.

At first connection, the call pins a digest-verified runtime manifest containing the agent-version ID, named flow, instructions, code revision, minted-tool endpoint/key references, extension definitions, approved external-MCP manifests, and environment capability flags. Reconnects and tool calls use its digest rather than whichever named flow or attached tool happens to be active later.

## Validation and testing

The builder exposes two deterministic primitives:

- `validate_flow` checks JSON shape, duplicate IDs, action/binding grants, entry count, dangling graph edges, unknown transition targets, nesting depth, and node reachability.
- `test_flow_scenario` walks receipt-free topic/step/output transitions using the same pure engine as live calls. It does not currently mock business actions or mint successful receipts.

Use `validate_flow` before attaching any flow. Use `test_flow_scenario` for topology-only cases, and add action fixtures or integration tests for receipt-bound paths. The tested [deep Flow v2 example pack](../examples/flows/README.md) walks long receipt-backed paths and states every unsupported domain primitive and integration obligation. The smaller [membership and returns example](../examples/flows/membership-and-returns.json) is illustrative: it demonstrates typed receipt bindings and action policies but references domain actions that an operator must implement and seed. Notification outputs deliberately record provider acceptance rather than delivery; use a verified delivery webhook/read-back before naming an output `delivered`. Unit tests cover flow topology, evidence, stale grants, idempotency, immutable snapshots, and unsafe receipt paths under `web/lib/__tests__`.

## Backward compatibility

Flows without `schema_version: 2` remain legacy Flow v1 and use `classify`/`begin_step` for safe routing and compatible read-oriented behavior. Flow v1 is not a path for widening authority: remote MCP, generated tools, source extensions, and mutating/consequential actions require a Flow v2 gateway runtime and fail closed on the legacy path. Updating or creating a flow through the builder defaults it to v2 gateway mode.

Flow v2 is intentionally optimized for repeatable paths with explicit reviewable transitions. For calls that must interleave several evolving goals, suspend and resume detours without authority union, carry obligations across channels, or compensate a partially completed saga, evaluate the experimental [mission runtime](mission-runtime.md) instead of forcing those semantics into one enormous graph.
