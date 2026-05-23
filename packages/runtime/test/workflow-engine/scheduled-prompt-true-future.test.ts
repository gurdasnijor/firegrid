import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeControlPlaneTable,
  runtimeControlPlaneStreamUrl,
  type RuntimeControlPlaneTableService,
} from "@firegrid/protocol/launch"
import { Clock, Data, Duration, Effect, Fiber, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
  type WorkflowEngineTableService,
} from "../../src/engine/durable-streams-workflow-engine.ts"
import {
  ScheduledPromptWorkflow,
  ScheduledPromptWorkflowLayer,
} from "../../src/workflow-engine/workflows/scheduled-prompt.ts"

// tf-sto7: true-future durable validation for `schedule_me`.
//
// PR #637 (tf-5ose) shipped the non-blocking durable ScheduledPromptWorkflow but
// its own note flagged the missing gate: a deterministic test that schedules a
// **host-computed future** `when` (not an agent-estimated wall clock that can
// land in the past) and proves the self-prompt is (1) NOT delivered before the
// deadline and (2) delivered EXACTLY ONCE after it, surviving an engine
// reconstruction (replay/restart).
//
// We drive the production workflow against a real Durable Streams server. The
// scheduled prompt is appended through RuntimeControlPlaneTable.inputIntents
// (idempotent on the intent key derived from `scheduleId`), so the count of
// intent rows on a fresh stream is the exact delivery count.

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

// Engine + the production ScheduledPromptWorkflow (with its control-plane
// dependency satisfied). Rebuilding this layer over the same stream URLs
// simulates a host restart: durable state lives on the server, not the layer.
const runWith = <A, E>(
  streamUrl: string,
  controlUrl: string,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> => {
  const controlLayer = RuntimeControlPlaneTable.layer({
    streamOptions: { url: controlUrl, contentType: "application/json" },
  })
  const workflowLayer = ScheduledPromptWorkflowLayer.pipe(Layer.provide(controlLayer))
  const engineLayer = DurableStreamsWorkflowEngine.layer({ streamUrl }) as Layer.Layer<
    never,
    unknown,
    unknown
  >
  return Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          (workflowLayer as Layer.Layer<never, unknown, unknown>).pipe(
            Layer.provideMerge(engineLayer),
          ),
        ),
      ) as Effect.Effect<A, unknown, never>,
    ),
  )
}

const inspectControl = async <A>(
  controlUrl: string,
  inspect: (table: RuntimeControlPlaneTableService) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const table = yield* RuntimeControlPlaneTable
        return yield* inspect(table)
      }).pipe(
        Effect.provide(
          RuntimeControlPlaneTable.layer({
            streamOptions: { url: controlUrl, contentType: "application/json" },
          }),
        ),
      ),
    ),
  )

const inspectEngine = async <A>(
  streamUrl: string,
  inspect: (table: WorkflowEngineTableService) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const table = yield* WorkflowEngineTable
        return yield* inspect(table)
      }).pipe(
        Effect.provide(
          WorkflowEngineTable.layer({
            streamOptions: { url: streamUrl, contentType: "application/json" },
          }),
        ),
      ),
    ),
  )

const SCHEDULE_WORKFLOW_NAME = "firegrid.agent_tools.schedule_me"

class ClockWakeupTimeout extends Data.TaggedError("ClockWakeupTimeout")<{
  readonly clockName: string
}> {}

const waitForClockWakeupRow = (clockName: string) =>
  Effect.gen(function* () {
    const table = yield* WorkflowEngineTable
    const deadlineMs = (yield* Clock.currentTimeMillis) + 5_000
    while (true) {
      const rows = yield* table.clockWakeups.query(coll =>
        coll.toArray.filter(
          row =>
            row.workflowName === SCHEDULE_WORKFLOW_NAME && row.clockName === clockName,
        ),
      )
      if (rows.length > 0) return
      if ((yield* Clock.currentTimeMillis) >= deadlineMs) {
        return yield* new ClockWakeupTimeout({ clockName })
      }
      yield* Effect.sleep(Duration.millis(25))
    }
  })

const countIntents = (controlUrl: string): Promise<number> =>
  inspectControl(controlUrl, table =>
    table.inputIntents.query(coll => coll.toArray).pipe(Effect.map(rows => rows.length)),
  )

describe("schedule_me true-future durable delivery (tf-sto7)", () => {
  it(
    "arms a HOST-computed future deadline, does not fire early, and delivers exactly once after it — across an engine restart",
    async () => {
      if (!baseUrl) throw new Error("server not started")
      const namespace = `sched-true-future-${crypto.randomUUID()}`
      const streamUrl = `${baseUrl}/v1/stream/sched-engine-${crypto.randomUUID()}`
      const controlUrl = runtimeControlPlaneStreamUrl({ baseUrl, namespace })

      const scheduleId = `sched-${crypto.randomUUID()}`
      const contextId = `ctx-${crypto.randomUUID()}`
      const clockName = `scheduled-prompt:${scheduleId}`

      // The whole point of tf-sto7: the deadline is computed from the HOST clock,
      // not an agent-estimated wall clock. 1.2s ahead — comfortably future, fast.
      const DELAY_MS = 1_200
      const whenAtSchedule = Date.now() + DELAY_MS
      const prompt = "scheduled self-prompt"

      // --- Phase A: arm fire-and-forget; assert non-blocking + future + not-early.
      const armStart = Date.now()
      const armed = await runWith(
        streamUrl,
        controlUrl,
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            ScheduledPromptWorkflow.execute(
              { contextId, scheduleId, when: whenAtSchedule, prompt },
              { discard: true },
            ),
          )
          // The durable timer is persisted before we observe the wakeup row.
          yield* waitForClockWakeupRow(clockName)
          const nowAtArm = yield* Clock.currentTimeMillis
          // Stop driving; the persisted wakeup must survive without this fiber.
          yield* Fiber.interrupt(fiber)
          return { nowAtArm }
        }),
      )
      const armElapsed = Date.now() - armStart

      // (1) the future deadline really is in the future at scheduling time.
      expect(whenAtSchedule).toBeGreaterThan(armStart)
      expect(armed.nowAtArm).toBeLessThan(whenAtSchedule)
      // (2) non-blocking: arming returned well before the deadline would elapse.
      expect(armElapsed).toBeLessThan(DELAY_MS)
      // (3) the durable timer is pending (armed, not yet fired).
      const pendingWakeups = await inspectEngine(streamUrl, table =>
        table.clockWakeups.query(coll =>
          coll.toArray.filter(
            row =>
              row.workflowName === SCHEDULE_WORKFLOW_NAME &&
              row.clockName === clockName &&
              row.status === "pending",
          ),
        ),
      )
      expect(pendingWakeups).toHaveLength(1)
      // (4) NOT delivered early: no input intent before the deadline.
      expect(await countIntents(controlUrl)).toBe(0)

      // --- Phase B: let the host clock pass the deadline, then resume the engine.
      await Effect.runPromise(Effect.sleep(Duration.millis(DELAY_MS + 400)))
      expect(Date.now()).toBeGreaterThan(whenAtSchedule)

      // Re-execute (fresh engine = restart). Same idempotencyKey resumes the same
      // execution; the deadline has passed, so the body fires and completes.
      await runWith(
        streamUrl,
        controlUrl,
        ScheduledPromptWorkflow.execute({ contextId, scheduleId, when: whenAtSchedule, prompt }),
      )

      // Delivered exactly once after the due time.
      const afterFire = await inspectControl(controlUrl, table =>
        table.inputIntents.query(coll => coll.toArray),
      )
      expect(afterFire).toHaveLength(1)
      expect(afterFire[0]?.contextId).toBe(contextId)

      // --- Phase C: replay/restart again — must NOT duplicate or lose the prompt.
      await runWith(
        streamUrl,
        controlUrl,
        ScheduledPromptWorkflow.execute({ contextId, scheduleId, when: whenAtSchedule, prompt }),
      )
      expect(await countIntents(controlUrl)).toBe(1)
    },
    20_000,
  )
})
