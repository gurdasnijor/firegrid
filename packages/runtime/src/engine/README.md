# engine/ — durable workflow-execution substrate

Owns the durable `WorkflowEngine` machinery: the engine factory
(`DurableStreamsWorkflowEngine`), its row/table schemas, the engine
runtime, the workflow-result codec, and the activity-contract span
helper. This is the runtime's only home for `@effect/workflow` substrate
plumbing.

Placement in the target tree (see
`docs/architecture/2026-05-22-runtime-physical-target-tree.md` §"Target
Tree" + §"Logical Order And Import Direction"): **leaf-tier substrate**,
sibling of `events/`, below the pipeline tiers
(`tables/` → `producers/` / `transforms/` / `channels/` →
`subscribers/` → `composition/`).

## What this folder owns

- `durable-streams-workflow-engine.ts` — `DurableStreamsWorkflowEngine`
  (`make` + `layer` constructors) over `effect-durable-operators`.
- `internal/` — substrate-private implementation. Externally importable
  only through `durable-streams-workflow-engine.ts`.
  - `engine-runtime.ts` — `makeWorkflowEngine`.
  - `table.ts` — `WorkflowEngineTable` + `WorkflowExecutionRow` /
    `WorkflowActivityRow` / `WorkflowDeferredRow` / `WorkflowClockWakeupRow`
    / `WorkflowActivityClaimRow` schemas.
  - `codec.ts` — workflow-result encode/decode + exit revival.
  - `contract-activity.ts` — `withActivityContract` /
    `annotateActivityContractSpan` for Shape D handlers that need an
    activity-contract span seam.

## Which folders may import this

- `subscribers/` **Shape D** subfolders (`tool-dispatch/`,
  `wait-router/`, `scheduled-prompt/`, `runtime-control/`) — under their
  README workflow-machinery justification.
- `composition/` — `host-workflow-engine.ts` composes
  `HostWorkflowEngineLive` from `DurableStreamsWorkflowEngine.layer({...})`.

## What this folder must not do

- Import `events/`, `tables/`, `producers/`, `transforms/`,
  `channels/`, `subscribers/`, or `composition/`. The substrate is
  leaf-tier with no runtime-internal dependencies (only base libraries
  + `@effect/workflow` + `effect-durable-operators` + `@firegrid/protocol/otel`).
- Surface `internal/*` to external importers. Only
  `durable-streams-workflow-engine.ts` is part of the externally
  importable surface.
- Become a public package subpath. The substrate is composition-private;
  external consumers (host-sdk, firelab simulations) reach the
  engine via `@firegrid/runtime/composition/host-workflow-engine`'s
  `HostWorkflowEngineLive`, never through `@firegrid/runtime/engine`.

## DO / DO NOT

**DO** import the engine substrate from a Shape D subscriber:

```ts
// packages/runtime/src/subscribers/tool-dispatch/dispatch.ts
import { WorkflowEngine } from "@effect/workflow"
import { DurableStreamsWorkflowEngine } from "../../engine/durable-streams-workflow-engine.ts"
```

**DO NOT** import `engine/internal/*` from outside `engine/`:

```ts
// ❌ packages/runtime/src/subscribers/runtime-context/handler.ts
import { withActivityContract } from "../../engine/internal/contract-activity.ts"
//                                              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
// engine/internal/ is substrate-private. Surface what you need on
// engine/durable-streams-workflow-engine.ts or add a sibling target file
// inside engine/ — do not reach into internal/.
```
