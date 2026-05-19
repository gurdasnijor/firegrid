# SDD: DurableTable React Live Query Bindings

**Status:** implementation-directed proposal.
**Baseline:** `DurableTable` is the single table/state primitive in
`effect-durable-operators`; runtime, client, protocol, and apps share
DurableTable declarations for cross-boundary durable state.

## Thesis

React applications should bind to durable Firegrid state through the same
DurableTable declarations used by the host and client packages. The UI should
not recreate control-plane APIs, shadow services, or polling facades just to
observe table state.

The clean shape is:

- server and browser share the DurableTable class declaration;
- each process acquires its own scoped table layer against the same durable
  stream URL;
- generated DurableTable writes remain the only mutation path;
- TanStack live query consumes read-only table collection views;
- React owns only the UI binding and Effect scope lifetime.

## §0 — The load-bearing question (read this first) — TFIND-044 amendment

> **Amendment (TFIND-044, framing — architect-gated; Gurdas decides).**
> This proposal specifies the provider's props, lifecycle,
> `useDurableTable`, boundaries, and even shows the heterogeneous
> `tables={[RuntimeControlPlaneTable, RuntimeOutputTable]}` case below.
> It was written **pre-curry**, when every `DurableTable` tag identity
> was `any`, so it never had to specify the provider's **generic type
> shape**. TFIND-005's curry makes each table's `<Self>` identity
> precise, and that unspecified type-level decision is now load-bearing.
> No production code is in scope until this §0 is decided.

**Can the single-`ROut`-generic `DurableTableProvider` carry N precise
per-table `<Self>` identities, or must the provider's generic type shape
change — and if it must, which shape: (A) make the provider type as
heterogeneous as its runtime already is, or (B) localize one explicit,
named coarse aggregate to this single inherently-heterogeneous seam
while every table stays precise everywhere else?**

The answer is **not "single `ROut`"** — that cannot express N distinct
precise identities by construction (proof below). The decision is
strictly **A vs B**; both keep every individual `DurableTable` precise.
Widening tables back toward `any` is off the table — that is the
TFIND-005 bug. This cannot be answered by a code patch: it sets the
public type shape of a shared provider + its hook family, so it is
framing. (Challenge logged and discharged: the runtime contract is
already fixed and known — see "the runtime is already heterogeneous"
below — so neither option needs an implementation to determine
viability; this is purely which type to expose over an unchanged
runtime.)

### Why a single `ROut` cannot work (proof)

`packages/effect-durable-operators/src/react.ts`: `:76`
`DurableTableProviderProps<ROut, E>`; `:79`
`layer: Layer.Layer<ROut, E, never>`; `:82`
`tables: ReadonlyArray<Context.Tag<ROut, any>>`; `:126`
`DurableTableProvider<ROut, E>`. The `tables` constraint forces **every
array element to the same `ROut`**. The heterogeneous example at
`tables={[RuntimeControlPlaneTable, RuntimeOutputTable]}` (this doc,
React-Subpath section; live consumers
`packages/client-sdk/src/firegrid.ts:234` `firegridRuntimeTableTags`
and `apps/flamecast/src/client/main.tsx:360`) only typechecked because
the pre-curry `any` collapsed both tags to `Context.Tag<any, any>`.
Post-curry the two are distinct nominal types (#326 Crux-B probe proved
mutual non-assignability), so no single `ROut` satisfies the array.

**Verbatim error (curried shape, #326 `15af74c4e`; absent on
origin/main only because #326 is unmerged):**

```
apps/flamecast/src/client/main.tsx(360,7): error TS2322: Type
'readonly [typeof RuntimeControlPlaneTable, typeof RuntimeOutputTable]'
is not assignable to type 'readonly Tag<RuntimeControlPlaneTable, any>[]'.
```

`ROut` infers `RuntimeControlPlaneTable` from element 0;
`RuntimeOutputTable` is not a `Tag<RuntimeControlPlaneTable, any>`.

### The runtime is already heterogeneous and type-erased

Decisive for the tradeoff. `acquireServices` (`react.ts:91-118`) builds
the layer once into a `Context` (`:104`), then resolves **each tag
independently by its string `key`** —
`acc.set(table.key, Context.unsafeGet(context, table))` (`:112-115`) —
into a `ReadonlyMap<string, unknown>` (`:98`). It never relies on the
tags sharing one `ROut`; consumers re-narrow per tag downstream at
`useDurableTable(table)`. Any precise typing threaded through the props
is discarded at `:113` and reconstructed per-tag later regardless.

### Options

**Option A — heterogeneous variadic/tuple-typed provider (purist).**
Make the provider generic over the *tuple of tags*, deriving the
layer's `ROut` as the union of their identities (conceptually:
provider generic over `Tags extends ReadonlyArray<Context.Tag<…>>`,
`tables: Tags`, `layer` requiring the union of `Tags`' identifiers).
*Pro:* provider type is as precise as the identities; a `tables`/`layer`
mismatch is caught at the type level; no new coarse type.
*Con:* ripple across the shared provider generic **and its hook
family** — `DurableTableProviderProps`/`acquireServices`/
`DurableTableProvider` (`react.ts:76,91,126`) plus the per-tag
resolution hooks that must project one identity out of a heterogeneous
tuple; `client-sdk/src/firegrid.ts:234` `firegridRuntimeTableTags`'s
exported type becomes a precise tuple (public client-sdk surface);
flamecast `:360` then typechecks. *Con:* purity buys little — the
runtime returns `ReadonlyMap<string, unknown>` and consumers re-narrow
per tag, so A reconstructs precise typing the same boundary then erases
it; substantial variadic-tuple type machinery for a guarantee the
runtime contract does not carry end-to-end.

**Option B — localized, explicit, named coarse aggregate at the seam.**
Every `DurableTable` stays precise everywhere else; at *only* this
provider boundary, type `tables`/`layer` against one **named** aggregate
(e.g. a documented `AnyDurableTableTag` /
`DurableTableProviderTables` alias matching the runtime's already-erased
`unknown` map). *Pro:* changes localize to `react.ts` (Props +
`acquireServices`); `firegrid.ts:234` and flamecast `:360` need no shape
change (or one annotation); the named aggregate states the truth the
runtime already encodes. *Con:* the provider seam is type-opaque — a
wrong-table/wrong-layer pairing is not caught at the boundary (still
fails at runtime via `Context.unsafeGet`; per-tag downstream typing
unaffected).

**Why B is not the TFIND-005 bug returning.** TFIND-005's `any` was a
*diffuse, implicit, unnamed* leak from `defineDurableTable`'s return
that silently discharged *unrelated* required tags across every
host/engine composition. B is a *single, explicit, named* coarsening
confined to one boundary that is *inherently* heterogeneous and already
`unknown`-typed by design; it discharges nothing outside the provider
seam, and every table identity stays precise in every other
composition. If Gurdas rejects any localized coarse type on principle
regardless of containment, that selects A.

### Coordinator recommendation (Gurdas decides)

**Lean B.** The provider's runtime contract is already heterogeneous and
type-erased (`ReadonlyMap<string, unknown>`); A reconstructs precision
the same seam immediately discards, at real type-machinery and
public-surface cost, for a React boundary whose consumers re-narrow per
tag at `useDurableTable` anyway. B contains the coarsening to one
documented, named, inherently-heterogeneous seam and is categorically
distinct from the TFIND-005 anti-pattern. A is fully viable and is the
purist choice; this is a recommendation, not a decision.

### Secondary / mechanical questions (after §0 is decided)

1. If A: exact variadic encoding and whether `useDurableTable`'s per-tag
   narrowing stays source-compatible.
2. If B: the aggregate's name/definition (`Context.Tag<unknown,
   unknown>` vs a branded `AnyDurableTableTag`); whether
   `firegrid.ts:234` keeps its inferred tuple or is annotated.
3. Either way: the `eslint-disable @typescript-eslint/no-explicit-any`
   at `react.ts:81,93` must be reconciled with the chosen shape (lint
   `--max-warnings 0`; certified-dead-sweep discipline).
4. Sequencing: TFIND-044 co-gates #326 flip with TFIND-045 (flamecast
   cannot be CI-red; `pnpm --recursive run typecheck` includes
   `@firegrid/flamecast`). Depends on #326's curried shape
   (`15af74c4e`), not on #326 being merged.

### Non-goals (TFIND-044)

- Widening any `DurableTable` toward `any` (the TFIND-005 bug).
- Changing the provider's **runtime** behavior — the per-key/`unknown`
  acquisition is correct; this is a type-shape decision only.
- Resolving TFIND-045 (distinct mechanism; `docs/sdds/
  SDD_RECONCILER_ENV_ENUMERATION.md`).

## §0.1 — The load-bearing question (read this first) — TFIND-050 amendment (layer-ROut erasure)

> **Amendment (TFIND-050, framing — architect-gated; Gurdas decides).**
> §0 (TFIND-044 Option B, signed off) fixed the **`tables`** side of
> the provider seam (→ the named coarse `AnyDurableTableTag`). It left
> the **`layer` prop's ROut erasure** under-specified: the
> implementation chose `Layer.Layer<unknown, E, never>`. That scalar was
> never separately decided, and it is wrong — but so is the obvious
> alternative. Escalated from a within-coordinator-authority "2-line
> correctness fix" to architectural framing because the alternative does
> not fix the defect, it **relocates** it (§Evidence). No production
> code is in scope until this §0.1 is decided.

**How must the `DurableTableProvider` seam type the `layer` prop's ROut
so that BOTH consumer paths typecheck without relocating breakage — the
flamecast JSX-inference path AND the explicit-props / by-name path —
given that Effect's `Layer` ROut behaves *contravariantly* for
value-assignment at this prop?**

The provider runtime is ROut-agnostic (it builds the layer and resolves
each tag by string key via `Context.unsafeGet` into
`ReadonlyMap<string, unknown>` — §0's "runtime is already heterogeneous"
argument). So this is purely a *boundary-acceptance type* decision, not
a runtime one. It cannot be answered by a code patch: every scalar
choice has been shown to break one path or the other, so the resolution
is a design decision over the public provider type.

### The contravariance fact (why no scalar works)

Empirically (curried `#326` shape): `Layer<X, E, never>` is assignable
to `Layer<Y, E, never>` **iff `Y <: X`** — the ROut position behaves
contravariantly for value-assignment at this prop. Consequence: a fixed
scalar `P` in `layer: Layer<P, E, never>` accepts *all* `Layer<X, …>`
only if `P <: X` for every `X` → `P = never`. `unknown` requires
`unknown <: X`, which fails for every concrete table identity, so the
explicit-props / by-name path rejects every real layer.

### §Evidence — falsification (deterministic, cache-cleared, single-variable isolation)

The only variable changed was `react.ts` `layer` ROut; `.tsbuildinfo`
cleared; recursive typecheck across all workspaces.

- **(a) `unknown`** (current `#348`/main): explicit-props / by-name path
  **RED**. Under `#326`'s curried world, the `react-types.test.ts`
  explicit-pin variant →
  `TS2769`: `Layer<ReactWorkflowTable, DurableTableError, never>` is not
  assignable to `Layer<unknown, DurableTableError, never>` ("`unknown`
  is not assignable to `ReactWorkflowTable`"). flamecast's JSX path
  passes *only* via bidirectional generic inference; the by-name public
  surface is broken.
- **(b) `never`**: explicit-props path **GREEN**, but **relocates**
  breakage to a *second* by-name consumer, `apps/factory` (it imports
  `DurableTableHeaders` from `effect-durable-operators` root; the
  exported provider-type change ripples through the package type-graph):
  `apps/factory/src/bin/live-smoke.ts:160` `TS2769`;
  `apps/factory/test/factory.test.ts:104` `TS2379`
  (`Effect<…, unknown>` not assignable to `Effect<…, never>`,
  `exactOptionalPropertyTypes`); plus one now-unused
  `eslint-disable`. A pristine-`unknown` isolation run showed
  `apps/factory` green, proving `react.ts` `unknown↔never` is the sole
  determinant. Additionally, off pre-curry `origin/main`, `never`
  cannot be lint-green: `@typescript-eslint/no-unsafe-assignment`
  tolerates `any→unknown` but not `any→never`, and pre-curry
  `ReactWorkflowTable.layer()` is `Layer<any, …>` (the TFIND-005 leak,
  cured only by `#326`).

`never` is therefore **not a fix — it is a breakage relocation**. No
single scalar reconciles both paths; the shape itself must change.

### Option space (tradeoffs; coordinator recommendation — Gurdas decides)

- **(a) `unknown`** — REJECTED by Evidence (breaks the by-name /
  explicit-props public surface).
- **(b) `never`** — REJECTED by Evidence (relocates breakage to
  `apps/factory`; not lint-green off pre-curry main). Not a fix.
- **(c1) Decouple ROut — thread the layer's ROut as an inference-only
  generic, separate from `tables`.** TFIND-044's root defect was
  `layer` and `tables` *sharing one `ROut`*. §0 Option B fixed `tables`
  (→ `AnyDurableTableTag`) but *also* collapsed `layer`'s ROut to a
  scalar, which was unnecessary. If `layer: Layer.Layer<ROut, E,
  never>` with `ROut` a free generic **inferred per call site**, and
  `tables: ReadonlyArray<AnyDurableTableTag>` stays decoupled, there is
  no contravariance trap (TS infers `ROut` = the layer's actual
  provided set at each call; it is never assigned to a fixed supertype)
  and no fixed scalar to ripple through the package type-graph.
  flamecast infers `ROut` from `FiregridBrowserTablesLive`;
  explicit-props consumers infer or specify. *Tradeoff:* re-introduces
  a generic parameter to public `DurableTableProviderProps` (the param
  `#348` removed) — but the original bug was the *shared* ROut, not
  ROut's existence; decoupling is the precise root-cause fix. *Cannot*
  reopen the flamecast `TS2322`, because `tables` is no longer
  `Context.Tag<ROut, any>[]`. Requires impl-time validation (both
  paths + `apps/factory` + lint).
- **(c2) Named/branded coarse `Layer` aggregate** — symmetry with
  `AnyDurableTableTag`: a single documented `AnyDurableTableLayer<E> =
  Layer.Layer<any, E, never>`, carrying the *same* signed-off
  justification (one explicit, named, localized coarsening at a seam
  that is already runtime-erased — categorically distinct from the
  TFIND-005 diffuse/implicit/unnamed leak). `any` ROut is permissive
  in both directions, so it should not relocate breakage the way
  `never` did — but that must be impl-time validated, especially the
  `apps/factory` package-graph path.
- **(c3) Per-path / overloaded prop typing** — REJECTED as impractical:
  a React component cannot ergonomically vary its props type by call
  path; high complexity, no payoff over (c1)/(c2).

**Recommendation: lean (c1).** It is the *precise* correction of
TFIND-044's actual root cause (shared ROut), variance-natural (no
contravariance trap, no scalar, no package-graph scalar ripple), keeps
`tables` exactly on the signed-off `AnyDurableTableTag`, and reintroduces
no `any`. Fallback **(c2)** if Gurdas prefers a non-generic public
`DurableTableProviderProps` and accepts a localized named `any` by
symmetry with the tables-side decision. (a)/(b) are rejected by
Evidence. Every (c) option requires post-signoff impl-time validation on
the exact gate that produced this Evidence (recursive typecheck across
both consumer paths + `apps/factory` + full lint).

### Non-goals (TFIND-050)

- No production code before §0.1 signoff; no paper, no forcing cast, no
  scalar chosen to silence one path at another's expense.
- No change to provider **runtime** (per-key/`unknown` acquisition is
  correct).
- Does not reopen §0's tables-side decision — `AnyDurableTableTag`
  stands.
- Not `#326` scope — the `react-types.test.ts` arity reconciliation
  ((b) in the #326 rebase) is separate, correct, and stays in `#326`;
  `#326`'s flip remains gated on this §0.1.

## §0.2 — Ratified c1 FALSIFIED; reframe required — **SUPERSEDED by §0.3**

> ⚠ **SUPERSEDED — do not act on §0.2 in isolation. Read §0.3.**
> §0.2's central claim that **c1 is the trigger** of the host-sdk
> cascade ("c1 sole trigger", §3) is **base-specific and superseded**.
> It was produced by a now-retired measurement method
> (`pnpm --recursive` typecheck + error-bucketing) which conflated a
> rebase-base difference with a react.ts variable. The corrected
> forensics in **§0.3** — using the **host-sdk-alone `tsc`** method
> (now the standard) — prove the host-sdk cascade is **c1- and
> TFIND-050-INDEPENDENT** (`#326`-curry × main, latent in **merged
> #350 / TFIND-015**). §0.2 is retained verbatim below as the
> historical record of the c1 falsification (which *is* still valid:
> ratified c1 was correctly implemented and is not the fix); only its
> *causal attribution of the host-sdk cascade to c1* is superseded.
> §0.1's a/b/c1/c2/c3 option space remains the wrong axis for the
> provider question — that conclusion stands.

> **Status (architect-level — beyond §0.1; coordinator does NOT
> decide).** Gurdas ratified §0.1 option **(c1)**. It was implemented
> exactly as ratified and **falsified by the binding §0.1 Evidence
> gate**. The §0.1 provider-`layer`-type option space (a/b/c1/c2/c3) is
> the **wrong axis**. This requires an architect reframe.
> **Reproducer:** branch `sidecar/tfind050-c1-decouple-rout`
> commit `b7a66e6b8` (kept unpushed as evidence).
>
> *(historical §0.2 body follows; see §0.3 for the corrected finding.)*

### 1. What was implemented (ratified c1, exactly)

`ROut` reintroduced as a **decoupled, free, per-call inference-only
generic** on `DurableTableProvider` / `DurableTableProviderProps` /
`acquireServices` (`layer: Layer.Layer<ROut, E, never>`); `tables` stays
the erased `AnyDurableTableTag`; **no default** on `ROut`;
`useDurableTable` untouched (already `AnyDurableTableTag`-bound,
source-compatible). No paper, no forcing cast, no default.

### 2. Binding gate result

- **Pre-curry `origin/main`** (necessary, *not* sufficient — §0.1
  Condition 2): full gate **GREEN** (cache-cleared recursive typecheck
  all workspaces, lint + lint:dead/dup/deps, effect:diagnostics,
  semgrep(+test), edo 27 + client-sdk 12 tests).
- **Post-`#326`-curry overlay** (the gate that produced the §0.1
  Evidence: `#326` rebased onto current `main` + c1, `.tsbuildinfo`
  cleared, recursive typecheck + full lint): **FAILED — 29 host-sdk
  `TS2375`/`TS2379`** (`Effect<…, unknown>` ⊄ `Effect<…, never>`,
  `exactOptionalPropertyTypes` R-channel). Production src:
  `packages/host-sdk/src/host/commands.ts:163`,
  `control-request-reconciler.ts:227`,
  `agent-tool-host-live.ts:90`; plus 6 host-sdk test files
  (`env-bindings`, `runtime-codec-event-plane`,
  `runtime-context-workflow-core`, `start-runtime`,
  `sync-run-integration`, `two-host-isolation`).

### 3. Deterministic single-variable isolation

Same overlay worktree, `.tsbuildinfo` cleared each run, only `react.ts`
toggled: **c1 absent → 0 host-sdk errors** (only the expected `#326`
react-types (b) arity item); **c1 present → 29 host-sdk errors**. c1 is
the **sole trigger**.

### 4. The falsified premise

§0.1 recommended — and Gurdas ratified — c1 on the reasoning *"`ROut`
inferred per-call ⇒ no scalar ⇒ no package-graph ripple."* This is
**empirically false**: the *exported generic itself* cascades into
host-sdk's cross-package `Effect`-R inference regardless of per-call
inference. Per-call inference does not contain the ripple.

### 5. The 3-for-3 pattern → wrong axis

| Provider `layer` variant | Post-curry failure |
| --- | --- |
| (a) `unknown` (#348) | breaks explicit-props / by-name path (react-types `TS2769`) |
| (b) `never` | relocates breakage → `apps/factory` (`TS2769`/`TS2379`) |
| (c1) decoupled per-call generic | cascades `host-sdk` (29 errors, incl. production src) |

Every provider-`layer`-type variant fails in the post-`#326`-curry
world. The §0.1 option space (a/b/c1/c2/c3) is the **wrong axis**. The
real instability is **cross-package `Effect`-R inference under
`exactOptionalPropertyTypes` × the `#326` curry**; the provider type is
only the *trigger surface*, not the root.

### 6. Traced cascade edges (the actual paths; reproducer `b7a66e6b8`)

Each cascade traced to its exact edge by reading the import graph on
the reproducer. **Two of the three cascades travel NO import path** —
they travel the absence of a type-isolation boundary.

**The boundary that is missing.** `effect-durable-operators`:
`tsconfig` `include: ["src/**/*.ts","test/**/*.ts"]` (so `react.ts` is
in the package program), `composite` unset, `declaration` unset,
`noEmit: true`; `package.json` `exports["."].types → ./src/index.ts`
(**source**, not a built `.d.ts`). Consumers therefore **type-check
the package's TypeScript source**, with no `composite`
project-reference / emitted-declaration boundary between `react.ts` and
the root API. `src/index.ts` re-exports only `./DurableTable.ts` +
`./Errors.ts` — `react.ts` is **not** in the root import closure.

| Cascade | Exact edge | Import path? | Severable? / cost |
| --- | --- | --- | --- |
| **(a) flamecast `TS2322`** | DIRECT: `apps/flamecast/src/client/main.tsx:19` `from "effect-durable-operators/react"` (+ `firegridRuntimeTableTags` from `@firegrid/client-sdk/firegrid:14`; `DurableTableHeaders` from root `:20`). The **only** direct `/react` consumer repo-wide. | Yes — a real, intended import. | **Not severable.** flamecast is the product consumer the provider exists for. (a) is the provider's own type being wrong for a legitimate consumer — a genuine defect, *not* a coupling artifact. |
| **(b) apps/factory `TS2769`/`TS2379`** | INDIRECT. apps/factory imports **only** `import type { DurableTableHeaders } from "effect-durable-operators"` (root) at `apps/factory/src/bin/env.ts:3` and `src/host.ts:37`. No `/react`, no provider. | **No import path to `react.ts`.** | Severable only by adding the missing isolation boundary (see §7). Cost: see §7 — not cosmetic. |
| **(c1) host-sdk 29 errors** | INDIRECT, strongest. The 3 cascade src files (`commands.ts`, `control-request-reconciler.ts`, `agent-tool-host-live.ts`) import **nothing** from `effect-durable-operators`. host-sdk's only edo importers (`config-live.ts`, `layers.ts`, `types.ts`) use the **root** specifier; **no `/react` importer exists in host-sdk or its `@firegrid/protocol` / `@firegrid/runtime` closure**. `react.ts` is unreachable by any host-sdk import. | **No import path to `react.ts`.** | Severable only by the §7 boundary. Cost: see §7. |

**Conclusion of the trace:** for (b) and (c1) the edge is **not a
re-export and not an import** — it is the missing
declaration/project-reference isolation. Under `pnpm --recursive
typecheck`, the `effect-durable-operators` program is checked *with
`react.ts` in it*, and source-resolving consumers observe a
type-surface that shifts with `react.ts`'s generic shape, flipping
host-sdk / apps-factory `Effect`-R inference under
`exactOptionalPropertyTypes`. This is precisely why a *scalar* choice
can never fix it (a/b/c1/c2/c3 wrong axis) and why the direction must
be structural isolation.

### 7. Candidate mechanism (x) — CONTINGENT, not the recommendation

**(x) — introduce the missing isolation boundary** so a `react.ts`
change cannot perturb the type-surface root consumers observe (e.g.
make `effect-durable-operators` `composite` with emitted declarations,
or split `/react` into its own TS project / leaf module so consumers
resolve to a stable `.d.ts` instead of whole source).

- **Viability is CONTINGENT**, not established: it is contingent on
  the §6 trace (done — confirms the edge *is* the missing boundary,
  which (x) addresses) **and** on the no-reopen confirmation below.
  It is **not** ratified, **not** the recommendation. Gurdas reframes;
  the coordinator does not decide; the executor does not pre-pick or
  probe a mechanism.
- **Cost (must be visible before signoff).** The source-`types`
  resolution (`exports["."].types → ./src/index.ts`, `noEmit`,
  non-`composite`) is a *deliberate, repo-wide* workspace-DX choice:
  no build step, instant cross-package types, source-mapped
  debugging. (x) trades that for type-surface stability and requires
  monorepo-scope build changes (composite project graph + emitted
  declarations / a split provider project, build ordering, turbo
  pipeline). **Not cosmetic; repo-wide blast radius.**
- **(y)/(z) remain open** (UNRANKED, UNDECIDED): (y) address the
  `exactOptionalPropertyTypes` × curry `Effect`-R interaction at root
  (shared cause across the 3 cascades and the TFIND-045 reconciler
  leak); (z) treat the host-sdk / apps-factory cascades as a broadened
  TFIND-045-class explicit-R enumeration finding.

### 8. (x) does NOT reopen §0 — confirmed, with STOP-condition

`AnyDurableTableTag` (the §0 / Option B signed-off **tables-side**
fix) **STANDS**. (x) is a *structural / build-isolation* change — it
alters **where/how the provider module is compiled and resolved**, not
**what the tables-side type is**. By construction it does not touch
`AnyDurableTableTag` or the tables-side typing; the reframe is
isolation *layered on top of* the signed-off fix, not a redo.

**STOP-condition (binding):** if any concrete (x) mechanism is found
to require changing `AnyDurableTableTag` or the tables-side decision,
**STOP and escalate to surface:153 before proceeding** — do not author
or implement a change that quietly reopens the signed-off §0
tables-side decision.

**This needs an architect reframe beyond §0.1. The coordinator does not
decide; §0.1's scalar/generic option space is closed; (x) is a
contingent candidate pending Gurdas.**

## §0.3 — Corrected forensics (host-sdk-alone `tsc` is the standard; the host-sdk cascade is c1-INDEPENDENT) — read this first

> **Status (architect-owned reframe; coordinator does not decide).**
> This section corrects §0.2's causal attribution. It is the current
> authoritative finding. Reader path: §0 (tables-side, signed off) →
> §0.1 (provider-`layer` erasure question) → §0.2 (c1 falsification —
> valid that c1 is *not the fix*; **superseded** on *what causes the
> host-sdk cascade*) → **§0.3 (corrected: the host-sdk cascade is a
> latent leak in merged #350, independent of c1/TFIND-050).**

### 1. Measurement standard (this supersedes the §0.2 method)

- **Standard:** **host-sdk-alone `tsc --noEmit`** against the
  `#326`-curried tree, plus `tsc --explainFiles` to confirm program
  membership. Deterministic, single-program, single-variable.
- **Superseded:** `pnpm --recursive` typecheck + error-bucketing. It
  conflated a rebase-base difference with the react.ts variable and
  produced two now-retired claims: §0.2's "c1 sole trigger", and the
  earlier bisect window `4bdc81a83..7d73e34c4`. Do not use it for
  cascade attribution.

### 2. The corrected finding — host-sdk-alone `tsc` / `explainFiles` proof (this is what supersedes §0.2)

Evidence chain (each step deterministic, `.tsbuildinfo` cleared,
single-variable):

1. **`tsc --explainFiles` on host-sdk:** `react.ts` is **not in
   host-sdk's TypeScript program**. host-sdk resolves
   `effect-durable-operators` → `./src/index.ts`; that closure is
   `DurableTable.ts` / `Errors.ts` only. No `references` / `composite`
   / `paths`; no `/react` importer in host-sdk or its
   `@firegrid/protocol`/`@firegrid/runtime` closure. (The only 9
   "react" lines in the explain log are unrelated —
   `@effect/experimental/.../Reactivity.d.ts`.)
2. **host-sdk's own `tsc` alone** (not `pnpm --recursive`) reproduces
   the 29-error cascade — so it is a real program result, not a
   runner/ordering artifact.
3. **Single-variable isolation:** host-sdk-alone with **c1 reverted**
   (react.ts = base #348) on `#326`-curry rebased onto current main =
   **still 29**. With main alone (no `#326`) = **0**.
4. **Anchors (host-sdk-alone, same method):** `#326`-curry on
   `798821692` → **0**; on `4bdc81a83` → **29**.

⇒ The host-sdk cascade is **c1- and TFIND-050-INDEPENDENT**: it is
**`#326`-curry × main**. This empirically supersedes §0.2's
"c1 sole trigger" (which came from the now-retired `pnpm --recursive`
+ error-bucketing method conflating a rebase-base difference with the
react.ts variable).

### 3. Culprit (empirical bisect, host-sdk-alone)

Anchors: `#326`-curry on `798821692` → **0**; on `4bdc81a83` → **29**.
True window **`798821692..4bdc81a83`** (the §0.2-era
`4bdc81a83..7d73e34c4` window is 29-throughout — superseded).
Bisect pins the transition exactly (`d51a3dd59`→0, `5ecc20d53`→29):

**Culprit = `5ecc20d53` — the merge of #350 / TFIND-015 ("move ACP
permission authority to workflow").** Its message reads "docs:"; its
`--stat` is production code:
`packages/host-sdk/src/host/runtime-context-workflow-core.ts` (+177),
`runtime-input-deferred.ts` (+34),
`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts`.

### 4. Mechanism (TFIND-045 class)

#350's `runtime-context-workflow-core.ts` restructure composes cleanly
on **pre-curry** DurableTable (`any` identities absorb the Effect
R-channel — which is why #350 merged green: CI runs main *without*
`#326`'s curry). Under `#326`'s **precise** `<Self>` identities, #350's
new composition leaks `unknown` into the Effect R-channel at **29
host-sdk sites** (src: `commands.ts:163`,
`control-request-reconciler.ts:227`, `agent-tool-host-live.ts:90`; + 6
host-sdk test files), failing `Effect<…, unknown> ⊄ Effect<…, never>`
under `exactOptionalPropertyTypes`. This is the **TFIND-045 class**:
TFIND-005's precise-identity cure removes the `any`-absorbed
imprecision, exposing a latent requirement/precision leak in already
merged production src.

### 5. Disposition

- **TFIND-050** (this SDD's §0/§0.1 provider-`layer`/identity question:
  the a/b/c1/c2/c3 + x/y/z option space, and the **flamecast `(a)`
  DIRECT-consumer by-name defect**) is **DECOUPLED from the `#326`
  keystone gate**. It stays **live for flamecast `(a)`** as its own
  provider-type decision (the §0.1/§0.2 reframe still pending Gurdas) —
  but it is **no longer on the `#326` critical path** and is **off P0 /
  not keystone**.
- **`#326`'s flip now gates on broadened TFIND-045 landing**, not on
  TFIND-050 and not on a separate new bead. **Broadened TFIND-045 —**
  *class:* curry-exposed `Effect<…, unknown> ⊄ Effect<…, never>`
  cascades in **production src**, surfaced by TFIND-005's
  precise-identity cure removing `any`-absorbed imprecision. *Method:*
  host-sdk-alone `tsc` against `#326`-curried main (host-sdk first;
  sweep other packages after). *Scope:* the cascades **only** — not a
  general precision audit; must not swallow unrelated precision work.
- `#326` stays unpushed. No paper, no forcing cast, no flip. The #350
  cascade is in **merged** code (a Gurdas-decided/merged change):
  fixing/enumerating it is architect/coordinator-directed under
  broadened TFIND-045, not authored here.

### 6. Disposition mechanism comparison (decision-grade — `tf-uiz`'s decision)

This is the architect decision behind `tf-uiz` (the broadened-TFIND-045
/ #350-leak disposition that gates `#326`). No mechanism is chosen
here; Gurdas decides.

**Concrete forensic anchor.** #350's `runtime-context-workflow-core.ts`
diff **explicitly introduced** a function declared
`Effect.Effect<RuntimeAgentOutputObservation, RuntimeContextError,
unknown>` — the **R channel is a literal `unknown`** — and **removed**
a former `… as Effect.Effect<StartRuntimeResult, RuntimeContextError>`
cast. Pre-curry, `any`-typed DurableTable layers absorbed that
`unknown` R; post-curry the precise identities cannot discharge it to
`never`, and it propagates to the 29 consumer sites
(`commands.ts:163`, `control-request-reconciler.ts:227`,
`agent-tool-host-live.ts:90`, + 6 host-sdk test files). The leak
therefore has a **named, small upstream origin in #350's own new
annotations**, not 29 independent inference accidents.

| Option | Mechanism | Closes cascade w/o composite-ify? | Blast radius | Reopens merged #350/TFIND-015? | Root vs mask | Reversible |
|---|---|---|---|---|---|---|
| **y — root R-narrow at #350's source** | Narrow the `, unknown>` R the #350 workflow-core function(s) declare to the precise/`never` set at that source (the TFIND-045/#347 fix shape, applied to its origin). | **Yes** — no build-graph change. | Smallest: the few #350-introduced annotations in `runtime-context-workflow-core.ts`; re-verify host-sdk-alone tsc + sweep. | No — refines #350's *type annotation*, not its runtime/decision. | **Root** (fixes the origin `unknown`). | Yes. |
| **z — broad explicit-R enumeration** | Enumerate/annotate R at each of the 29 leaking consumer sites (broadened #347). | Yes. | Largest mechanical: 29 host-sdk sites incl. merged tests; sweep other pkgs. | No (consumer-side). | **Mask-ish** — leaves source `unknown`; future curry-precision changes can re-leak. | Yes but noisy. |
| **x-scoped — boundary at the #350 workflow-core seam** | Deliberate, *named/justified* coarse Effect-R boundary localized to the #350 workflow-core module so precision doesn't propagate. | Yes. | One module. | No. | **Mask** (contained, named — TFIND-005-style anti-pattern risk; must be justified per §0/§8 discipline). | Yes. |
| **x-broad — revert/rework #350's restructure** | Undo/redo the "move ACP permission authority to workflow" restructure that introduced the `unknown` R. | Yes. | Largest: host-sdk + runtime ACP codec; **reopens TFIND-015**. | **Yes** — reopens a merged Gurdas decision. | Root (removes the construct) but heavy. | Hard. |

**Recommendation (Gurdas decides): lean `y`.** The forensic anchor
shows the `unknown` R is a *small, named, #350-authored source*
annotation, not diffuse inference — so narrowing at the source is the
smallest change that is also root, needs no build-graph/composite
work, does **not** reopen TFIND-015, and is the same proven shape as
TFIND-045/#347. `z` is the safe fallback if `y`'s sites cannot be
narrowed without behavior change. `x-scoped` only if `y`/`z` prove
infeasible (it masks; carries the §0/§8 localized-coarsening burden).
`x-broad` only if #350's restructure is fundamentally
precise-identity-incompatible (reopens a merged decision — highest
cost/risk).

**Open verification (decision-grade honesty — implementer must
confirm; not a blocker to the decision):** that **all 29** sites trace
to the #350-introduced `, unknown>` annotation(s) as a single upstream
R-source has strong evidence (uniform error shape; the explicit
`unknown` in #350's diff) but is **not exhaustively bisected to that
granularity**. If `y` is chosen, the implementer confirms the
29→source mapping via host-sdk-alone `tsc` while narrowing; if a
residual subset is independent, those fall to `z`. This does not
change the recommendation; it scopes `y`'s implementation.

## §0.4 — The defect is the SEAM SHAPE, not any operator at it; re-couples to the `#326` keystone — read this first

> **Status (architect-gated reframe; Gurdas signs off this §0.4;
> coordinator holds the merge gate; NOT self-merged).** Gurdas's
> decision: the four-falsification pattern is decision-grade evidence
> that the **provider seam itself** is the defect, not any individual
> fix *at* the seam. This section reframes the question from "pick the
> `layer`-ROut operator" (§0.1's axis) to "correct the seam *shape*".
> Reader path: §0 (tables-side `AnyDurableTableTag`, signed off) → §0.1
> (provider-`layer` ROut erasure question; contravariance proof + (a)/(b)
> Evidence — still valid inputs) → §0.2 (c1 *not the fix*; superseded on
> host-sdk causal attribution) → §0.3 (host-sdk cascade = `#326`-curry ×
> merged-#350; that is the **separate** broadened-TFIND-045 / `tf-uiz`
> track — **unchanged here**) → **§0.4 (the seam-shape reframe; this
> RE-COUPLES the provider-seam decision to the `#326` keystone via
> `#326`'s OWN `effect-durable-operators` typecheck — a track
> independent of the host-sdk/`tf-uiz` one).**

**How must the `DurableTableProvider` seam *encode* the `layer`-side
ROut so that the boundary is (1) variance-correct for Effect `Layer`'s
contravariant ROut AND (2) accepts `#326`'s precise self-identity curry
layers — the exact precision the keystone exists to produce — WITHOUT
(a) demanding an impossible supertype, (b) forcing a bottom that
relocates breakage, or (c) threading a public scalar/generic that
ripples through consumer Effect-R inference; given that four distinct
operator/input choices at the *current single shared, value-position
erased seam* have each been independently falsified?**

This is not §0.1's question. §0.1 asked *which scalar/shape* fills the
one `layer`-ROut slot. The accumulated falsifications show every choice
at *that slot* fails differently — so the slot itself (TFIND-044 Option
B collapsed `layer`'s ROut into a single shared scalar/parameter sitting
in a value-assignment position) is the invariant defect. The decision
is now over the **seam encoding**, not the operator value.

### Why this RE-COUPLES TFIND-050 to `#326` (correcting §0.3's decoupling — narrowly)

§0.3 decoupled TFIND-050 from the `#326` gate on the (correct) basis
that the **host-sdk** cascade is `#326`-curry × merged-#350, a track
that routes to broadened-TFIND-045 / `tf-uiz` = `y`. That remains true
and is **not** disturbed here. But a fresh, deterministic fresh-`origin/
main` A/B (cache-bypassed; see §Evidence row (a)) proves the provider
seam *also* gates `#326` through a **second, independent** path:
`#326`'s own `effect-durable-operators` typecheck is RED at
`react-types.test.ts:55` *solely* because the `#326` curry feeds a
precise `Layer<ReactWorkflowTable, …>` into the merged-#348
`unknown`-erased seam. That is the edo/by-name cascade, not the
host-sdk one. **Net: `#326` now gates on BOTH independent tracks —
(i) broadened-TFIND-045 / `tf-uiz` = `y` (host-sdk; unchanged) AND
(ii) this §0.4 seam reframe landing (edo/by-name). Neither subsumes the
other; both must clear before `#326` flips.**

### §Evidence — the four-falsification table (decision-grade)

Every row is a different operator/input at the **same single shared,
erased `layer`-ROut slot**; each fails differently; the slot is the
constant. Method per row noted; (a) is freshly re-confirmed by a
deterministic, cache-bypassed fresh-`origin/main` A/B.

| # | Choice / input at the seam slot | Result | Where | Method / note |
|---|---|---|---|---|
| **(a)** | `unknown` (current merged #348 / `origin/main` erased ROut) | **RED** — explicit-props / by-name path | `react-types.test.ts(55,9) TS2769`: `Layer<ReactWorkflowTable, DurableTableError, never>` ⊄ `Layer<unknown, unknown, never>` | **Fresh A/B (this dispatch):** clean `origin/main` `74b5c023b9` edo-**alone** `tsc --noEmit` = **0** at :55; `#326`-curry rebased (`6355b7de6`) edo-alone `tsc` = the TS2769. Turbo "shared worktree cache" emitted a false cross-worktree green — caught & bypassed; tsc-checks-the-test-file confirmed via a deliberate `:56` probe. Re-confirms §0.1 Evidence (a). |
| **(b)** | `never` | **RELOCATES** — not a fix | `apps/factory/src/bin/live-smoke.ts:160 TS2769`; `apps/factory/test/factory.test.ts:104 TS2379`; + dead `eslint-disable`; also not lint-green pre-curry (`no-unsafe-assignment` `any→never`) | §0.1 §Evidence (b), single-variable, cache-cleared. Unchanged. |
| **(c1)** | Decoupled inference-only public ROut generic | **RIPPLES** — falsified as the *isolated* seam fix | +29 host-sdk Effect-R sites (`Effect<…, unknown> ⊄ Effect<…, never>`, `exactOptionalPropertyTypes`) | §0.2 base-specific single-variable isolation (base `4bdc81a83`): c1 present → +29, c1 absent → 0. **Honest cross-ref:** §0.3 *supersedes c1 as the cause of the dominant host-sdk cascade* (that is curry×#350, c1-independent, the `tf-uiz`=`y` track). c1 nonetheless stays falsified *as a provider-seam fix* because re-introducing a public ROut generic still threads ROut into consumer Effect-R inference. |
| **(d)** | The `#326` precise self-identity curry itself, against the *unmodified* #348 seam | **REJECTED at the boundary** | same `react-types.test.ts:55 TS2769` as (a) | This is the keystone delivering its core deliverable (precise `<Self>` identity) and the erased seam refusing exactly that precision. Not a fourth *operator* — the proof that the seam rejects the very precision `#326` exists to produce. |

**Conclusion (decision-grade):** across an impossible supertype
(`unknown`), a relocating bottom (`never`), a decoupled public generic
(`c1`), and the real precise input (`#326` curry), the **single
shared, value-position erased `layer`-ROut slot is the invariant that
fails**. No operator value at that slot can be correct, because the
slot is in a contravariant value-assignment position while the runtime
is genuinely ROut-agnostic (§0's heterogeneous `ReadonlyMap<string,
unknown>` argument). The fix must change the **encoding**, not the
operator.

### Option space — at the seam *encoding* (tradeoffs; Gurdas decides)

- **(d1) Existential / opaque-input encoding — RECOMMENDED.** The
  public boundary stops taking a raw `layer: Layer<ROut, E, never>`
  prop whose ROut sits in a value-assignment position. Instead it takes
  an opaque `DurableTableProviderInput<E>` produced by a small exported
  smart constructor that *captures* the concrete `Layer<X, E, never>`
  at the build site — `X` is bound there and **never surfaces in
  `DurableTableProviderProps`**. This turns the runtime's genuine
  ROut-agnosticism into a *sound existential encoding* instead of an
  unsound scalar in a contravariant slot. Variance-correct (no
  `Layer<X>` → fixed-ROut value-assignment anywhere); accepts `#326`'s
  precise curry layers **by construction** (X inferred at the
  constructor call); **no public ROut generic** to ripple into
  consumer Effect-R, so it is orthogonal to the `tf-uiz`=`y` host-sdk
  track; cannot reopen flamecast `TS2322` (`tables` stays exactly the
  signed-off `AnyDurableTableTag`). *Tradeoff:* callers compose via the
  constructor rather than passing `layer` raw — a small, localized,
  documented ergonomic change. **No `any`, no cast, no paper, no
  invented/fake layer.**
- **(d2) c1-shape, CONTINGENT on `tf-uiz`=`y` landing first.** The
  §0.1 c1 (free per-call inference-only ROut, decoupled from `tables`)
  was falsified *while the merged-#350 `unknown` R-source was live*.
  Once `tf-uiz`=`y` narrows that source at its origin, c1 *may* become
  viable. Explicitly sequenced **after** `y`; requires full
  re-validation of the host-sdk Effect-R surface post-`y`. Honest: it
  still re-introduces a public ROut generic and is contingent, not
  root — kept only because the host-sdk falsification had a removable
  upstream cause.
- **(d3) Named/branded coarse `Layer` aggregate (c2 lineage) —
  FALLBACK.** `AnyDurableTableLayer<E> = Layer.Layer<any, E, never>`:
  one explicit, named, localized coarsening at a seam that is *already
  runtime-erased*, carrying the **same** signed-off justification as
  the tables-side `AnyDurableTableTag` (categorically distinct from the
  TFIND-005 diffuse/implicit/unnamed leak — §0/§8 discipline). `any`
  ROut is bidirectionally permissive, so it should not relocate the
  way `never` did (impl-validate `apps/factory` + host-sdk). A named
  `any` is acceptable **only** by that established tables-side
  symmetry; it is the fallback, not the primary recommendation.
- **(d4) Per-path / overloaded prop typing — REJECTED** (carried from
  c3: a React component cannot ergonomically vary props by call path;
  high complexity, no payoff over (d1)/(d3)).

**Recommendation: lean (d1).** It is the only option that makes the
boundary erasure *sound* — existential quantification of the layer's
ROut — rather than an operator value that is provably variance-wrong
(`unknown`/`never`) or ripple-prone (`c1`/any public generic). It is
the precise root-cause correction of TFIND-044 Option B's actual error
(collapsing `layer`'s ROut into a shared, value-position scalar), keeps
`tables` exactly on the signed-off `AnyDurableTableTag`, reintroduces
no `any`, and is orthogonal to the `tf-uiz`=`y` host-sdk track.
**(d3)** is the fallback if Gurdas rejects the constructor ergonomic
and accepts a named localized `any` by tables-side symmetry. **(d2)**
only as a post-`y` contingent. (a)/(b) are rejected by the §Evidence
table. Every (d) option requires post-signoff impl-time validation on
the exact gate that produced this Evidence: edo **both** consumer paths
(incl. the `#326`-curry `react-types.test.ts:55` site) + `apps/factory`
+ host-sdk-**alone** `tsc` + the full lint chain.

### Non-goals (§0.4)

- No production code before §0.4 signoff. No paper, no forcing cast, no
  scalar chosen to silence one path at another's expense, no
  invented/fake layer. (The only admissible `any` is the explicitly
  named, localized **(d3)** fallback under the tables-side symmetry
  justification — and only if Gurdas selects it.)
- Does not reopen §0's tables-side decision (`AnyDurableTableTag`
  stands), §0.3's host-sdk forensic record, or `tf-uiz`=`y`. The
  host-sdk curry×#350 cascade remains its own independent track.
- No change to provider **runtime** (per-key `unknown` acquisition is
  correct and is *why* an existential encoding is sound).
- Supersedes §0.1 only on the *shape* axis (its "pick a scalar"
  framing); §0.1's contravariance proof and (a)/(b) Evidence remain
  valid inputs to this decision.
- `#326` stays unpushed/unflipped; the rebased `sidecar-326flip`
  (`6355b7de6`, react.ts pristine) and `verify-main` worktrees stay
  exactly as they are until §0.4 is signed off **and** implemented (and
  `tf-uiz`=`y` lands).

## Contract

`effect-durable-operators` exposes a read-only TanStack collection view on each
collection facade:

```ts
const table = yield* RuntimeOutputTable
table.events.collection
```

The collection view is intended for query engines and UI bindings:

```tsx
const output = useDurableTable(RuntimeOutputTable)

const events = useLiveQuery((q) =>
  q.from({ events: output.events.collection })
    .where(({ events }) => eq(events.contextId, contextId)),
  [contextId],
)
```

Mutations through the collection view fail loudly. Applications write through
DurableTable generated actions:

```ts
yield* table.events.upsert(row)
yield* table.events.delete(key)
```

## React Subpath

React bindings live under `effect-durable-operators/react`, not the root
package export. The root package remains framework-free.

The React provider accepts a caller-composed Effect Layer and the table tags
that should be made available to descendants:

```tsx
<DurableTableProvider
  layer={Layer.mergeAll(
    RuntimeControlPlaneTable.layer(controlOptions),
    RuntimeOutputTable.layer(outputOptions),
  )}
  tables={[RuntimeControlPlaneTable, RuntimeOutputTable]}
  fallback={null}
>
  <App />
</DurableTableProvider>
```

The provider:

- builds the layer once for the provider lifetime;
- keeps the Effect Scope open while mounted;
- closes the scope on unmount;
- exposes acquisition status;
- never acquires layers per component render or per row operation.

Consumers use:

```ts
const control = useDurableTable(RuntimeControlPlaneTable)
const { status, error } = useDurableTableProviderStatus()
```

## Firegrid Usage

Firegrid UI packages should prefer product-level hooks over ad hoc API routes,
but those hooks should remain thin wrappers around shared table declarations
and `@firegrid/client` intent APIs.

For Flamecast, the intended path is:

- use copied web assets/components for UI only;
- use `@firegrid/client` for launch/prompt/open intent APIs;
- use shared DurableTable declarations plus TanStack live queries for state
  observation;
- do not preserve the historical Flamecast session/control-plane HTTP API.

## Boundaries

- Do not expose React from `effect-durable-operators` root.
- Do not duplicate DurableTable declarations between client and runtime.
- Do not expose raw `createStreamDB` or `createStateSchema` to UI apps.
- Do not add app-local wrappers that only rename DurableTable
  `insert/upsert/get/query/subscribe`.
- Do not mutate TanStack collections directly; write through DurableTable
  generated actions so txid coordination and schema-owned primary-key encoding
  remain intact.

## ACIDs

Implements:

- `effect-durable-operators.TABLE.21`
- `effect-durable-operators.TABLE.22`
- `effect-durable-operators.REACT.1`
- `effect-durable-operators.REACT.2`
- `effect-durable-operators.REACT.3`
- `effect-durable-operators.REACT.4`
- `effect-durable-operators.BOUNDARIES.14`
