/**
 * Tracer 017 — effect-durable-operators Firegrid proof.
 *
 * Implements:
 *  - effect-durable-operators.FIREGRID_PROOF.4 — runtime input fold replaced
 *    by provider-owned DurableStream reads plus a DurableTable checkpoint
 *    collection; legacy PendingRuntimeIngressState/foldRuntimeIngressProgress
 *    no longer referenced from packages/runtime/src
 *  - effect-durable-operators.FIREGRID_PROOF.2 — uses production Firegrid
 *    surfaces only (Firegrid.launch / Firegrid.prompt /
 *    Firegrid.open(...).snapshot / FiregridRuntimeHostLive / startRuntime).
 *    NO shadow harnesses, NO product-shaped durable read helpers.
 *  - effect-durable-operators.TRACER_017.5 — scenario E2E proves runtime
 *    input delivery still works through production surfaces after the
 *    refactor; duplicate idempotent prompts collapse at the provider.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "@firegrid/client"
import {
  FiregridRuntimeHostLive,
  startRuntime,
} from "@firegrid/runtime"
import { Duration, Effect, Fiber, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

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

// Local-process agent: echoes each received stdin line back as a JSONL
// `{type:"assistant", text:"input:<line>"}` event, then exits after the
// FIRST line. The single-shot exit is what lets us assert provider-visible
// dedupe: if the provider delivery checkpoint path duplicates a line, the second
// shot would also be visible — but the agent has already exited, so
// duplicates would surface as exit-failure or missing events.
const liveStdinEchoAgent = `
let buffered = ""
let count = 0
const keepAlive = setInterval(() => {}, 1000)
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  buffered += chunk
  while (buffered.includes("\\n")) {
    const index = buffered.indexOf("\\n")
    const line = buffered.slice(0, index).trim()
    buffered = buffered.slice(index + 1)
    if (line.length === 0) continue
    count += 1
    console.log(JSON.stringify({ type: "assistant", text: "input:" + line }))
    if (count >= 1) {
      clearInterval(keepAlive)
      setTimeout(() => process.exit(0), 10)
    }
  }
})
`

describe("firegrid tracer 017 effect-durable-operators Firegrid proof", () => {
  it(
    "effect-durable-operators.FIREGRID_PROOF.4 effect-durable-operators.FIREGRID_PROOF.2 effect-durable-operators.TRACER_017.5 production surfaces still deliver prompt input once after the DurableTable checkpoint refactor",
    async () => {
      if (!baseUrl) throw new Error("durable streams test server not started")
      // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
      const firegridConfig = {
        durableStreamsBaseUrl: baseUrl,
        namespace: `tracer-017-${crypto.randomUUID()}`,
        hostId: `tracer-017-${crypto.randomUUID()}`,
      }

      // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
      // Production host + client share one CurrentHostSession; the
      // launch row's host binding matches the host scope that runs
      // the agent.
      const hostLayer = FiregridRuntimeHostLive({
        ...firegridConfig,
        input: true,
      })
      const clientLayer = FiregridLive.pipe(
        Layer.provide(Layer.succeed(FiregridConfig, firegridConfig)),
      )

      const result = await Effect.runPromise(Effect.scoped(
        Effect.gen(function* () {
          const firegrid = yield* Firegrid
          const handle = yield* firegrid.launch({
            runtime: local.jsonl({
              argv: [process.execPath, "--input-type=module", "-e", liveStdinEchoAgent],
            }),
          })

          const runtimeFiber = yield* Effect.fork(
            startRuntime({ contextId: handle.contextId }),
          )

          const waitForStarted = Effect.gen(function* () {
            for (let index = 0; index < 200; index += 1) {
              const snapshot = yield* firegrid.open(handle.contextId).snapshot
              if (snapshot.status === "started") return
              yield* Effect.sleep(Duration.millis(25))
            }
            return yield* Effect.die(new Error("timed out waiting for runtime started"))
          })
          yield* waitForStarted

          // Send a prompt, then a duplicate with the SAME idempotency key.
          // The duplicate must collapse at the protocol layer (same
          // inputId) AND the provider-owned AtMostOnce checkpoint must
          // ensure the provider sees exactly one stdin chunk.
          const first = yield* firegrid.prompt({
            contextId: handle.contextId,
            payload: [{ type: "text", text: "continue live" }],
            idempotencyKey: "tracer-017-live-input",
          })
          const duplicate = yield* firegrid.prompt({
            contextId: handle.contextId,
            payload: [{ type: "text", text: "continue live duplicate" }],
            idempotencyKey: "tracer-017-live-input",
          })

          const runResult = yield* Fiber.join(runtimeFiber)
          const snapshot = yield* firegrid.open(handle.contextId).snapshot
          return { handle, first, duplicate, runResult, snapshot }
        }).pipe(
          Effect.provide(clientLayer),
          Effect.provide(hostLayer),
        ),
      ))

      expect(result.duplicate.inputId).toEqual(result.first.inputId)
      expect(result.runResult).toMatchObject({
        contextId: result.handle.contextId,
        exitCode: 0,
      })

      // The agent must have emitted EXACTLY ONE assistant event from
      // the first delivery. Any duplicate stdin chunk would either
      // appear as a second assistant row (visible here) or
      // exit-with-error (already asserted above).
      expect(result.snapshot.events.map((event) => event.raw)).toEqual([
        "{\"type\":\"assistant\",\"text\":\"input:continue live\"}",
      ])
    },
  )
})
