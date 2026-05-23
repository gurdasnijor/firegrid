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
- `runtime-context-input-facts.ts` — `RuntimeContextInputFacts` per-context
  read-side stream over `RuntimeControlPlaneTable.inputIntents`, plus the
  pure `ingressInputRowFromIntent` adapter

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

`runtime-context-state.ts` is a Wave 1 forward-target re-export that points at
the current physical location (`workflow-engine/runtime-context-state.ts`).
The runtime package exposes it as `@firegrid/runtime/tables/runtime-context-state`.
Wave 2 physically moves the implementation here; the public subpath stays
stable. The legacy `workflow-engine/runtime-context-state.ts` import in this
re-export is the only allowed cross-tier reach during Wave 1; the migration
gate baselines it.

`runtime-context-input-facts.ts` is a Wave A clean-room placement: the
implementation lives physically in this folder (no legacy source to bridge
from). The runtime package exposes it as
`@firegrid/runtime/tables/runtime-context-input-facts` — the stable
host-sdk/CC2 import target. The file owns the per-context read-side
`Stream<RuntimeIngressInputRow>` over `RuntimeControlPlaneTable.inputIntents`
and the pure `ingressInputRowFromIntent` adapter; append authority into
`inputIntents` continues to live with its existing producer sites (no peer
producer file is hoisted here because the hoisted slice is read-side only).
