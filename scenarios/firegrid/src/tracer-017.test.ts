/**
 * Tracer 017 — effect-durable-operators Firegrid proof.
 *
 * Implements:
 *  - effect-durable-operators.FIREGRID_PROOF.1 — runtime input fold owned
 *    by the generic operator package (DurableConsumer); legacy
 *    PendingSessionInputState/foldSessionInputProgress no longer
 *    referenced from packages/runtime/src
 *  - effect-durable-operators.FIREGRID_PROOF.2 — uses production Firegrid
 *    surfaces only (Firegrid.launch / Firegrid.prompt /
 *    Firegrid.open(...).snapshot / FiregridRuntimeHostLive / startRuntime).
 *    NO shadow harnesses, NO product-shaped durable read helpers.
 *  - effect-durable-operators.FIREGRID_PROOF.3 — runtime input delivery
 *    uses the GENERIC `effect-durable-operators.ConsumerCheckpointStoreLive`
 *    backed by a separate `inputCheckpoints` stream URL wired through
 *    `FiregridRuntimeHostStreams.inputCheckpoints`. There is no
 *    Firegrid-specific checkpoint Layer; the generic operator package
 *    has no Firegrid imports.
 *  - effect-durable-operators.TRACER_017.5 — scenario E2E proves runtime
 *    input delivery still works through production surfaces after the
 *    refactor; duplicate idempotent prompts collapse at the provider.
 */

import {
  startDurableStreamsTestServer,
  type DurableStreamsTestServerHandle,
} from "@firegrid/durable-streams/test-utils"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "@firegrid/client"
import {
  FiregridRuntimeHostLive,
  RuntimeInputDurableStreams,
  startRuntime,
} from "@firegrid/runtime"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let server: DurableStreamsTestServerHandle | undefined

beforeEach(async () => {
  server = await startDurableStreamsTestServer()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
})

const createStreamUrl = async (name: string): Promise<string> => {
  if (!server) throw new Error("durable streams test server not started")
  return server.createStreamUrl(name)
}

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
// dedupe: if the DurableConsumer fold path duplicates a line, the second
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
    "effect-durable-operators.FIREGRID_PROOF.1 effect-durable-operators.FIREGRID_PROOF.2 effect-durable-operators.TRACER_017.5 production surfaces still deliver prompt input once after the DurableConsumer refactor",
    async () => {
      const controlPlaneStreamUrl = await createStreamUrl("tracer-017-runtime-control")
      const dataPlaneStreamUrl = await createStreamUrl("tracer-017-runtime-output")
      const workflowStreamUrl = await createStreamUrl("tracer-017-workflow")
      const inputStreamUrl = await createStreamUrl("tracer-017-session-input")
      const inputCheckpointsUrl = await createStreamUrl("tracer-017-input-checkpoints")

      const firegridConfigLayer = Layer.succeed(FiregridConfig, {
        runtimeStreamUrl: controlPlaneStreamUrl,
        controlPlaneStreamUrl,
        dataPlaneStreamUrl,
        inputStreamUrl,
      })

      // Production launch surface — no shadow harness.
      const handle = await Effect.runPromise(
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
      )

      // Production host surface — runtime is responsible for plumbing
      // session input into the local-process stdin via DurableConsumer.
      const host = FiregridRuntimeHostLive({
        streams: {
          workflow: workflowStreamUrl,
          controlPlane: controlPlaneStreamUrl,
          runtimeOutput: dataPlaneStreamUrl,
          // Tagged input capability: session input + checkpoints are one
          // indivisible value, so half-configured input is
          // unrepresentable. Generic effect-durable-operators owns
          // delivery progress; no session-input accepted progress rows are written.
          input: new RuntimeInputDurableStreams({
            sessionInput: inputStreamUrl,
            checkpoints: inputCheckpointsUrl,
          }),
        },
      })

      const runtime = Effect.runPromise(
        startRuntime({ contextId: handle.contextId }).pipe(
          Effect.provide(host),
        ),
      )

      // Wait until the runtime has reported started — the DurableConsumer
      // fold path inside local-process-stdin must be running.
      await waitFor(async () => {
        const snapshot = await Effect.runPromise(
          Effect.gen(function* () {
            const firegrid = yield* Firegrid
            return yield* firegrid.open(handle.contextId).snapshot
          }).pipe(
            Effect.provide(FiregridLive.pipe(Layer.provide(firegridConfigLayer))),
          ),
        )
        return snapshot.status === "started"
      })

      // Send a prompt, then send a duplicate with the SAME idempotency key.
      // The duplicate must collapse at the protocol layer (same sessionInputId)
      // AND the AtMostOnce DurableConsumer policy must ensure the provider
      // sees exactly one stdin chunk.
      const prompt = await Effect.runPromise(
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
      )

      expect(prompt.duplicate.sessionInputId).toEqual(prompt.first.sessionInputId)

      const result = await runtime
      expect(result).toMatchObject({
        contextId: handle.contextId,
        exitCode: 0,
      })

      // Production snapshot surface — the agent must have emitted EXACTLY
      // ONE assistant event from the first delivery. Any duplicate stdin
      // chunk would either appear as a second assistant row (visible here)
      // or exit-with-error (already asserted above).
      const snapshot = await Effect.runPromise(
        Effect.gen(function* () {
          const firegrid = yield* Firegrid
          return yield* firegrid.open(handle.contextId).snapshot
        }).pipe(
          Effect.provide(FiregridLive.pipe(Layer.provide(firegridConfigLayer))),
        ),
      )

      expect(snapshot.events.map((event) => event.raw)).toEqual([
        "{\"type\":\"assistant\",\"text\":\"input:continue live\"}",
      ])
    },
  )
})
