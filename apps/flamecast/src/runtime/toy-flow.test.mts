import { DurableStreamTestServer } from "@durable-streams/server"
import { assert, describe, it } from "@effect/vitest"
import { Firegrid, FiregridConfig, FiregridLive, local } from "@firegrid/client"
import { FiregridRuntimeHostLive, startRuntime } from "@firegrid/runtime/runtime-host"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach } from "vitest"
import {
  flamecastToyAgentSource,
  flamecastToyCreatedBy,
} from "../shared/agent.ts"

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

const layer = () => {
  if (baseUrl === undefined) throw new Error("server not started")
  const namespace = "flamecast-toy-test"
  // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
  //
  // The runtime host layer provides RuntimeControlPlaneTable +
  // CurrentHostSession to the client, so launch / prompt / snapshot
  // share one materialized RuntimeContext index and one host id.
  const hostLayer = FiregridRuntimeHostLive({
    durableStreamsBaseUrl: baseUrl,
    namespace,
    input: true,
  })
  return FiregridLive.pipe(
    Layer.provide(Layer.succeed(FiregridConfig, {
      durableStreamsBaseUrl: baseUrl,
      namespace,
    })),
    Layer.provideMerge(hostLayer),
  )
}

describe("flamecast toy stdio runtime", () => {
  it.effect(
    "flamecast-toy-stdio-agents.LOCAL_AGENT.1 flamecast-toy-stdio-agents.LOCAL_AGENT.2 flamecast-toy-stdio-agents.LOCAL_AGENT.3 launches, prompts, and observes through Firegrid client semantics",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firegrid = yield* Firegrid
          const handle = yield* firegrid.launch({
            requestedBy: flamecastToyCreatedBy,
            runtime: local.jsonl({
              argv: [
                process.execPath,
                "--input-type=module",
                "-e",
                flamecastToyAgentSource,
              ],
            }),
          })
          yield* firegrid.prompt({
            contextId: handle.contextId,
            payload: { type: "text", text: "hello durable stdin" },
            idempotencyKey: `${handle.contextId}:initial`,
          })
          yield* startRuntime({ contextId: handle.contextId })

          const snapshot = yield* Effect.scoped(
            Effect.gen(function* () {
              const fresh = yield* Firegrid
              return yield* fresh.open(handle.contextId).snapshot
            }).pipe(Effect.provide(layer())),
          )
          assert.strictEqual(snapshot.context?.createdBy, flamecastToyCreatedBy)
          assert.strictEqual(snapshot.status, "exited")
          assert.strictEqual(snapshot.events.length, 1)
          assert.strictEqual(snapshot.logs.length, 0)
          assert.strictEqual(
            snapshot.events.some(row => row.raw.includes("stdin durable hello")),
            true,
          )
        }).pipe(Effect.provide(layer())),
      ),
  )
})
