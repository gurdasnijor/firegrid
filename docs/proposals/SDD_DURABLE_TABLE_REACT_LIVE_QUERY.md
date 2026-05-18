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
