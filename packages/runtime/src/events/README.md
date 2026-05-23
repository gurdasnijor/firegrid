# events/

Logical pipeline position: **1** (lowest). This folder defines the event
vocabulary that every later stage consumes.

Source: `docs/architecture/2026-05-22-runtime-physical-target-tree.md`.

## Owns

Pure schema/type modules for the canonical pipeline:

```text
events -> DurableTable(events) -> transforms(rows) -> keyed subscribers(rows)
```

- `agent-input.ts` — `AgentInputEvent` union + schema
- `agent-output.ts` — `AgentOutputEvent` union + schema
- `runtime-ingress.ts` — `RuntimeIngressInputRow` schema
- `runtime-output.ts` — `RuntimeEventRow` / `RuntimeLogLineRow` schemas
- `runtime-context-state.ts` — `RuntimeContextEventState` schema

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

## Scaffold status

Empty. Wave 2 moves event schema files in from
`packages/runtime/src/agent-event-pipeline/events/` and the protocol row
schemas.
