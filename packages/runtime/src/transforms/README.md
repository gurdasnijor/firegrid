# transforms/

Logical pipeline position: **4** (peer with `producers/`, `channels/`). May
import `events/` only. Peers do not import each other. Must not import any
later stage.

Source: `docs/architecture/2026-05-22-runtime-physical-target-tree.md`.

## Owns

Pure row/event transforms — no `Effect`, no requirements channel, no I/O.
Every exported value is a plain function over schemas:

- `decode-ingress-row.ts` — `agentInputEventFromRuntimeIngressRow`
- `decode-output-row.ts` — `runtimeAgentOutputObservationFromRow`
- `field-equals.ts` — `evaluateFieldEquals` + `FieldEqualsTrigger`
- `runtime-context-transition.ts` — `transitionInputEvent`,
  `transitionOutputEvent`

These are the *reducer/decoder layer*. Subscribers wire I/O around them; the
transforms themselves are reasoned about in isolation.

## May import

- `events/` (event vocabulary, schemas)
- protocol schemas
- `effect/Schema`, `effect/Option`, `effect/Match`, narrow pure helpers

## Must not import

This is a HARD purity boundary. The folder must NOT import:

- `tables/`, `producers/`, `channels/`, `subscribers/`, `composition/`
- `Effect`, `Layer`, `Context.Tag`, `Stream`, `Workflow.make`,
  `Activity.make`, `DurableDeferred`, `DurableClock`
- file system, network, durable tables, channels, workflow engine

A transform export whose type includes `Effect.Effect<...>` is mis-shaped.

## DO

```ts
// runtime-context-transition.ts
export const transitionInputEvent = (
  state: RuntimeContextEventState,
  event: AgentInputEvent,
): RuntimeContextTransitionResult => { /* pure */ }
```

## DO NOT

```ts
// runtime-context-transition.ts
export const transitionInputEvent = (state, event) =>
  Effect.gen(function* () { /* ... */ })    // not a transform; this is a subscriber
```

## Scaffold status

Populated. The pure transition, ingress-row decoder, output-row decoder, and
field-equals transform live here. The former Effect-form ingress adapter under
`workflow-engine/workflows/runtime-ingress-transform.ts` was deleted once all
callers used the pure decoder directly; a transform export whose public type is
`Effect.Effect<...>` remains mis-shaped.
