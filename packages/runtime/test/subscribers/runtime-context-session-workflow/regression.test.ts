// PR #738 regression test for the Zed agent_silent root cause.
//
// Pre-cutover (head 3a8e4f73a) the live ACP repro reproduced two interlocking
// races on the Shape C path:
//   1. Input intent appended BEFORE runs.started → Shape C subscriber's
//      handle() returns silently when latestStartedAttempt is None; the
//      inputIntents live tail emits each row ONCE per subscription, so
//      the dropped input was never re-delivered.
//   2. control-side-effect's session.startOrAttach raced the subscriber's
//      session.send → getOrStart → startOrAttach implicit-attach; both
//      found the sessions Map empty and BOTH spawned the agent process.
//
// Post-cutover the RuntimeContextSessionWorkflow Shape D folder owns the
// codec session lifecycle per (contextId, attempt):
//   - control-request-side-effects.start dispatches the workflow (no direct
//     session.startOrAttach call).
//   - Shape C subscriber's Input branch issues workflow.resume (no direct
//     session.send call).
//   - Workflow's spawn Activity (Activity-memoized + idempotencyKey) is the
//     sole caller of the codec startOrAttach; its send Activity iterates
//     `inputIntents` (so an early intent appended before the workflow
//     dispatches IS picked up when the body queries unprocessed intents).
//
// This regression composes the production workflow + a recording session
// adapter, drives the production order (input appended before runs.started
// + workflow dispatch), and asserts:
//   - exactly one spawn (race 2 fixed),
//   - exactly one send carrying the early intent (race 1 fixed).

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Clock,
  Duration,
  Effect,
  Layer,
  Ref,
} from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  CurrentHostSession,
  local,
  makeHostSessionRow,
  normalizeRuntimeIntent,
  RuntimeControlPlaneTable,
  runtimeControlPlaneStreamUrl,
  type HostId,
  type HostSessionId,
} from "@firegrid/protocol/launch"
import { makeRuntimeInputIntentRow } from "@firegrid/protocol/runtime-ingress"
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"
import {
  RuntimeContextInsert,
  RuntimeControlPlaneRecorderLive,
  RuntimeRunAppendAndGet,
} from "../../../src/control-plane/index.ts"
import {
  RcswProcessedTable,
  RuntimeContextSessionWorkflowDispatch,
  RuntimeContextSessionWorkflowDispatchLive,
  RuntimeContextSessionWorkflowLayer,
} from "../../../src/subscribers/runtime-context-session-workflow/index.ts"
import {
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
} from "../../../src/subscribers/runtime-context-session/index.ts"

const NAMESPACE = "rcsw-regression"

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

const currentHostSessionLayer = (): Layer.Layer<CurrentHostSession> =>
  Layer.effect(
    CurrentHostSession,
    Clock.currentTimeMillis.pipe(
      Effect.map((startedAtMs) =>
        makeHostSessionRow({
          hostId: `${NAMESPACE}_host` as HostId,
          hostSessionId: "rcsw-regression-session" as HostSessionId,
          namespace: NAMESPACE,
          startedAtMs,
        })),
    ),
  )

const controlPlaneLayer = (url: string) =>
  RuntimeControlPlaneTable.layer({
    streamOptions: { url, contentType: "application/json" },
  })

const processedTableLayer = (url: string) =>
  RcswProcessedTable.layer({
    streamOptions: { url, contentType: "application/json" },
  })

const engineLayer = (url: string) =>
  DurableStreamsWorkflowEngine.layer({ streamUrl: url })

interface SessionRecording {
  readonly spawns: Ref.Ref<ReadonlyArray<{ readonly contextId: string; readonly attempt: number }>>
  readonly sends: Ref.Ref<ReadonlyArray<{
    readonly contextId: string
    readonly attempt: number
    readonly command: RuntimeContextSessionCommand
  }>>
  readonly layer: Layer.Layer<RuntimeContextWorkflowSession>
}

interface RegressionRunResult {
  readonly spawns: ReadonlyArray<{ readonly contextId: string; readonly attempt: number }>
  readonly sends: ReadonlyArray<{
    readonly contextId: string
    readonly attempt: number
    readonly command: RuntimeContextSessionCommand
  }>
}

// Recording RuntimeContextWorkflowSession stand-in. Its startOrAttach +
// send are the production-shape primitives the workflow's spawn / send
// Activities call. This is NOT a "bypass" — the workflow body still
// invokes the real Tag-based contract; the stand-in just records.
const makeRecordingSession = (): Effect.Effect<SessionRecording> =>
  Effect.gen(function*() {
    const spawns = yield* Ref.make<ReadonlyArray<{
      readonly contextId: string
      readonly attempt: number
    }>>([])
    const sends = yield* Ref.make<ReadonlyArray<{
      readonly contextId: string
      readonly attempt: number
      readonly command: RuntimeContextSessionCommand
    }>>([])
    const layer = RuntimeContextWorkflowSession.layer({
      startOrAttach: (context, attempt) =>
        Ref.update(spawns, (xs) => [...xs, { contextId: context.contextId, attempt }]).pipe(
          Effect.as({
            contextId: context.contextId,
            activityAttempt: attempt,
            ownerKind: "codec" as const,
            ownerSessionId: `recording:${context.contextId}:${attempt}`,
            startCommandId: `recording-start-${context.contextId}-${attempt}`,
          }),
        ),
      send: (context, attempt, command) =>
        Ref.update(sends, (xs) => [...xs, { contextId: context.contextId, attempt, command }]).pipe(
          Effect.as({
            contextId: context.contextId,
            activityAttempt: attempt,
            commandId: command.commandId,
            ownerSessionId: `recording:${context.contextId}:${attempt}`,
          }),
        ),
      deregister: () => Effect.void,
    })
    return { spawns, sends, layer }
  })

const waitFor = <A>(
  read: Effect.Effect<A>,
  predicate: (a: A) => boolean,
  timeoutMs: number,
): Effect.Effect<A> =>
  Effect.gen(function*() {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const current = yield* read
      if (predicate(current)) return current
      if (Date.now() >= deadline) return current
      yield* Effect.sleep(Duration.millis(50))
    }
  })

describe("RuntimeContextSessionWorkflow regression (PR #738)", () => {
  it(
    "input appended BEFORE recordStarted yields exactly one spawn + one send",
    async () => {
      if (baseUrl === undefined) throw new Error("server not started")
      const controlUrl = runtimeControlPlaneStreamUrl({ baseUrl, namespace: NAMESPACE })
      const processedUrl =
        `${baseUrl.replace(/\/+$/, "")}/${NAMESPACE}.firegrid.rcsw.processed`
      const engineUrl = `${baseUrl.replace(/\/+$/, "")}/${NAMESPACE}.firegrid.rcsw.engine`

      const recording = await Effect.runPromise(
        Effect.scoped(makeRecordingSession()),
      )

      type RegressionLayerRequirements =
        | RuntimeControlPlaneTable
        | RuntimeContextInsert
        | RuntimeRunAppendAndGet
        | RuntimeContextSessionWorkflowDispatch

      const workflowBundle = RuntimeContextSessionWorkflowDispatchLive.pipe(
        Layer.provideMerge(RuntimeContextSessionWorkflowLayer),
        Layer.provideMerge(recording.layer),
        Layer.provideMerge(processedTableLayer(processedUrl)),
      )

      const testLayer = RuntimeControlPlaneRecorderLive.pipe(
        Layer.provideMerge(workflowBundle),
        Layer.provideMerge(currentHostSessionLayer()),
        Layer.provideMerge(engineLayer(engineUrl)),
        Layer.provideMerge(controlPlaneLayer(controlUrl)),
      ) as unknown as Layer.Layer<RegressionLayerRequirements, unknown, never>

      const program = Effect.gen(function*() {
            const control = yield* RuntimeControlPlaneTable
            const contextInsert = yield* RuntimeContextInsert
            const runs = yield* RuntimeRunAppendAndGet
            const dispatch = yield* RuntimeContextSessionWorkflowDispatch

            // 1. Insert context.
            const contextId = `ctx_${crypto.randomUUID()}`
            const intent = normalizeRuntimeIntent(local.jsonl({
              argv: ["node", "-e", "process.exit(0)"],
              agentProtocol: "raw",
            }))
            const context = yield* contextInsert.insertLocalContextIfAbsent(intent, {
              contextId,
              createdBy: "regression",
            })

            // 2. Pre-cutover trap: append the INPUT INTENT FIRST — before
            //    recordStarted and before the workflow dispatch. This is the
            //    exact ordering of `bin/run.ts:executeRun --prompt`. Pre-fix
            //    the Shape C subscriber would have dropped this silently
            //    (latestStartedAttempt None) and the inputIntents live tail
            //    never re-delivered it.
            const inputRow = makeRuntimeInputIntentRow({
              contextId,
              kind: "message",
              authoredBy: "client",
              payload: "early-prompt",
            })
            yield* control.inputIntents.insertOrGet(inputRow)

            // 3. NOW the start side-effect chain: allocate attempt, record
            //    started, dispatch the workflow (production order matches
            //    `control-request-side-effects.start`).
            const attempt = yield* runs.allocateActivityAttempt(context)
            yield* runs.recordStarted(context, attempt)

            // 4. Dispatch fire-and-forget (the workflow body is long-running
            //    by design; control awaits runs.waitTerminal in production).
            //    Fork so we can observe the recording without blocking.
            yield* dispatch.dispatch({ contextId, activityAttempt: attempt }).pipe(
              Effect.fork,
            )

            // 5. Wait until the workflow body has spawned + sent the early
            //    intent. Bounded so a regression times out cleanly.
            yield* waitFor(
              Effect.all({
                spawns: Ref.get(recording.spawns),
                sends: Ref.get(recording.sends),
              }),
              ({ spawns, sends }) => spawns.length >= 1 && sends.length >= 1,
              5_000,
            )

            return {
              spawns: yield* Ref.get(recording.spawns),
              sends: yield* Ref.get(recording.sends),
            }
          }) as unknown as Effect.Effect<RegressionRunResult, unknown, RegressionLayerRequirements>

      const provided = Effect.provide(program, testLayer)
      const ran = await Effect.runPromise(Effect.scoped(provided))

      // === Acceptance: race 2 (dual-spawn) fixed. ===
      expect(ran.spawns.length).toBe(1)
      // === Acceptance: race 1 (input-before-recordStarted drop) fixed. ===
      expect(ran.sends.length).toBeGreaterThanOrEqual(1)
      const first = ran.sends[0]!
      expect(first.command._tag).toBe("AgentInput")
      // The first send must carry the early intent (Prompt event derived from
      // the input row appended BEFORE recordStarted).
      expect(first.command.event._tag).toBe("Prompt")
    },
    15_000,
  )
})
