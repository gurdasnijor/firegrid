import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Option, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  makeChannelRegistry,
  stateChangesChannelFromCollection,
  type StateChangesChannel,
} from "../../src/host/index.ts"

const StateRowSchema = Schema.Struct({
  id: Schema.String.pipe(DurableTable.primaryKey),
  status: Schema.Literal("pending", "ready"),
  payload: Schema.Unknown,
})

class StateChangesTestTable extends DurableTable("stateChangesChannelTest", {
  rows: StateRowSchema,
}) {}

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const tableLayerOptions = (): DurableTableLayerOptions => {
  if (baseUrl === undefined) throw new Error("server not started")
  return {
    streamOptions: {
      url: `${baseUrl}/state-changes-channel-${crypto.randomUUID()}`,
      contentType: "application/json",
    },
  }
}

const runWithTable = <A, E>(
  effect: Effect.Effect<A, E, StateChangesTestTable>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          StateChangesTestTable.layer(tableLayerOptions()),
        ),
      ),
    ) as Effect.Effect<A, E, never>,
  )

describe("state.changes channel", () => {
  it("firegrid-agent-body-plan.STATE_CHANGES.1 firegrid-agent-body-plan.STATE_CHANGES.2 firegrid-agent-body-plan.STATE_CHANGES.3 firegrid-agent-body-plan.STATE_CHANGES.4 firegrid-agent-body-plan.STATE_CHANGES.5 wraps DurableTable rows behind an opaque afferent static-source channel", async () => {
    const program = Effect.gen(function* () {
        const table = yield* StateChangesTestTable
        const channel = stateChangesChannelFromCollection({
          target: "state.rows",
          schema: StateRowSchema,
          collection: table.rows,
        })

        const registry = makeChannelRegistry([channel])
        const agentVisibleWaitInput = { channel: "state.rows" }
        const registered = yield* registry.require(agentVisibleWaitInput.channel)
        const stateChanges = registered as StateChangesChannel<typeof StateRowSchema>

        expect(stateChanges.kind).toBe("state.changes")
        expect(stateChanges.direction).toBe("afferent")
        expect(stateChanges.sourceClass).toBe("static-source")
        expect(stateChanges.schema).toBe(StateRowSchema)
        const metadata = Option.getOrThrow(
          registry.getMetadata(agentVisibleWaitInput.channel),
        )
        expect(metadata.direction).toBe("afferent")
        if (metadata.direction !== "afferent") {
          return
        }
        expect(metadata.schema).toBe(StateRowSchema)
        expect(JSON.stringify(agentVisibleWaitInput)).not.toContain("stateChangesChannelTest")

        yield* table.rows.insert({
          id: "row-1",
          status: "ready",
          payload: { value: 1 },
        })

        const observed = yield* stateChanges.binding.stream.pipe(
          Stream.filter(row => row.status === "ready"),
          Stream.runHead,
        )

        expect(Option.getOrThrow(observed)).toEqual({
          id: "row-1",
          status: "ready",
          payload: { value: 1 },
        })
      }) as Effect.Effect<void, unknown, StateChangesTestTable>

    await runWithTable(program)
  })
})
