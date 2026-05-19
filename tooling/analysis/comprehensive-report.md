# Firegrid Comprehensive Insight Report

Builds on `leaf-findings.md` (Phase 1) and `calibration-report.md`. Same
discipline: precommitments first, no remediation, honest disconfirmation.

**Scope honesty (read first).** This brief commissions ~9–10 days across
S1–S6 / R1–R4 / D1–D4. It is being executed **gated**, not in one pass:
S1+S2 (the decision crux the calibration left open) first, then an
evaluation gate decides whether the heavier remainder (S3–S6, runtime
tracing, design synthesis) is warranted — mirroring the Phase-1→calibration
gating the brief itself praises. Sections below are marked DONE / GATED /
PENDING. Nothing is claimed run that wasn't.

## Precommitments (written before results)

| # | Analysis | refactor-in-place if… | toy-first redesign if… | verify-first if… | doc-first if… |
|---|---|---|---|---|---|
| S1 | capture-coverage | captures <20L, most captured tags unused | captures 200L+, most tags consumed (load-bearing) | — | many captures but thin coverage (S5) |
| S2 | union accretion | low pairwise overlap (real tiers, separable) | high overlap (>70% — accreting to one tier) | — | — |
| S3 | service graph | no cycles (composition reorder suffices) | cycles present (architectural intervention) | — | — |
| S4 | boundary honesty | minimal internal reach | — | — | — |
| S5 | verification census | exports integration-tested | — | mostly stubbed/none | — |
| S6 | blast radius | small radius on key symbols | large radius (refactor expensive) | — | — |
| D1 | implicit contracts | — | — | — | substantial → RFC profile high value |
| D2 | refactor-cost map | most TRIVIAL/MODERATE | several RISKY | — | — |
| D3 | component boundary | components↔packages align | — | — | misaligned → package refactor due |
| D4 | adjacency | host-sdk anomalous (targeted) | — | — | other pkgs similar → generalize |

## Static findings

### S0 — Capture-site recount (grounding finding, DONE) — *updates the calibration*

The "4 capture sites" the calibration & this brief inherited is an
**undercount**. The branch has **≥6–7 real `Effect.context<>` captures**:

| site | captured type | in canonical 4? |
|---|---|---|
| `host/commands.ts:156` | `HostRuntimeContextExecutionEnv` | yes |
| `host/agent-tool-host-live.ts:218` | `HostRuntimeContextExecutionEnv` | yes |
| `host/runtime-substrate.ts:94` | `RuntimeToolUseExecutorHostEnvironment` | yes |
| `host/mcp-host.ts:115` | union (multi-line) | yes |
| `host/runtime-context-workflow-core.ts:463` | `RuntimeContextWorkflowExecutionEnv` | **no — missed** |
| `host/runtime-context-session/common.ts:241` | union | **no — missed** |
| `agent-tools/execution/toolkit-layer.ts:229` | `ToolCallHostEnvironment` (`Effect.map` form) | **no — missed** |

Cause: Phase-1's `effect-context-in-layer-builder` rule constrained
`inside: Layer.{effect,scoped,unwrapEffect}`, so it only matched captures
lexically inside a Layer constructor. The 3 missed ones are real captures
in helpers / `Effect.map` form composed into layers later. **Phase-1
rule false-negative; the load-bearing-surface denominator is ~1.5–2× the
assumed.** S1 runs against the true ≥6-site set, not the canonical 4.

### S1 — Capture-coverage depth — *PENDING (analyzer next; corrected site set)*
### S2 — Type-union accretion — *PENDING (after S1)*
### S3–S6 — *GATED on the S1/S2 evaluation*

## Runtime findings — *GATED (Part 2; only if S1/S2/S3–6 warrant)*
## Design insights — *GATED (Part 3; synthesizes Parts 1–2)*

## What this changes — *deferred to synthesis (do not pre-judge)*
## What this doesn't settle — *deferred to synthesis*

## Out-of-scope log (per the hard scope constraint)
- (none yet — new-analysis ideas land here, not in the work)
