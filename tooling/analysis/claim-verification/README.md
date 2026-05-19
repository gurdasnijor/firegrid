# Layer-Composition Claim Verification

Verifies (or refutes) four claims made about Analysis A (#372) by
**direct source examination**, not graph inference. Each claim was tested
against pre-committed verdict criteria; verdicts were not reached for.
Every assertion cites `file:line`; spot-checked against the source before
publication. No remediation — these settle what is true, not what to do.

| claim | hypothesis (abbrev.) | verdict | brief's prediction |
|---|---|---|---|
| [1](claim-1-provide-merge-as-mechanism.md) | 33 provideMerge sites collectively perpetuate the A↔B cycle | **REFUTED** | "likely PARTIAL" |
| [2](claim-2-inline-engine-durability.md) | inline WorkflowEngine composition discards durability at restart | **REFUTED** | "likely UNVERIFIED" |
| [3](claim-3-provide-merge-sample.md) | most provideMerge sites should be provide (sample of 8) | **REFUTED** (8/8 load-bearing) | "genuinely unknown" |
| [4](claim-4-shared-root.md) | the cycle and inline composition share a root mechanism | **CONFIRMED** | "likely REFUTED/PARTIAL" |

## What the verdicts establish (descriptive, not prescriptive)

Three of the four claims are **not supported by the source**:

- The named "`RuntimeToolUseExecutorLive` ↔ `runtimeContextWorkflowSupportLayer`
  cycle" is not a 2-node Layer cycle (Claim 1). It is a single localized
  **required-what-it-provided self-edge** on the `DurableWait*` family,
  internal to one layer and already deliberately managed in-place — and
  documented as such in-source (`runtime-context-workflow-support.ts:28-31`).
- "Inline WorkflowEngine composition" is a misclassification (Claim 2):
  the engine is a catalogued `Layer.scopedContext` layer
  (`DurableStreamsWorkflowEngine.layer`); host-sdk `Layer.succeed` sites
  re-inject an already-built, durably-backed handle; durability across
  engine reconstruction is exercised by passing runtime tests.
- `provideMerge` is not an unjustified accretion at the sampled sites
  (Claim 3): 8/8 are load-bearing, several with in-code hazard comments
  warning against the exact `provide`/`merge` substitution proposed.

The one **CONFIRMED** claim (4) is the narrowest: the genuine
require-what-it-provided edge and the per-execution `Layer.succeed`
engine supply are literally the same `.pipe` expression and share one
documented root — treating the workflow engine as a per-execution
runtime *handle* (TFIND-031 Option Y), not a hidden defect.

## Honest framing

The interpretation that generated these four claims was substantially
**wrong on mechanism and durability** (1, 2, 3) and **right that the
cycle-region and inline supply share a root** (4) — though that root is
a documented design decision, not an undiscovered fault. The brief's
predictions were themselves off in the conservative direction (it
expected PARTIAL/UNVERIFIED where the source supported firmer REFUTED,
and REFUTED where the dependency path supported CONFIRMED). Predictions
updated; verdicts stand on the cited evidence.

## Method & limits

- Worktree off `origin/main`; ts-morph not used — direct `grep`/source
  reading per the "direct examination, not graph inference" constraint.
- The 33-site census was enumerated; Claim 3 classified an 8-site
  mandated sample (bound stated in that doc).
- No symbol-resolution blockers were hit; no claim is UNVERIFIED.
- What this is **not**: a refactoring proposal, runtime tracing, or a
  validation of the wider "engine-durability discard" framing. Each
  claim was verified independently.
