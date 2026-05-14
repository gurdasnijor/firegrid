/**
 * Tracer 021 — follow-up prompt ingress to a running runtime context.
 *
 * Implements `Tracer I` from
 * docs/tracers/019-workflow-driven-runtime-next-wave.md.
 *
 * The flow under test:
 *
 *   client                                runtime host                      child
 *   ────────────────────────────────      ───────────────────────────       ────────
 *   Firegrid.launch ─► context row ─►
 *                                         RuntimeContextWorkflow.start
 *                                         spawns local process              alive
 *   Firegrid.prompt #1 ─► inputs row (seq 0, status=sequenced)
 *                                         stdin subscription claims
 *                                         deliveries[key#1].claimedAt set
 *                                         emits bytes to stdin              echo #1 to stdout
 *   Firegrid.prompt #2 ─► inputs row (seq 1, status=sequenced)
 *                                         stdin subscription claims
 *                                         deliveries[key#2].claimedAt set
 *                                         emits bytes to stdin              echo #2 to stdout, exit
 *   Firegrid.prompt #2 dup ─► same inputId, no new row, no new deliveries
 *   Firegrid.prompt #3 (post-terminal) ─► inputs row (seq 2, status=sequenced)
 *                                         no live subscription              no delivery, no marker
 *
 * Linked ACIDs:
 *   firegrid-agent-ingress.INGRESS.1  durable input row shape
 *   firegrid-agent-ingress.INGRESS.2  same model for follow-up inputs
 *   firegrid-agent-ingress.INGRESS.3  idempotency-keyed dedup
 *   firegrid-agent-ingress.INGRESS.4  explicit sequence ordering
 *   firegrid-agent-ingress.INGRESS.6  write does not synchronously invoke a workflow/operator/provider
 *   firegrid-agent-ingress.INGRESS.9  writer assigns explicit per-context sequence
 *   firegrid-agent-ingress.DELIVERY.1 provider consumes sequenced rows at adapter boundary
 *   firegrid-agent-ingress.DELIVERY.3 delivery progress is durable in deliveries collection
 *   firegrid-agent-ingress.DELIVERY.5 provider-owned subscription writes claim before emission
 *   firegrid-agent-ingress.HOST.1     host owns ingress topology
 *   firegrid-agent-ingress.HOST.3     initial + follow-up exercise the same path
 *
 * Out of scope (see 021-follow-up-prompt-ingress.md):
 *   - terminal/not-live behavior: the public surface currently has no
 *     RuntimeContext.status state-machine, so post-terminal prompts succeed
 *     at the durable write but produce no delivery/marker. This tracer
 *     documents that as a gap rather than implementing the typed
 *     not-live failure.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridDurableTablesLive,
  FiregridLive,
  FiregridRuntimeTables,
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

// Local-process agent that echoes each received stdin line back as a JSONL
// `{type:"assistant", text:"input:<line>"}` event and exits after the
// SECOND line. The two-shot exit is what lets us prove ordering across
// multiple follow-up prompts and dedup of a duplicate idempotency-keyed
// prompt — if the provider delivery duplicated a row, the agent would
// see three inputs instead of two, but it has already exited after the
// second.
const twoShotStdinAgent = `
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
    if (count >= 2) {
      clearInterval(keepAlive)
      setTimeout(() => process.exit(0), 10)
    }
  }
})
`

describe("firegrid tracer 021 follow-up prompt ingress to a running context", () => {
  it("firegrid-agent-ingress.INGRESS.1 firegrid-agent-ingress.INGRESS.2 firegrid-agent-ingress.INGRESS.3 firegrid-agent-ingress.INGRESS.4 firegrid-agent-ingress.INGRESS.6 firegrid-agent-ingress.INGRESS.9 firegrid-agent-ingress.DELIVERY.1 firegrid-agent-ingress.DELIVERY.3 firegrid-agent-ingress.DELIVERY.5 firegrid-agent-ingress.HOST.1 firegrid-agent-ingress.HOST.3 client follow-up prompts reach a running context through durable ingress, dedupe on idempotency, and a post-terminal prompt is durably recorded but undelivered", async () => {
    if (!baseUrl) throw new Error("durable streams test server not started")
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `tracer-021-${crypto.randomUUID()}`,
    }
    const firegridClientLayer = FiregridLive.pipe(
      Layer.provide(Layer.succeed(FiregridConfig, { ...firegridConfig })),
    )
    const firegridDurableTablesLayer = FiregridDurableTablesLive.pipe(
      Layer.provide(Layer.succeed(FiregridConfig, { ...firegridConfig })),
    )

    // 1. Launch the long-running agent.
    const handle = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.launch({
          runtime: local.jsonl({
            argv: [process.execPath, "--input-type=module", "-e", twoShotStdinAgent],
          }),
        })
      }).pipe(Effect.provide(firegridClientLayer)),
    ))

    // 2. Start the runtime host with input enabled. Same host composition
    //    every long-running runtime uses; this tracer adds no bespoke layer.
    const host = FiregridRuntimeHostLive({ ...firegridConfig, input: true })
    const runtime = Effect.runPromise(
      startRuntime({ contextId: handle.contextId }).pipe(Effect.provide(host)),
    )

    // 3. Wait for the runtime to be "started" before sending follow-ups,
    //    so the assertions about follow-up ingress aren't racing the
    //    initial spawn.
    await waitFor(async () => {
      const snapshot = await Effect.runPromise(Effect.scoped(
        Effect.gen(function* () {
          const firegrid = yield* Firegrid
          return yield* firegrid.open(handle.contextId).snapshot
        }).pipe(Effect.provide(firegridClientLayer)),
      ))
      return snapshot.status === "started"
    })

    // 4. Append two follow-up prompts with distinct idempotency keys,
    //    then a duplicate of the second to prove idempotency. The duplicate
    //    must return the same inputId without writing a new row.
    const prompts = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        const first = yield* firegrid.prompt({
          contextId: handle.contextId,
          payload: [{ type: "text", text: "follow-up-one" }],
          idempotencyKey: "tracer-021-follow-up-one",
        })
        const second = yield* firegrid.prompt({
          contextId: handle.contextId,
          payload: [{ type: "text", text: "follow-up-two" }],
          idempotencyKey: "tracer-021-follow-up-two",
        })
        const duplicateOfSecond = yield* firegrid.prompt({
          contextId: handle.contextId,
          // Different payload, same idempotency key — must collapse.
          payload: [{ type: "text", text: "follow-up-two-impostor" }],
          idempotencyKey: "tracer-021-follow-up-two",
        })
        return { first, second, duplicateOfSecond }
      }).pipe(Effect.provide(firegridClientLayer)),
    ))

    // firegrid-agent-ingress.INGRESS.3 — duplicate write collapses on inputId.
    expect(prompts.duplicateOfSecond.inputId).toEqual(prompts.second.inputId)
    expect(prompts.first.inputId).not.toEqual(prompts.second.inputId)
    // firegrid-agent-ingress.INGRESS.4 / .9 — explicit per-context sequence.
    expect(prompts.first.sequence).toBeTypeOf("number")
    expect(prompts.second.sequence).toBeTypeOf("number")
    expect(prompts.first.sequence!).toBeLessThan(prompts.second.sequence!)
    expect(prompts.first.status).toBe("sequenced")
    expect(prompts.second.status).toBe("sequenced")
    // firegrid-agent-ingress.INGRESS.1 — author class persisted on the row.
    expect(prompts.first.authoredBy).toBe("client")
    expect(prompts.second.authoredBy).toBe("client")

    // 5. The agent exits after the second input. Wait for the runtime to
    //    resolve, then assert child output.
    const result = await runtime
    expect(result).toMatchObject({
      contextId: handle.contextId,
      exitCode: 0,
    })

    const liveSnapshot = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.open(handle.contextId).snapshot
      }).pipe(Effect.provide(firegridClientLayer)),
    ))
    // Exactly two child markers, ordered by sequence — the duplicate
    // idempotency-keyed prompt produced no extra marker.
    expect(liveSnapshot.events.map(event => event.raw)).toEqual([
      "{\"type\":\"assistant\",\"text\":\"input:follow-up-one\"}",
      "{\"type\":\"assistant\",\"text\":\"input:follow-up-two\"}",
    ])

    // 6. Append one more prompt AFTER the child has exited. The durable
    //    write succeeds (no RuntimeContext.status state-machine yet). No
    //    delivery, no child marker — this is the documented gap.
    const postTerminalPrompt = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.prompt({
          contextId: handle.contextId,
          payload: [{ type: "text", text: "follow-up-post-terminal" }],
          idempotencyKey: "tracer-021-post-terminal",
        })
      }).pipe(Effect.provide(firegridClientLayer)),
    ))
    expect(postTerminalPrompt.status).toBe("sequenced")
    expect(postTerminalPrompt.sequence!).toBeGreaterThan(prompts.second.sequence!)

    // 7. Read RuntimeIngressTable.inputs + .deliveries directly to confirm
    //    durable evidence. Three input rows, two delivery rows, two events.
    const ingressState = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const ingress = yield* FiregridRuntimeTables.Ingress
        const inputs = yield* ingress.inputs.query((coll) =>
          coll.toArray
            .filter(row => row.contextId === handle.contextId)
            .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0)))
        const deliveries = yield* ingress.deliveries.query((coll) =>
          coll.toArray.filter(row => row.contextId === handle.contextId))
        return { inputs, deliveries }
      }).pipe(Effect.provide(firegridDurableTablesLayer)),
    ))

    // firegrid-agent-ingress.INGRESS.1/.2/.9 — three sequenced rows, distinct ids,
    // strictly increasing sequence, all client-authored, all kind=message.
    expect(ingressState.inputs).toHaveLength(3)
    const sequences = ingressState.inputs.map(row => row.sequence)
    expect(sequences).toEqual([sequences[0], sequences[0]! + 1, sequences[0]! + 2])
    expect(ingressState.inputs.every(row => row.status === "sequenced")).toBe(true)
    expect(ingressState.inputs.every(row => row.kind === "message")).toBe(true)
    expect(ingressState.inputs.every(row => row.authoredBy === "client")).toBe(true)
    expect(ingressState.inputs.every(row => typeof row.sequencedAt === "string")).toBe(true)
    const inputIds = new Set(ingressState.inputs.map(row => row.inputId))
    expect(inputIds.size).toBe(3)
    expect(inputIds.has(prompts.first.inputId)).toBe(true)
    expect(inputIds.has(prompts.second.inputId)).toBe(true)
    expect(inputIds.has(postTerminalPrompt.inputId)).toBe(true)

    // firegrid-agent-ingress.DELIVERY.3/.5 — two delivery claim rows, one
    // per delivered input, each tagged with the local-process stdin
    // subscriber and a non-empty claimedAt. The post-terminal input has
    // no delivery row — that's the gap.
    expect(ingressState.deliveries).toHaveLength(2)
    const deliveryInputIds = new Set(ingressState.deliveries.map(row => row.inputId))
    expect(deliveryInputIds.has(prompts.first.inputId)).toBe(true)
    expect(deliveryInputIds.has(prompts.second.inputId)).toBe(true)
    expect(deliveryInputIds.has(postTerminalPrompt.inputId)).toBe(false)
    expect(ingressState.deliveries.every(row => row.subscriberId === "runtime-context:local-process:stdin")).toBe(true)
    expect(ingressState.deliveries.every(row => typeof row.claimedAt === "string" && row.claimedAt.length > 0)).toBe(true)

    // 8. Final invariant: the durable event journal still shows exactly two
    //    child markers — the third prompt did not somehow resurrect the
    //    runtime or produce stale output.
    const finalSnapshot = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.open(handle.contextId).snapshot
      }).pipe(Effect.provide(firegridClientLayer)),
    ))
    expect(finalSnapshot.events).toHaveLength(2)
  })
})
