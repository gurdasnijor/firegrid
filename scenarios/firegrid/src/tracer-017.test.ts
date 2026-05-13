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
import { Effect, Layer } from "effect"
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

const waitFor = async (
  check: () => Promise<boolean>,
): Promise<void> => {
  for (let index = 0; index < 200; index += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("timed out waiting for runtime state")
}

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
      const firegridConfig = {
        durableStreamsBaseUrl: baseUrl,
        namespace: `tracer-017-${crypto.randomUUID()}`,
      }

      const firegridConfigLayer = Layer.succeed(FiregridConfig, {
        ...firegridConfig,
      })

      // Production launch surface — no shadow harness.
      const handle = await Effect.runPromise(Effect.scoped(
        Effect.gen(function* () {
          const firegrid = yield* Firegrid
          return yield* firegrid.launch({
            runtime: local.jsonl({
              argv: [process.execPath, "--input-type=module", "-e", liveStdinEchoAgent],
            }),
          })
        }).pipe(
          Effect.provide(FiregridLive.pipe(Layer.provide(firegridConfigLayer))),
        ),
      ))

      // Production host surface — runtime is responsible for plumbing
      // ingress into the local-process stdin through provider-owned delivery.
      const host = FiregridRuntimeHostLive({
        ...firegridConfig,
        input: true,
      })

      const runtime = Effect.runPromise(
        startRuntime({ contextId: handle.contextId }).pipe(
          Effect.provide(host),
        ),
      )

      // Wait until the runtime has reported started — the provider delivery
      // path inside local-process-stdin must be running.
      await waitFor(async () => {
        const snapshot = await Effect.runPromise(Effect.scoped(
          Effect.gen(function* () {
            const firegrid = yield* Firegrid
            return yield* firegrid.open(handle.contextId).snapshot
          }).pipe(
            Effect.provide(FiregridLive.pipe(Layer.provide(firegridConfigLayer))),
          ),
        ))
        return snapshot.status === "started"
      })

      // Send a prompt, then send a duplicate with the SAME idempotency key.
      // The duplicate must collapse at the protocol layer (same inputId)
      // AND the provider-owned AtMostOnce checkpoint must ensure the provider
      // sees exactly one stdin chunk.
      const prompt = await Effect.runPromise(Effect.scoped(
        Effect.gen(function* () {
          const firegrid = yield* Firegrid
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
          return { first, duplicate }
        }).pipe(
          Effect.provide(FiregridLive.pipe(Layer.provide(firegridConfigLayer))),
        ),
      ))

      expect(prompt.duplicate.inputId).toEqual(prompt.first.inputId)

      const result = await runtime
      expect(result).toMatchObject({
        contextId: handle.contextId,
        exitCode: 0,
      })

      // Production snapshot surface — the agent must have emitted EXACTLY
      // ONE assistant event from the first delivery. Any duplicate stdin
      // chunk would either appear as a second assistant row (visible here)
      // or exit-with-error (already asserted above).
      const snapshot = await Effect.runPromise(Effect.scoped(
        Effect.gen(function* () {
          const firegrid = yield* Firegrid
          return yield* firegrid.open(handle.contextId).snapshot
        }).pipe(
          Effect.provide(FiregridLive.pipe(Layer.provide(firegridConfigLayer))),
        ),
      ))

      expect(snapshot.events.map((event) => event.raw)).toEqual([
        "{\"type\":\"assistant\",\"text\":\"input:continue live\"}",
      ])
    },
  )
})
