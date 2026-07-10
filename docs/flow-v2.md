# Flow v2

Flow v2 makes long voice workflows recoverable and enforceable without loading every branch and tool into the initial prompt.

## Shape

```json
{
  "schema_version": 2,
  "tool_exposure": "gateway",
  "always_tools": ["contact_support", "request_recall", "end_call"],
  "nodes": [],
  "edges": []
}
```

There is exactly one `incoming_call` entry. `topic` nodes carry routing context and recursive steps. A `fallback` node defines out-of-scope handling.

A step may contain:

- `instructions`: exact behavior revealed on entry.
- `context`: additional knowledge for this layer only.
- `tools`: actions granted to this step and descendants.
- `required_outputs`: durable keys required by `complete_step`.
- `success_criteria`: reviewable natural-language criteria.
- `steps`: nested substeps, up to eight levels.
- `transitions`: explicit absolute target paths and conditions.
- `on_failure`: absolute recovery/escalation path.
- `max_attempts`: retry ceiling, default 3.
- `checkpoint`: persist a recovery marker after completion.

## Runtime lifecycle

`classify(topic)` selects one topic and returns its first step paths. `enter_step(path)` verifies reachability, increments attempts, and returns instructions plus action definitions. `run_action(name, arguments)` verifies that the current node/ancestor/step grants the action. `complete_step(outputs)` validates required keys and unlocks children or transitions. `get_flow_state()` reconstructs the durable checkpoint.

Always-available tools should be rare. Human escalation, callback, and hangup are reasonable defaults. Account mutation, payment, fulfillment, and data-writing tools should normally be scoped to the exact step that needs them.

## Validation and testing

The builder exposes two deterministic primitives:

- `validate_flow` checks JSON shape, duplicate IDs, entry count, dangling graph edges, unknown transition targets, nesting depth, and node reachability.
- `test_flow_scenario` walks a topic and ordered step/output sequence using the same engine as live calls.

Use both before attaching a flow. Unit tests for the engine live in `web/lib/__tests__/flow-runtime.test.ts`.

## Backward compatibility

Flows without `schema_version: 2` remain Flow v1 and use direct tool exposure with `classify` and `begin_step`. Updating or creating a flow through the builder defaults it to v2 gateway mode.
