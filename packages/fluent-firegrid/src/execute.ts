import { Effect } from "effect"
import { DurableStream } from "effect-durable-streams"
import { Scheduler } from "./scheduler.ts"
import type { Operation } from "./operation.ts"
import { foldStateEvents, JournalEventSchema, StateEventSchema, type ExecutionContext, type FluentRequirements, type StateRuntime } from "./schema.ts"

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
      : yield* Effect.gen(function* () {
        const stream = DurableStream.define({
          endpoint: state.endpoint,
          schema: StateEventSchema,
        })
        yield* stream.create({ contentType: "application/json" })
        const stateEvents = yield* stream.collect
        return {
          stream,
          values: foldStateEvents(stateEvents),
          pending: [],
        } satisfies StateRuntime
      })
    const scheduler = new Scheduler(journal, events, stateRuntime)
    return yield* scheduler.drive(operation)
  })
