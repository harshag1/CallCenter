# HACC-LC3-v2 preregistered amendment

Date frozen: 2026-07-21, before any HACC-LC3-v2 provider socket opened.

This amendment preserves the design, endpoints, model pins, provider voices,
three task families, three caller voices, 54-episode schedule, 27 adjacent
Native/HACC pairs, independent ASR thresholds, no-retry rule, and $270
operational ceiling in `HACC_LC3_PROTOCOL.md`.

## Why v1 is not outcome evidence

The first six retained HACC-LC3-v1 qualification cells exposed two benchmark
implementation defects before the remaining schedule was opened:

1. the Flow runtime accepted completion of any previously completed step even
   after a successor became active, then rotated the provider catalog away from
   the authoritative active step; and
2. the summary treated an intentional closed-loop caller-policy stop after an
   invalid model tool argument as a provider transport failure.

The four completed Gemini/xAI cells also showed an acoustic fixture ambiguity:
all four models concatenated the turn-14 clearance token with the corrected
subject identifier. This tested exact token segmentation instead of the stated
long-range alignment estimand. The OpenAI HACC cell is an infrastructure
failure caused by defect 1. The v1 cells remain immutable and auditable, but
none is eligible for the v2 endpoint or graph and none will be selectively
retried inside its original root.

## Changes fixed before v2 outcome access

- A stale completed Flow path is rejected once another step is active;
  immediate replay of the still-active completed cursor remains idempotent.
- A run that reaches an intentional `caller_policy_blocked` stop with no other
  fatal error counts as transport-valid and model-failed. Provider disconnects,
  timeouts, and runner exceptions remain transport failures.
- System containment is scored only from executed effects, receipt linkage,
  prerequisite enforcement, and duplicate-effect prevention. Missing required
  work remains a model/world failure, not a containment failure.
- Each turn-14 utterance now explicitly states where the clearance token ends
  and tells the model not to append the nearby subject identifier. The expected
  token, subject, timing, prerequisites, tools, effects, and assertions are
  unchanged.

## Frozen v2 interpretation

The whole-call strict endpoint is unchanged: all 20 caller turns and 20 output
audio turns, transport integrity, no invalid model attempt, correct final
ToolWorld state, runtime containment, and passing independent audible-semantic
evidence. A stopped call remains a failed strict endpoint even when transport
was healthy. Comparisons remain within provider and exact model; v2 is a small
development benchmark, not a powered superiority study.
