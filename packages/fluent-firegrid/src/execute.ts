import { Effect } from "effect"
import { DurableStream, type Endpoint } from "effect-durable-streams"
import { FluentFiregridError } from "./error.ts"
import { DurableOperationProducers } from "./operations.ts"
import { Scheduler } from "./scheduler.ts"
import type { Operation } from "./operation.ts"
import { foldStateEvents, JournalEventSchema, StateEventSchema, type ExecutionContext, type FluentRequirements, type StateRuntime } from "./schema.ts"

// Extracted from the inline `yield* Effect.gen(...)` so the state substrate is a
// named, traced operation rather than a bare nested generator (nestedEffectGenYield).
const makeStateRuntime = Effect.fn("fluent_firegrid.execute.state_runtime")(
  function* (endpoint: Endpoint) {
    const stream = DurableStream.define({
      endpoint,
      schema: StateEventSchema,
    })
    yield* stream.create({ contentType: "application/json" })
    const stateEvents = yield* stream.collect
    return {
      stream,
      values: foldStateEvents(stateEvents),
      pending: [],
    } satisfies StateRuntime
  },
)

export const execute = <T>(
  ctx: ExecutionContext,
  operation: Operation<T>,
): Effect.Effect<T, unknown, FluentRequirements> =>
  Effect.gen(function* () {
    // fluent-firegrid-keystone.SUBSTRATE.2
    const journal = DurableStream.define({
      endpoint: ctx.journal.endpoint,
      schema: JournalEventSchema,
    })
    yield* journal.create({ contentType: "application/json" })
    const events = yield* journal.collect
    const state = ctx.state
    const stateRuntime = state === undefined
      ? undefined
      : yield* makeStateRuntime(state.endpoint)
    const schedulerRef: { current?: Scheduler } = {}
    const operations = new DurableOperationProducers(
      journal,
      events,
      (child) => {
        const scheduler = schedulerRef.current
        return scheduler === undefined
          ? Effect.fail(new FluentFiregridError({
            message: "Scheduler unavailable while spawning operation",
          }))
          : scheduler.drive(child)
      },
      stateRuntime,
    )
    const scheduler = new Scheduler(operations)
    schedulerRef.current = scheduler
    return yield* scheduler.drive(operation)
  })
