# Runtime Pipeline Composition

`pipeline/` is per-session event-loop composition. It is not a durable stage.
The reconciliation target is to inline this role as
`agent-event-pipeline/session-runtime.ts` after host extraction.

## Pipeline Fit

This folder wires the stage roles together for a running codec session:

```txt
sources -> codecs -> transforms -> authorities
                         |
                         v
                    subscribers
```

It may open sessions, fork scoped subscribers, run row streams through durable
sinks, and return terminal evidence. It should not define new domain concepts
that belong in `events/`, `codecs/`, `authorities/`, or `subscribers/`.

## Boundary Rules

- Compose capability tags through Effect requirements and layers.
- Do not hide unresolved layer requirements behind `as Layer<...>` casts.
- Do not construct raw durable rows ad hoc when an event/envelope helper exists.
- Keep this folder small; growth here usually means a role-specific folder is
  missing an abstraction.
