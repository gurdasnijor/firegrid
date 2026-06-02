# capabilities/

Logical pipeline position: **1b** (peer with `events/`). Pure declarations.
May import `events/` and `tables/` (for row type references in Tag schemas).
Must not import any behavior-bearing tier.

Source: `docs/sdds/SDD_FIREGRID_RUNTIME_SOURCE_PRODUCER_ROLES.md`.

## Owns

**Typed capability `Context.Tag` declarations** — pure Tag exports that
producers implement and subscribers depend on. Each file in this folder
exports exactly one Tag (and the type of the service the Tag carries),
with no `Layer.*` constructors and no `Effect.*` behavior.

A capability file looks like:

```ts
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type { ScheduledPromptIntent } from "../tables/scheduled-prompt.ts"

export interface ScheduledPromptIngressAppenderService {
  readonly append: (
    intent: ScheduledPromptIntent,
  ) => Effect.Effect<void>
}

export class ScheduledPromptIngressAppender extends Context.Tag(
  "@firegrid/runtime/ScheduledPromptIngressAppender",
)<ScheduledPromptIngressAppender, ScheduledPromptIngressAppenderService>() {}
```

## Why this tier exists

The `subscribers/ ✗ producers/` dep-cruiser rule is mechanically enforceable
because subscribers depend on capability Tags from this folder rather than
on the producer files themselves. The Live binding that implements each
Tag lives in `producers/`; the host layer wires the Live into the runtime
Layer graph.

Mirror of how `events/` works for data: pure declarations importable from
any consuming tier; behavior lives one tier up.

## May import

- `events/` — for row schema type references in Tag service shapes.
- `tables/` — for row type references (NOT for write capabilities; the Tag
  describes the *capability*, not the table internals).
- `effect/Context`, `effect/Effect`, `effect/Stream`, `effect/Sink`,
  `effect/Layer` — type references only.

## Must not import

- `sources/`, `producers/`, `transforms/`, `channels/`, `subscribers/`,
  `composition/`
- `_archive/`

## Scaffold status

Empty (README only) at PR-M1 landing. PR-M2 adds
`scheduled-prompt-ingress.ts`; PR-M3 adds `runtime-input-ingress.ts`.
