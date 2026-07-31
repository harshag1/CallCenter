# Safe Flow v2 import and export

The Flow package helper turns a Flow v2 JSON definition into a deterministic,
reviewable artifact and refuses to materialize it until its complete tool
dependency set is present. It does not write to the database or attach a flow
to a live agent.

From `web/`, inspect any of the deep examples:

```bash
npx tsx scripts/flow-package.ts inspect \
  ../examples/flows/service-appointment-lifecycle.json
```

The report includes semantic diagnostics, a canonical SHA-256 digest, every
referenced tool and its exact source paths, and the catalog closure status.
Reconciliation query tools and receipt-bound source tools are dependencies too;
they are not hidden behind the write action.

## Dry-run an installation

Create a catalog containing the names actually registered in the target
environment. This abbreviated shape example is not a complete catalog for the
service-appointment flow:

```json
{
  "tools": [
    "contact_support",
    "request_recall",
    "end_call",
    "lookup_service_customer"
  ]
}
```

Then run:

```bash
npx tsx scripts/flow-package.ts import \
  ../examples/flows/service-appointment-lifecycle.json \
  --catalog ./tool-catalog.json \
  --dry-run
```

The command exits nonzero when the flow is invalid, a reconciliation contract
is malformed, or any dependency is missing. A valid flow without an explicit
catalog is intentionally not install-ready.

After a successful dry-run, materialize the canonical definition into a new
file:

```bash
npx tsx scripts/flow-package.ts import \
  ../examples/flows/service-appointment-lifecycle.json \
  --catalog ./tool-catalog.json \
  --out ./service-appointment.installable.json
```

Output uses exclusive creation and never overwrites an existing file. Attaching
that file to an agent remains an explicit, authenticated application action.

## Immutable exports

Create a portable review artifact:

```bash
npx tsx scripts/flow-package.ts export \
  ../examples/flows/service-appointment-lifecycle.json \
  --out ./service-appointment.hacc-flow.json
```

An export contains:

- a fixed format and version;
- the canonical Flow v2 definition;
- a domain-separated SHA-256 digest; and
- a dependency manifest derived from the flow.

Import recomputes both the digest and dependency manifest. Changing the flow,
adding an unrecognized field, or editing the dependency list invalidates the
artifact. Object key order and source whitespace do not change the digest.

## Library API

Server-side builders can use `web/lib/flow-package.ts` directly:

```ts
const plan = analyzeFlowV2Import(sourceJson, {
  availableTools: registeredTools.map((tool) => tool.name),
});

if (!plan.readyForInstall) {
  throw new Error(`missing: ${plan.catalog.missing.join(", ")}`);
}

const immutableFlow = materializeFlowV2Import(plan);
```

`analyzeFlowV2Import` is side-effect free. `materializeFlowV2Import` returns a
deep-frozen clone only after catalog-closed admission succeeds.

## Scope of the guarantee

The helper proves Flow shape, semantic topology, resource bounds,
reconciliation-contract shape, canonical identity, and tool-name closure. It
does not prove that a registered integration enforces tenant authorization,
honors idempotency, returns its declared schema, or performs the intended
real-world effect. Those remain deployment and integration tests.
