# events/

Logical pipeline position: **1** (lowest). This folder defines the event
vocabulary that every later stage consumes.

Source: `docs/architecture/2026-05-22-runtime-physical-target-tree.md`.

## Owns

Pure schema/type modules for the canonical pipeline:

```text
events -> DurableTable(events) -> transforms(rows) -> keyed subscribers(rows)
```

- `agent-input.ts` — `AgentInputEvent` union + schema (public events/agent-input subpath)
- `agent-output.ts` — `AgentOutputEvent` union + schema (public events/agent-output subpath)
- `contract.ts` — canonical `AgentInputEvent` / `AgentOutputEvent` definitions plus
  `AgentToolUseMode`, `PermissionDecision`, `ToolResultEvent`. Moved from
  `agent-event-pipeline/events/contract.ts`.
- `output.ts` — `RuntimeAgentOutputObservation` re-export from protocol session-facade.
  Moved from `agent-event-pipeline/events/output.ts`.
- `stage-contracts.ts` — branded `RuntimeSubscriberId`, `RuntimeAuthoritySourceName`,
  `RuntimeIdempotencyKey`. Moved from `agent-event-pipeline/events/stage-contracts.ts`.
- `runtime-context-state.ts` — `RuntimeContextEventState` schema.

## May import

- protocol schemas (`@firegrid/protocol/*`)
- `effect`, `effect/Schema` (schema only, no `Effect`/`Layer`)

## Must not import

- `tables/`, `producers/`, `transforms/`, `channels/`, `subscribers/`,
  `composition/`
- runtime state, channels, subscribers, workflow machinery
- `Effect`, `Layer`, `Context.Tag`, `Workflow.make`, `Activity.make`,
  `DurableDeferred`

## DO

```ts
// agent-input.ts
import { Schema } from "effect"
import type { RuntimeContext } from "@firegrid/protocol/launch"

export const AgentPromptSchema = Schema.Struct({ /* ... */ })
export type AgentPrompt = Schema.Schema.Type<typeof AgentPromptSchema>
```

## DO NOT

```ts
// agent-input.ts
import { RuntimeOutputTable } from "../tables/runtime-output.ts"             // direction violation
import { handleRuntimeContextEvent } from "../subscribers/runtime-context/handler.ts" // direction violation
```

## Move history

Wave 2 (cleanup/aep-physical-move): physically moved
`contract.ts`, `output.ts`, `stage-contracts.ts`, and `index.ts` from
`packages/runtime/src/agent-event-pipeline/events/` into this folder. Public
subpath `@firegrid/runtime/events` (and the new `events/agent-input` /
`events/agent-output`) re-point to the new file paths through
`packages/runtime/package.json`.
