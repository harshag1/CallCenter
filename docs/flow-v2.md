# Flow v2

Flow v2 makes long voice workflows recoverable and enforceable without loading every branch and tool into the initial prompt.

## Shape

```json
{
  "schema_version": 2,
  "tool_exposure": "gateway",
  "max_step_entries": 200,
  "always_tools": ["contact_support", "request_recall", "end_call"],
  "nodes": [],
  "edges": []
}
```

There is exactly one `incoming_call` entry. `topic` nodes carry routing context and recursive steps. A `fallback` node defines out-of-scope handling.

`max_step_entries` is an optional call-level circuit breaker across entries and retries. Omit it for unbounded workflows or set it comfortably above the longest validated scenario.

A step may contain:

- `entry`: explicitly mark a top-level step as selectable immediately after classification.
- `instructions`: exact behavior revealed on entry.
- `context`: additional knowledge for this layer only.
- `tools`: actions granted to this step and descendants.
- `required_outputs`: durable keys required by `complete_step`.
- `success_criteria`: reviewable natural-language criteria.
- `steps`: nested substeps, up to eight levels.
- `transitions`: explicit absolute target paths, human-readable `when` guidance, and optional machine-enforced output conditions.
- `on_failure`: absolute recovery/escalation path.
- `max_attempts`: retry ceiling, default 3.
- `checkpoint`: persist a recovery marker after completion.

## Runtime lifecycle

`classify(topic)` selects one topic and returns only its entry step paths. If no top-level steps set `entry`, the runtime infers entries by excluding any top-level transition and failure targets. `enter_step(path)` verifies reachability, increments attempts, and returns instructions plus action definitions. `run_action(name, arguments)` verifies that the current node/ancestor/step grants the action. `complete_step(outputs)` validates required keys before it unlocks children or transitions; a model cannot jump forward while the active step is incomplete. `get_flow_state()` reconstructs the durable checkpoint.

Transition results include their labels and `when` conditions. For deterministic branching, add `condition: { "output": "eligible", "operator": "equals", "value": true }`; supported operators are `equals`, `not_equals`, `exists`, and `in`. Conditions are evaluated against the outputs just persisted for that step, so unmatched branches never become reachable. A step's `on_failure` path becomes reachable at its `max_attempts` ceiling and is excluded from successful completion paths. Repeated `complete_step` delivery is idempotent, and persisted revisions prevent two concurrent tool calls from silently overwriting one another.

Transitions and failure paths may cross topic boundaries. A topic whose top-level steps are all inbound transition targets is treated as an internal stage and is omitted from initial classification; set `entry: true` when a target should also remain directly routable. Reclassification cannot abandon an incomplete active step.

Always-available tools should be rare. Human escalation, callback, and hangup are reasonable defaults. Account mutation, payment, fulfillment, and data-writing tools should normally be scoped to the exact step that needs them.

## Validation and testing

The builder exposes two deterministic primitives:

- `validate_flow` checks JSON shape, duplicate IDs, entry count, dangling graph edges, unknown transition targets, nesting depth, and node reachability.
- `test_flow_scenario` walks a topic and ordered step/output sequence using the same engine as live calls.

Use both before attaching a flow. Unit tests for the engine live in `web/lib/__tests__/flow-runtime.test.ts`.

## Backward compatibility

Flows without `schema_version: 2` remain Flow v1 and use direct tool exposure with `classify` and `begin_step`. Updating or creating a flow through the builder defaults it to v2 gateway mode.
