# @firegrid/runtime

`@firegrid/runtime` is intentionally small.

Application state is modeled directly with `@durable-streams/state`.
Firegrid runtime code provides only:

- `@firegrid/runtime/durable-clock` for the durable Clock layer used by
  `Effect.sleep`, `Schedule`, and time-aware `Stream` operators.

The old operation, event-plane, subscriber, wait, and substrate APIs are gone.
