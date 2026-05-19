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

### S1 — Capture-coverage depth (DONE, corrected 7-site set) — *disconfirms "over-engineered captures"*

`tooling/analysis/baseline/s1-capture-coverage.json`. All 7 capture
closures: **min 0, max 28 LOC** — none remotely near the 200-line
"load-bearing monster" precommitment threshold. **5/7 re-provide** the
captured context into a deferred effect.

| site | T (members) | touched | over | LOC | reProvided |
|---|---|--:|--:|--:|---|
| toolkit-layer.ts:229 | ToolCallHostEnvironment (6) | 3 | 3 | 0* | yes |
| agent-tool-host-live.ts:218 | HostRuntimeContextExecutionEnv (4) | 2 | 2 | 23 | no |
| commands.ts:156 | HostRuntimeContextExecutionEnv (4) | 1 | 3 | 24 | yes |
| mcp-host.ts:115 | CurrentHostSession\|RuntimeControlPlaneTable (2) | 2 | 0 | 28 | yes |
| common.ts:241 | (4-member union) | 4 | 0 | 22 | no |
| workflow-core.ts:463 | RuntimeContextWorkflowExecutionEnv (8) | 0 | 8 | 15 | yes |
| runtime-substrate.ts:94 | RuntimeToolUseExecutorHostEnvironment (5) | 0 | 5 | 26 | yes |

\*`Effect.map` form (no arrow ancestor) — measurement edge, still small.

**Honest reading (the heuristic must not mislead).** The high `over` on
reProvided sites (workflow-core 8/8, runtime-substrate 5/5) is **not**
"wasteful over-capture to trim" — it is a **bulk context relay**: capture
the whole env, re-provide it wholesale across a deferred boundary, never
destructure. So the naive "cheap-to-eliminate" verdict the script prints
for those is wrong; they are *structurally load-bearing as relays*.
`touched` is a crude textual heuristic (member short-name appears in
closure) — directional, not exact. Net: captures are **small + localized
relays (≤7 sites, ≤28 LOC each)**, not a sprawling over-engineered web.
The "over-engineered substrate via huge captures" hypothesis is
**disconfirmed on size**; the real shape is "≤7 small deferred-context
relays" — a *moderate, contained* refactor surface, not a rewrite.

### S2 — Type-union accretion (DONE) — *disconfirms "unions accreting to one tier"*

`tooling/analysis/baseline/s2-union-accretion.json`. Sizes 4/8/6/6/5.
**No pair exceeds the 0.70 accretion threshold (`flagged_over_70: []`).**
Highest: Host↔ToolCall **0.67**, Host↔Workflow 0.5, Workflow↔ToolUse
0.44, Workflow↔ToolCall 0.40. `RuntimeContextSessionAdapterRequirements`
is **disjoint (0.0)** from all — a genuinely independent tier.

Per the precommitment (>70% → one accreting tier): **the unions are
distinct tiers, not version-accretion.** A related substrate core
(Host/ToolCall/Workflow share ~0.4–0.67 on common tags like
`CurrentHostSession`) but no convenience-union consolidation pathology.
Public-signature footprint is low (≤1 sig ref each — caveat: the sigRef
heuristic undercounts `R`-channel uses in `Effect.Effect<…,…,R>`, so read
as "low," not exact). The "toy-first to consolidate accreting unions"
justification is **removed** — there is nothing accreting to consolidate.

### S3 — Service-dependency cycles (RUN; INCONCLUSIVE-as-built — itself a finding)

`s3-service-graph.{json,dot}` + analyzer committed. Honest result: the
static graph is **not credible** — `tags=8, edges=2, cycles=0`, but an
idiom-agnostic grep finds **29** tag declarations in host-sdk+runtime, and
a scope probe confirms ts-morph loaded **only host-sdk's tsconfig (50
files, 0 runtime files)**. The substrate's service tags live in
`runtime`/`protocol`, never in the project. So "cycles=0" is a
**project-scope artifact**, not evidence of acyclicity, and is **not
reported as a finding**. A credible S3 needs a multi-tsconfig ts-morph
load (host-sdk+runtime+protocol) — that is a real effort expansion past
S3's ~1-day budget, into the cut-remainder cost class.

Per the brief's "if an analysis didn't surface decision-relevant signal,
that itself is a finding": **static S3 did not settle the cost class.**
The better available evidence is the brief's own stated anchor — the
PR #363 cascade *was* a provideMerge cycle. Taking that as given (brief
context, not re-derived from a broken graph): **substrate provideMerge
cycles have occurred in practice.** Per the S3 precommitment that places
the in-place relay refactor in the **architectural-intervention cost
class where it touches the provideMerge composition** — not naive
composition reorder — but localized, consistent with S1's ≤7 small
relay sites. Secondary signals from the (partial) run: `AgentToolHost`
has 3 Live constructions, `RuntimeContextWorkflowSession` 2 — multi-Live
tags worth a documentation note, not a redesign trigger.

### S4–S6 — see gate below.

## Runtime findings (Part 2) — *cut at gate (see below)*
## Design insights (Part 3) — *cut at gate (see below)*

## What this changes (the quality gate — concrete)

Both crux analyses point the same way, and they **remove**, not just fail
to support, the redesign justifications:

- **toy-first redesign is NOT justified by "over-engineered substrate."**
  S0+S1: the capture surface is ≤7 sites, every closure ≤28 LOC, mostly
  small bulk relays. Calibration already showed structural density
  1.0/KLOC and a clean boundary. Nothing here is rewrite-scale.
- **toy-first is NOT justified by "accreting type unions."** S2: no pair
  >0.70; the unions are distinct tiers, one fully disjoint. There is no
  accretion to consolidate.
- **Refactor-in-place is supported, scoped as: restructure ≤7 small
  deferred-context relays.** This is *moderate* (the relay re-provision
  coupling is real design work) but *localized and enumerated*, not a
  substrate redesign. Concrete in-place candidates: the 5 reProvided
  relay sites (workflow-core:463 & runtime-substrate:94 are pure
  pass-through — the cleanest to reason about first).
- **Cost class = architectural-aware, not naive reorder.** S3-static was
  run and is inconclusive-as-built (scope artifact, §S3). The brief's
  stated anchor — PR #363 *was* a provideMerge cycle — is the better
  evidence: substrate composition cycles have occurred in practice, so
  the in-place refactor of the relay sites that touch the provideMerge
  composition is **architectural-class work, done carefully**, not a
  one-line reorder. Still in-place, still ≤7 localized sites — *not* a
  toy-first rewrite. Concrete first targets: `workflow-core:463` &
  `runtime-substrate:94` (pure pass-through relays — lowest-risk to
  restructure first); treat any change crossing the provideMerge seam as
  cycle-sensitive.
- **STOP. Do not run S4, S5, S6, Part 2, Part 3, or a multi-project S3.**
  Per the brief's own "compress what's redundant" + "don't expand":
  S4 boundary is already answered by calibration A6 (87% public). S6
  blast-radius is largely covered by A6 + S1 reProvided/refs. A *credible*
  S3 needs a multi-tsconfig ts-morph build — effort past its budget, and
  the cost-class question is already answered well-enough-to-decide by
  the #363 anchor + S1's localization. S5 census + Part 2 tracing + Part 3
  synthesis are 6+ days whose output no longer changes the decision
  S1/S2/S3-anchor settled. Running any of it is the arc-bloat this brief
  is structured against.

## What this doesn't settle (honest)

- **Exact cycle topology** — *which* tags form the provideMerge cycle and
  whether more than the #363 one exists — is NOT mapped (static S3
  scope-limited; a credible graph needs multi-project ts-morph, out of
  budget/scope). We know cycles occur (so: architectural-aware refactor);
  we do not have the precise cycle set. If a future pass wants the exact
  topology, the multi-tsconfig S3 is the tool — logged out-of-scope, not
  done here.
- **Whether the substrate's claimed behavior actually happens at
  runtime** (the smoke-test-doesn't-test concern) — Part 2 would have
  shown this; it is cut, so this remains *unverified by this work*.
  Honest: the toy-first decision does not need it, but runtime
  trustworthiness of the substrate is not established here.
- **Verification coverage of public exports** (S5) — not measured;
  unknown whether in-place refactors would be caught if they broke
  something. A real residual risk, explicitly unsettled.
- S1's `touched`/over-capture exactness (textual heuristic) and S2's
  sigRef count (FunctionTypeNode-only) are directional, not authoritative
  — the *decisions* above hold on the robust signals (closure size,
  >0.70 flag), not the soft metrics.

## Out-of-scope log (per the hard scope constraint)
- Multi-tsconfig (host-sdk+runtime+protocol) ts-morph service graph for
  exact provideMerge cycle topology. Surfaced by S3's scope limit;
  **not run** (past budget; cost class already decided). Logged, not
  expanded — the next brief commissions it if warranted.

---
**Stop condition met:** report committed; `What this changes` makes
concrete decisions (toy-first not justified; refactor-in-place,
architectural-aware, ≤7 enumerated sites, first targets named; stop);
`What this doesn't settle` is honest (runtime trustworthiness + S5
coverage + exact cycle topology explicitly unestablished). No follow-up
analyses proposed.
