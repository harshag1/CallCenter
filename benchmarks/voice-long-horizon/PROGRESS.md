# Research progress log

## 2026-07-10 — Program opened

Objective: produce reproducible, multi-provider evidence about long-horizon voice-agent reliability, then improve the framework based on observed failures.

Completed:

- Established a hard $1,000 total authorization and a $15 initial canary ceiling.
- Confirmed xAI and OpenAI credentials are available in this checkout and Gemini credentials are available in the GPU Hub checkout; no credential values were printed or copied into tracked files.
- Confirmed local audio tooling: macOS `say`, `ffmpeg`, and `ffprobe` are available.
- Started parallel audits of provider protocols/pricing, benchmark science, repository reuse points, and primary prior art.
- Declared raw and harness conditions plus deterministic-evidence requirements.

In progress:

- Freeze scenario schema, metrics, artifact format, and staged sample-size plan.
- Implement a true-audio provider runner and budget reservation ledger.

Current risks and questions:

- Provider usage payloads differ and may not expose invoice-grade cost.
- Tool event and transcript event names differ across providers and model versions.
- Fixed scripted caller turns maximize reproducibility but can become incoherent after severe agent drift; the protocol must score this rather than silently adapt the scenario.
- Audio synthesis on macOS is deterministic enough for local paired trials but needs a portable fixture story for external contributors.
- Framework enforcement and progressive disclosure must be ablated separately before assigning causality.

No paid provider calls have been made by this program yet.
