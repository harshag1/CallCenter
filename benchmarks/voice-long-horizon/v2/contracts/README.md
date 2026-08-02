# HACC-Proof-v1 contracts

These JSON Schema Draft 2020-12 contracts freeze the HACC-Proof-v1 vocabulary.
They are design and custody contracts, not evidence that any phase passed.

| Contract | Purpose | Example |
|---|---|---|
| `treatment-contract.schema.json` | Defines Registered Native, Full HACC and paired parity | `examples/treatment-contract.example.json` |
| `endpoint-contract.schema.json` | Defines the primary/secondary endpoints, ITT and claim rule | `examples/endpoint-contract.example.json` |
| `budget-contract.schema.json` | Separates the $100 API-testing and $100 benchmark pools | `examples/budget-contract.example.json` |
| `phase-gates.schema.json` | Makes phase admission serial and fail-closed | `examples/phase-gates.example.json` |
| `evidence-manifest.schema.json` | Binds immutable raw/evaluation artifacts and unit disposition | `examples/evidence-manifest.example.json` |

Examples use syntactically valid placeholder SHA-256 values and identities.
They must never be mistaken for run evidence. Every example declares
`example_only: true` where the schema provides that field.

Validation:

```bash
python3 - <<'PY'
from pathlib import Path
import json
from jsonschema import Draft202012Validator

root = Path("benchmarks/voice-long-horizon/v2/contracts")
for schema_path in sorted(root.glob("*.schema.json")):
    schema = json.loads(schema_path.read_text())
    Draft202012Validator.check_schema(schema)
    example_path = root / "examples" / schema_path.name.replace(".schema", ".example")
    example = json.loads(example_path.read_text())
    Draft202012Validator(schema).validate(example)
    print(f"PASS {example_path.name}")
PY
```

Runtime code should consume these contracts only after implementing strict
schema validation, canonical encoding, content hashing, signature/trust pins,
and independent replay. JSON Schema validation alone does not establish
semantic validity, custody, or claim eligibility.
