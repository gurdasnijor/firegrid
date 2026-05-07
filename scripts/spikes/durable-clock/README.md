# Durable Clock dispatch/resume spike

Isolated, non-workspace scratch artifact that validates whether a custom
Effect `Clock` Layer can serve as Firegrid's durable wake-up dispatch
boundary.

This package is intentionally outside `pnpm-workspace.yaml`; it is not a
Firegrid public surface, is not exercised by CI, and must not become an
import target for production code. See
`docs/research/durable-clock-spike.md` for the verdict and the next
substrate decision the spike unlocks.

## Run

```sh
cd scripts/spikes/durable-clock
pnpm install --ignore-workspace
pnpm test
```

## Files

- `src/wakeup-store.ts` — durable wake-up record store. Interface
  intentionally shaped so a Durable Streams + State Protocol backing
  can later satisfy it (`appendWakeup`, `listPending`, `listDue`,
  `markDispatched`, `cancel`, `snapshot`). The spike uses an
  in-memory implementation.
- `src/durable-clock.ts` — `makeDurableClockDispatcher` builds an
  Effect `Clock` (with the proper `Clock.ClockTypeId` brand),
  installed via `Layer.setClock`. `Clock.sleep` appends a durable
  wake-up before parking the fiber via `Deferred`. The dispatcher
  exposes `nowMs` / `advance` / `tick` / `liveCount`.
- `src/__tests__/durable-clock.spike.test.ts` — five cases covering
  live substitution (sleep, timeout, retry/exponential, Stream tick)
  and the restart boundary.

## Boundaries this spike holds

- No Effect `Scheduler` override.
- No Firegrid `wait.sleep`/`wait.timeout`/`Schedule` wrappers.
- No edits to `packages/`. The spike is fully self-contained.
- No real Durable Streams wiring; the question under test is the
  Firegrid Clock substitution boundary, not upstream protocol
  behavior.
