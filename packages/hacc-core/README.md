# `@hacc/core`

Provider-neutral definitions for agents, progressive flows, tools, repeatable
scenarios, and deterministic offline tests.

```ts
import {
  createTestRuntime,
  defineAgent,
  defineFlow,
  defineScenario,
  defineTool,
} from "@hacc/core";
```

Definitions are inert: importing or defining an agent never reads environment
variables, discovers plugins, starts a server, or opens a connection. Tool code
runs only after an explicit `runtime.invokeTool(...)` or scenario tool event.

`createTestRuntime` is deliberately an offline contract runner, not a production
effect gateway. It verifies progressive capability exposure, required outputs,
transitions, validators, per-step call limits, receipts, and scenario assertions.
Production hosts remain responsible for durable authorization, idempotency,
reconciliation, audibility, and provider lifecycle handling.
