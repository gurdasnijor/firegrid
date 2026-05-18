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

## §0.2 — Ratified c1 FALSIFIED; reframe required (read this first)

> **Status (architect-level — beyond §0.1; coordinator does NOT
> decide).** Gurdas ratified §0.1 option **(c1)**. It was implemented
> exactly as ratified and **falsified by the binding §0.1 Evidence
> gate**. The §0.1 provider-`layer`-type option space (a/b/c1/c2/c3) is
> the **wrong axis**. This requires an architect reframe.
> **Reproducer:** branch `sidecar/tfind050-c1-decouple-rout`
> commit `b7a66e6b8` (kept unpushed as evidence).

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
