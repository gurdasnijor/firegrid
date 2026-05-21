import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  sessionLogChannelFromCollection,
} from "../../src/channels/index.ts"
import {
  SessionLogRowSchema,
} from "@firegrid/protocol/channels"

class SessionLogTestTable extends DurableTable("sessionLogChannelTest", {
  rows: SessionLogRowSchema,
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
      url: `${baseUrl}/session-log-channel-${crypto.randomUUID()}`,
      contentType: "application/json",
    },
  }
}

const runWithTable = <A, E>(
  effect: Effect.Effect<A, E, SessionLogTestTable>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(SessionLogTestTable.layer(tableLayerOptions())),
      ),
    ) as Effect.Effect<A, E, never>,
  )

describe("session.log channel", () => {
  it("firegrid-agent-body-plan.SESSION_LOG.1 firegrid-agent-body-plan.SESSION_LOG.2 firegrid-agent-body-plan.SESSION_LOG.3 firegrid-agent-body-plan.SESSION_LOG.4 firegrid-agent-body-plan.SESSION_LOG.5 registers an egress-only durable session log channel", async () => {
    const program = Effect.gen(function* () {
      const table = yield* SessionLogTestTable
      const channel = sessionLogChannelFromCollection({
        collection: table.rows,
      })
      const registered = channel

      expect(channel.target).toBe("session.log")
      expect(channel.kind).toBe("session.log")
      expect(channel.storage).toBe("durable-table")
      expect(registered.direction).toBe("egress")
      expect(registered.schema).toBe(SessionLogRowSchema)
      expect("stream" in registered.binding).toBe(false)

      yield* registered.binding.append({
        logId: "log-1",
        contextId: "ctx-session-log",
        message: "planned next action",
        createdAt: "2026-05-20T00:00:00.000Z",
        payload: { step: 1 },
      })

      const rows = yield* table.rows.query(coll => coll.toArray)
      expect(rows).toEqual([
        {
          logId: "log-1",
          contextId: "ctx-session-log",
          message: "planned next action",
          createdAt: "2026-05-20T00:00:00.000Z",
          payload: { step: 1 },
        },
      ])
    }) as Effect.Effect<void, unknown, SessionLogTestTable>

    await runWithTable(program)
  })
})
