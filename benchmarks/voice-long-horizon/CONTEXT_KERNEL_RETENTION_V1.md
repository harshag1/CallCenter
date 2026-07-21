# Context-kernel retention v1

Status: deterministic mechanism evidence, not a model-quality or provider-superiority result.

The benchmark ran 1,000 seeded conversations between 500 and 2,000 turns. Each conversation contained 13 future-relevant control units: one policy invariant, one active goal, eight authoritative facts (four later corrected), and three open commitments. Ordinary turns added realistic context pressure but no authority.

At the final opportunity, the benchmark compared:

- the event-sourced kernel packet;
- the most-recent whole transcript turns that fit the identical UTF-8 byte budget; and
- unbounded full history as a size/recall reference.

Generator: `web/scripts/conversation-kernel-retention.ts`  
Seed: `1212236611`  
Raw result: `CONTEXT_KERNEL_RETENTION_V1.json`

## Result

| Packet budget | Kernel recall | Recent-window recall | Kernel overflow | Mean full history |
|---:|---:|---:|---:|---:|
| 1,024 B | 0 / 13,000 | 9 / 13,000 | 1,000 / 1,000 | 116,110 B |
| 2,048 B | 13,000 / 13,000 | 83 / 13,000 | 0 / 1,000 | 116,110 B |
| 4,096 B | 13,000 / 13,000 | 253 / 13,000 | 0 / 1,000 | 116,110 B |
| 8,192 B | 13,000 / 13,000 | 622 / 13,000 | 0 / 1,000 | 116,110 B |

The useful result is not merely the 100% recall above 2 KB. The 1 KB stratum proves the safety behavior: the runtime did not silently discard an invariant, fact, goal, or obligation to fit the budget. It raised `context_overflow` on every schedule. Builders can route that state to escalation, retrieval, or a larger packet instead of allowing invisible drift.

At 2 KB, the mean compiled packet was 1,945 bytes versus 116,110 bytes for full history, a 98.3% byte reduction while retaining every registered durable unit. The equally bounded recent-turn window retained 0.64% of units. At 4 KB it retained 1.95%.

## What this does and does not establish

This establishes a reproducible property of the context substrate: registered authoritative state survives long conversational interference under a fixed packet budget, corrections replace stale revisions, and overflow is explicit.

It does not establish that OpenAI, Gemini, or xAI speech models complete more missions with the packet. The recent-window comparator is not a provider model. That causal question belongs to the preregistered paired HACC-VMR-v1 study after the shared worker, reconnect, and audible-evidence paths pass their gates.
