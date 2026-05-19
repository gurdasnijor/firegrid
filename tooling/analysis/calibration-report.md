# Arch-Archaeology — Calibration Report

Purpose: independently verify or **disconfirm** the diagnosis that the
host-sdk substrate is over-engineered and warrants a toy-first redesign.
Precommitments are stated first so the reader can see whether the data
actually moved the diagnosis — not confirmation theater.

## Precommitments (written before reading results)

| # | Analysis | **Supports** redesign diagnosis if… | **Disconfirms** if… |
|---|---|---|---|
| 1 | Accretion over time | captures/TFIND introduced in reactive bursts tied to incident fixes | introduced deliberately at design time, or flat (not accreting) |
| 2 | Touch recency | Phase-1 finding sites are the most-churned files (smells = active pain) | finding sites are stable/dormant old code |
| 3 | Calibration vs @effect/* | host-sdk structural density markedly higher than Effect's own libs | comparable to / below @effect/* (patterns are idiomatic Effect) |
| 4 | Capture coverage | each capture fans out into large downstream surface (load-bearing) | captures have tiny, localized downstream footprint |
| 5 | Verification gap | public exports largely untested/stub-only (complexity unpinned, risky) | exports integration-tested (complexity pinned → evolve incrementally) |
| 6 | Consumer surface | consumers reach internal paths heavily (over-exposed/leaky) | consumers use the public entry (boundary clean) |
| 7 | Refactor probes | removing captures/provideMerge/cast triggers wide cascades | removals are local/contained (more separable than it looks) |

## Results

### A1 — Accretion over time (bash) — **disconfirms (weakly)**
Effect.context additions and TFIND comments in host-sdk history resolve to
a **single recent window (2026-05)**; no long arc. The codebase is young
with compressed history, not slowly accreted. The "accreted reactively
over time" framing is **unsupported** — this was fast recent construction,
not erosion. (Inconclusive on intent; conclusive against "slow accretion.")

### A2 — Touch recency (bash) — **supports (weakly, non-discriminating)**
All host-sdk `.ts` touches fall within 30d (126; identical at 30/60/90 —
the package is ~weeks old). Essentially **every** Phase-1 finding-site file
was touched in 90d. Smells are in actively-churned code, not dormant — but
since the *entire* package is the hot zone, co-location of smells with
churn is expected and weakly discriminating.

### A3 — Calibration vs @effect/* (ast-grep) — **disconfirms the strong claim**
Per-KLOC, Phase-1 rule pack:

| target | raw /KLOC | **structural-only** /KLOC (ex-TFIND) |
|---|--:|--:|
| @effect/workflow | 0.00 | 0.00 |
| @effect/platform | 0.14 | 0.14 |
| **@firegrid/host-sdk** | **13.50** | **1.01** |

The raw 13.5 (≈100× @effect) is **confirmation theater**: ~95% is
`tfind-anchor-comment` — the team's *annotation convention*, which @effect
structurally cannot have. The honest structural figure is **1.01/KLOC =
6 sites** (4 `effect-context-in-layer-builder` + 2
`manual-scope-buildwithscope`), ~7× @effect/platform. Elevated but
**small and precise**, not a sprawling over-engineered substrate. The
"over-engineered" headline does not survive a fair denominator.
(@effect/ai not vendored; OSS-app calibration not run — scope/network.)

### A6 — Consumer surface (bash) — **disconfirms**
15 external imports of `@firegrid/host-sdk`: **13 via the public entry,
2 internal-path** (`@firegrid/host-sdk/host`). 87% public. The boundary is
substantially clean; any type-union leak is an **internal composition**
concern, not a consumer-facing over-exposure.

### A4 — Capture coverage (ts-morph) — *precommitted, pending (multi-day)*
### A5 — Verification gap census (ts-morph) — *precommitted, pending (multi-day)*
### A7 — Refactor probes (empirical) — *precommitted, pending (2–3 days)*

These three require the ts-morph capture-replay analyzer / empirical
probes (multi-day). Precommitments above stand; not yet executed.

## Interim verdict (analyses 1, 2, 3, 6)

The cheap analyses **move the diagnosis toward partial disconfirmation** of
"over-engineered substrate warrants toy-first redesign":

- Structural smell footprint is **small and precise** (6 sites, ~1/KLOC) —
  the alarming raw count is TFIND **bookkeeping**, a process artifact, not
  architecture.
- The consumer **boundary is clean** (87% public-entry).
- "Accreted over time" is **unsupported** (young, compressed history).

What remains genuinely open — and is the *real* question the redesign
should be decided on, not the raw finding count:

- Are the **4 context-captures load-bearing** (capture→re-provision
  fan-out)? → A4 / Phase-2 ts-morph finding 2.
- Are the **aggregate type-unions accreting**? → Deliverable-2 union map.
- Do removals **cascade**? → A7 probes.

A toy-first rewrite justified by "the substrate is over-engineered" is
**not supported by 1/2/3/6**. If it is justified, the justification lives
in A4/A7/Deliverable-2 (load-bearingness & union accretion), not in the
leaf-finding volume.
