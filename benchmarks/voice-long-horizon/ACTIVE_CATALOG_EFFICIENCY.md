# Active capability catalog efficiency

<!-- markdownlint-disable MD013 MD060 -->

Status: **C1 engineering evidence**, `$0` provider spend. This benchmark measures exact production serialization, compiler containment, a frozen no-retry catalog-exposure census, and private-authority non-disclosure. It does **not** measure invocation success, arbitrary caller-path reachability, model quality, provider latency, prompt or billed-token savings, or long-conversation superiority.

## Current frozen result

An independent red-team review rejected the first draft because it omitted the two JSON array brackets, conflated logical-entry bytes with provider instructions, and called a fixed linear census “reachability.” The result below supersedes that withdrawn draft and refreshes the exact provider-instruction measurements after the production wrapper added durable-context-packet replacement guidance on July 28, 2026.

- Portable semantic result hash: `7ec332b0db56908924ceef07151a033d90fa0bf56c2145bdf1f65e8373d65442`
- Source-manifest hash: `9dd1fda3382d3566dbd0f93fdbcaa03634c57fc430831e2013362b7fc0b63fba`
- Deterministic-build manifest hash: `d7f59259e57b998806e4e34dd12800a43c250a768d1f4c2856be07ca0156b455`
- Observed-toolchain manifest hash: `419ad3ce70d8af1ce32b62146dcd48b32459eef083f0268edc82164904e74a25`
- Source/build/toolchain-bound evidence hash: `6d7969749fcb0d5080e9f5b93913aeea8093ef427b64b5ab224f0eb18cf263bb`
- Pretty JSON artifact in the recorded environment: 37,398 bytes; SHA-256 `2a5eb967ea915816ab9fa70bcf32b8522236309983d3d789c54c4979886c3013`
- Raw corpus file: 13,497 bytes; SHA-256 `67f1153d90ab578916fb31ce6b543aa74d382374453a1718ab5675bc8ae1df1b`
- Parsed canonical corpus JSON: 11,932 bytes; SHA-256 `89452f09d62f3588e6b37acdd914aaa1c3b612c7ed89cb9b1a7ca3beeabc72c7`
- Corpus: 8 sequential phases × 8 unique tools = 64 tools; 32 read and 32 write
- Census: 18 real Flow-v2 snapshots—routing, topic selection, 8 active phases, 7 between-phase transitions, and terminal
- Frozen catalog exposure: all 64 target definitions appeared once across the eight preselected active snapshots; 0 missing targets and 0 cross-phase business-tool leaks
- Private binding: 64/64 exposed logical names resolved to private host bindings in memory; 0 forbidden private-key hits and 0 private grant/expiry sentinel hits in catalogs, instruction blocks, or the report

The observed artifact was generated on Node `v24.8.0` / V8 `13.6.233.10-node.27`, Darwin arm64, under the declared Node engine `^20.19.0 || ^22.13.0 || >=24.0.0`, with installed and lockfile versions equal for tsx `4.23.0`, TypeScript `5.9.3`, Vitest `4.1.10`, and Zod `4.4.3`. The toolchain manifest also records the exact `benchmark:active-catalog` command and the truthful `db:test-integration` alias (`node scripts/test-tenant-isolation.mjs`). A run on another valid runtime can retain the portable semantic result hash while producing a different toolchain/evidence hash and pretty-file hash.

The public corpus is [active-catalog-efficiency-64.v1.json](corpora/active-catalog-efficiency-64.v1.json). It spans identity, membership, billing, orders, returns, scheduling, communications, and escalation rather than optimizing for one call-center script.

## Three distinct size surfaces

The report deliberately keeps three quantities separate:

1. **Logical-entry array:** canonical JSON for only the business-entry array, including `[` and `]`. This is the only surface compared with the non-dispatchable raw-full 64-entry reference.
2. **Full production catalog:** exact UTF-8 bytes from `JSON.stringify(authority.catalog)`, including controls, durable active context, digests, and disclosure metrics.
3. **Provider instruction block:** exact output of `activeCapabilityCatalogInstructions(catalog)`, including the full production catalog plus its 892-byte instruction wrapper in this corpus.

| Measure | Raw-full reference | Progressive active phase | Interpretation |
|---|---:|---:|---|
| Business tools | 64 | 8 in every active phase | 87.5000% count reduction |
| Total logical tools including controls | Not a dispatchable catalog | 11 in every active phase | 8 business + 3 flow controls |
| Canonical logical-entry JSON array | 63,960 bytes | 7,944 min; 7,989 median; 8,075 max | 87.3749% min; 87.5094% median; 87.5797% max reduction |
| T4 for logical-entry array | 15,990 | 1,986 min; 1,998 median; 2,019 max | 87.3734% min; 87.5047% median; 87.5797% max reduction |
| Full production catalog JSON | No valid raw-full envelope | 10,956 min; 11,363 median; 11,702 max | Absolute production size only |
| T4 for full production catalog | Not comparable | 2,739 min; 2,841 median; 2,926 max | Absolute estimate only |
| Provider instruction block | No valid raw-full instruction block | 11,848 min; 12,255 median; 12,594 max | Exact production block size |
| T4 for provider instruction block | Not comparable | 2,962 min; 3,064 median; 3,149 max | Absolute estimate only |

T4 is `ceil(UTF-8 bytes / 4)` per snapshot. It is a deliberately rough cross-provider sizing estimate, not provider-reported tokenization, prompt savings, billed usage, or cumulative session cost. The median can be fractional because it is the midpoint of eight integer snapshot estimates.

## Logical-definition parity, not byte identity

The raw-full reference is a literal canonical JSON array—including its opening and closing brackets—assembled from 64 one-entry, non-dispatchable reference authorities. Its exact SHA-256 is `99f752ff89fe82e2733c13cb7b1ec5c8919ef57c317f771c3129e2b98d22aa63`. Every leased action carries a 64-character `lease_scope_digest` bound to its runtime state. Consequently, **0/64 active entries are byte-identical to their reference entry**.

The benchmark normalizes only `host_bound_action.invocation.lease_scope_digest` to 64 ASCII zeroes on both sides. After that single normalization, the separately assembled reference and active-census arrays are both 63,960 bytes and have the same SHA-256, `67dc22c0de1ba2e074f01c0f3446727e3529f8bb0e12008961d3021a28023167`: 64/64 definitions and byte shapes match, with 0 other mismatches. Because the real digests are the same fixed length, the active-vs-reference array-size comparison remains exact; the report does not claim the unnormalized bytes are identical.

## Exact active phases

| Phase | Exact active business tools | Entry-array bytes / T4 | Full catalog bytes / T4 | Provider instruction bytes / T4 |
|---|---|---:|---:|---:|
| Identity | `check_identity_match`, `create_identity_review`, `inspect_consent_status`, `list_verification_methods`, `lock_customer_profile`, `lookup_customer_profile`, `record_verification`, `update_contact_details` | 8,075 / 2,019 | 10,956 / 2,739 | 11,848 / 2,962 |
| Membership | `change_membership_plan`, `check_membership_benefits`, `list_membership_plans`, `lookup_membership`, `pause_membership`, `quote_membership_renewal`, `renew_membership`, `send_membership_receipt` | 8,009 / 2,003 | 11,005 / 2,752 | 11,897 / 2,975 |
| Billing | `collect_payment`, `create_payment_plan`, `explain_charge`, `list_recent_charges`, `lookup_invoice`, `quote_payment_plan`, `send_billing_receipt`, `update_payment_method` | 7,944 / 1,986 | 11,071 / 2,768 | 11,963 / 2,991 |
| Orders | `cancel_order`, `check_fulfillment_status`, `list_order_items`, `locate_order`, `quote_delivery_window`, `reroute_shipment`, `send_tracking_update`, `update_shipping_address` | 7,978 / 1,995 | 11,280 / 2,820 | 12,172 / 3,043 |
| Returns | `check_return_eligibility`, `create_return`, `estimate_refund`, `issue_return_label`, `list_return_methods`, `lookup_return_policy`, `schedule_return_pickup`, `send_return_confirmation` | 7,989 / 1,998 | 11,446 / 2,862 | 12,338 / 3,085 |
| Scheduling | `book_appointment`, `cancel_appointment`, `check_availability`, `inspect_provider_constraints`, `list_appointments`, `quote_appointment_options`, `reschedule_appointment`, `send_appointment_reminder` | 8,021 / 2,006 | 11,526 / 2,882 | 12,418 / 3,105 |
| Communications | `check_callback_window`, `inspect_delivery_status`, `list_supported_languages`, `schedule_callback`, `send_email`, `send_sms`, `transfer_call`, `verify_contact_channel` | 7,962 / 1,991 | 11,595 / 2,899 | 12,487 / 3,122 |
| Escalation | `add_case_note`, `check_service_health`, `create_support_case`, `handoff_to_human`, `inspect_case_history`, `list_escalation_queues`, `page_on_call_specialist`, `search_knowledge` | 7,989 / 1,998 | 11,702 / 2,926 | 12,594 / 3,149 |

Routing exposed only `classify` and `get_flow_state`. Topic selection and each between-phase transition exposed only `enter_step` and `get_flow_state`. Terminal exposed only `get_flow_state`. No business action from a completed or future phase appeared in those snapshots.

## Compiler, exposure, and security result

The same 64 tools split across eight steps pass `assertFlowToolCatalogClosure`. A single flat step fails closed because its 64 business tools plus the worst-case four controls would disclose 68 capabilities, over the 16-tool reliability budget. Direct construction of a 64-source active catalog is independently rejected by the same 16-tool budget.

This is a **frozen linear no-retry census**, not a general reachability or invocation test. It preselects the one eight-phase route and observes which definitions the production catalog exposes. It does not prove that a model selects a tool, that the backing integration succeeds, or that every arbitrary caller-driven path reaches every tool.

For every active phase, the benchmark also:

1. binds each of its eight logical names to the private `run_action` target in host memory without executing the integration;
2. rebuilds the catalog with reversed source order, different private grant bytes, and a different private expiry;
3. requires byte-identical public catalogs and digests across those private changes;
4. scans the catalog, provider instruction block, and result report for private authority fields and sentinel values;
5. recomputes production catalog bytes and T4 instead of trusting self-reported disclosure metrics.

## Reproduce

From `web/`:

```bash
npm run benchmark:active-catalog -- --out ../benchmarks/voice-long-horizon/.local/active-catalog-efficiency-local.json
npx vitest run lib/benchmark/__tests__/active-catalog-efficiency.test.ts
```

The publisher is no-clobber: use a new output filename for a second run. The report embeds raw/canonical corpus hashes; a nine-file source manifest; a deterministic build manifest binding the exact corpus, canonical Flow, runtime digest, fixed census construction, and literal-array serializer; exact serializer and estimator versions; package and lockfile hashes; observed Node, V8, platform, architecture, and installed dependency versions; the portable semantic result hash; and the source/build/toolchain-bound evidence hash.

## Claim boundary and next gate

This result supports: “In a frozen 18-snapshot no-retry census, the production serializer exposed each definition in a representative 64-tool corpus once, narrowed every active phase to eight relevant business tools plus three controls, rejected flat disclosure, and did not disclose private leases in the tested serialization path. The active business-entry arrays were 7,944–8,075 bytes versus a 63,960-byte non-dispatchable 64-entry reference array.”

It does not support: “models forget less,” “all caller paths can reach every action,” “integrations execute successfully,” “providers use 87% fewer prompt or billed tokens,” or “the framework beats raw agents.” Those require preregistered paired C4 provider trials using the same model, voice, audio, caller world, and tasks in both arms.
