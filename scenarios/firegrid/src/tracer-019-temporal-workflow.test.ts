import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  local,
} from "@firegrid/client"
import {
  FiregridRuntimeHostWithWorkflowLive,
  fireDueWorkflowClocks,
  startRuntime,
} from "@firegrid/runtime"
import {
  RuntimeScheduledInputLive,
  RuntimeScheduledInputTable,
  scheduleRuntimeInput,
  type ScheduledRuntimeInputRow,
} from "@firegrid/runtime/runtime-scheduled-input"
import { Effect, Layer, Option, Stream } from "effect"
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
  throw new Error("timed out waiting for temporal workflow scenario state")
}

const awaitScheduleFired = (
  scheduleId: string,
): Effect.Effect<ScheduledRuntimeInputRow, unknown, RuntimeScheduledInputTable> =>
  Effect.gen(function* () {
    const table = yield* RuntimeScheduledInputTable
    return yield* table.scheduledInputs.subscribe<ScheduledRuntimeInputRow>((coll, emit) => {
      const emitFired = () => {
        const row = coll.toArray.find(candidate =>
          candidate.scheduleId === scheduleId &&
          candidate.status === "fired")
        if (row !== undefined) emit(row)
      }
      const sub = coll.subscribeChanges(
        () => emitFired(),
        { includeInitialState: true },
      )
      return () => sub.unsubscribe()
    }).pipe(
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )
  })

const scheduledInputAgent = `
let buffered = ""
const keepAlive = setInterval(() => {}, 1000)
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  buffered += chunk
  while (buffered.includes("\\n")) {
    const index = buffered.indexOf("\\n")
    const line = buffered.slice(0, index).trim()
    buffered = buffered.slice(index + 1)
    if (line.length === 0) continue
    console.log(JSON.stringify({ type: "assistant", text: "scheduled:" + line }))
    clearInterval(keepAlive)
    setTimeout(() => process.exit(0), 10)
  }
})
`

describe("firegrid tracer 019 temporal workflow", () => {
  it("firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.1 firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.2 firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.3 firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.4 firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.5 firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.6 firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.7 firegrid-workflow-driven-runtime.VALIDATION.3 appends scheduled runtime input after workflow clock reconstruction", async () => {
    if (!baseUrl) throw new Error("scenario test server not started")
    const firegridConfig = {
      durableStreamsBaseUrl: baseUrl,
      namespace: `tracer-019-temporal-${crypto.randomUUID()}`,
    }
    const firegridConfigLayer = Layer.succeed(FiregridConfig, firegridConfig)
    const firegridClientLayer = FiregridLive.pipe(
      Layer.provide(firegridConfigLayer),
    )
    const runtimeHostLayer = FiregridRuntimeHostWithWorkflowLive({
      ...firegridConfig,
      input: true,
    })
    const runtimeScheduledInputLayer = RuntimeScheduledInputLive(firegridConfig)

    const handle = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.launch({
          runtime: local.jsonl({
            argv: [process.execPath, "--input-type=module", "-e", scheduledInputAgent],
          }),
        })
      }).pipe(
        Effect.provide(firegridClientLayer),
      ),
    ))
    const runtime = Effect.runPromise(
      startRuntime({ contextId: handle.contextId }).pipe(
        Effect.provide(runtimeHostLayer),
      ),
    )

    await waitFor(async () => {
      const snapshot = await Effect.runPromise(Effect.scoped(
        Effect.gen(function* () {
          const firegrid = yield* Firegrid
          return yield* firegrid.open(handle.contextId).snapshot
        }).pipe(
          Effect.provide(firegridClientLayer),
        ),
      ))
      return snapshot.status === "started"
    })

    const scheduleId = `schedule-${crypto.randomUUID()}`
    const dueAtMs = Date.now() + 60_000
    const scheduled = await Effect.runPromise(
      scheduleRuntimeInput({
        scheduleId,
        contextId: handle.contextId,
        dueAtMs,
        payload: [{ type: "text", text: "wake up later" }],
        metadata: { source: "tracer-019" },
      }).pipe(
        Effect.provide(runtimeScheduledInputLayer),
      ),
    )
    const duplicate = await Effect.runPromise(
      scheduleRuntimeInput({
        scheduleId,
        contextId: handle.contextId,
        dueAtMs,
        payload: [{ type: "text", text: "duplicate should not win" }],
      }).pipe(
        Effect.provide(runtimeScheduledInputLayer),
      ),
    )

    expect(duplicate.schedule.inputId).toBe(scheduled.schedule.inputId)
    expect(duplicate.schedule.payload).toEqual(scheduled.schedule.payload)
    const pending = Option.getOrThrow(await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const table = yield* RuntimeScheduledInputTable
        return yield* table.scheduledInputs.get(scheduleId)
      }).pipe(
        Effect.provide(runtimeScheduledInputLayer),
      ),
    )))
    expect(pending).toMatchObject({
      scheduleId,
      contextId: handle.contextId,
      status: "pending",
      inputId: scheduled.schedule.inputId,
    })
    expect(pending.firedInputId).toBeUndefined()

    const fired = await Effect.runPromise(
      Effect.gen(function* () {
        yield* fireDueWorkflowClocks(dueAtMs + 10_000)
        return yield* awaitScheduleFired(scheduleId)
      }).pipe(
        Effect.provide(runtimeScheduledInputLayer),
      ),
    )

    const result = await runtime
    expect(result).toMatchObject({
      contextId: handle.contextId,
      exitCode: 0,
    })

    expect(fired).toMatchObject({
      scheduleId,
      status: "fired",
      firedInputId: scheduled.schedule.inputId,
    })

    const snapshot = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.open(handle.contextId).snapshot
      }).pipe(
        Effect.provide(firegridClientLayer),
      ),
    ))
    expect(snapshot.events.map(event => event.raw)).toEqual([
      "{\"type\":\"assistant\",\"text\":\"scheduled:wake up later\"}",
    ])
  }, 20_000)
})
