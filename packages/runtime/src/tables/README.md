# tables/

Logical pipeline position: **2**. May import `events/`. Must not import any
later stage.

Source: `docs/architecture/2026-05-22-runtime-physical-target-tree.md`.

## Owns

`DurableTable`-backed state-of-record definitions. One table family per file:

- `runtime-control-plane.ts` — `RuntimeControlPlaneTable`
- `runtime-output.ts` — `RuntimeOutputTable`
- `runtime-context-state.ts` — `RuntimeContextStateStore` (per-context loop
  state) and the `nextOutputObservation` point-read primitive

A table file owns the schema, the `DurableTable("name", { schemas })` value,
and the **point-read selection helpers** that decide which row to surface from
the table (for example `nextOutputObservation`'s
`isStateRelevantOutputObservation`, which decides which output rows the
next-output point read may surface to a Shape C subscriber). It does NOT own
append/write authority — that lives in `producers/`.

Transition/reducer logic does NOT live here. A function that takes a state
plus a fact and returns the next state (`transitionInputEvent`,
`transitionOutputEvent`) belongs in `transforms/`. Tables expose selection
helpers tied to a table point read; reducers live one tier up at the pure
transform layer.

## May import

- `events/` (row schemas)
- protocol schemas (`@firegrid/protocol/*`)
- `effect-durable-operators` (`DurableTable`, `DurableTableHeaders`)
- `effect`

## Must not import

- `producers/`, `transforms/`, `channels/`, `subscribers/`, `composition/`
- subscriber logic, channel router, workflow machinery
- `Workflow.make`, `Activity.make`, `DurableDeferred`, workflow-engine tags

## DO

```ts
// runtime-context-state.ts
export const RuntimeContextStateStore =
  Context.GenericTag<RuntimeContextStateStoreService>("...")
export const nextOutputObservation = (/* ... */) =>
  Effect.gen(/* point-get; no scan */)
```

## DO NOT

```ts
// runtime-context-state.ts
import { handleRuntimeContextEvent } from "../subscribers/runtime-context/handler.ts"
import { Workflow } from "@effect/workflow"   // table owns rows, not workflow execution
```

## Scaffold status

`runtime-context-state.ts` is the canonical home for `RuntimeContextStateStore`,
`makePerContextRuntimeContextStateStore`, `nextOutputObservation`, and
`isStateRelevantOutputObservation`. The Wave 1 forward-target re-export shim
that previously pointed back at `workflow-engine/runtime-context-state.ts` was
replaced by the physical move in Wave A of the Shape C cutover. The public
subpath `@firegrid/runtime/tables/runtime-context-state` is unchanged.

In-tree legacy re-exports through `@firegrid/runtime/kernel` and
`@firegrid/runtime/workflow-engine` remain available to existing host-sdk
callers until they migrate to the semantic subpath; new code MUST import from
`@firegrid/runtime/tables/runtime-context-state` directly.
