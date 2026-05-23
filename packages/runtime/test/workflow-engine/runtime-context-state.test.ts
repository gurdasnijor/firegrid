// tf-aseo: the durable loop-state cutover must keep permission request/response
// matching correct across a workflow replay/resume. Before the cutover the body
// rebuilt its in-memory `pendingPermission*` sets by re-walking the output
// history on every replay; now it reloads them from the workflow-owned durable
// state row. These tests prove the rendezvous still works in BOTH orders when
// the matching half arrives only after the state has been persisted and
// reloaded (the replay boundary), and that the nested ingress row survives the
// round trip.

import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Option, type Scope } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  makeHostStreamPrefix,
  RuntimeOutputTable,
  runtimeContextOutputStreamUrl,
  type HostId,
  type HostStreamPrefix,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { encodeRuntimeAgentOutputEnvelope } from "../../src/events/index.ts"
import {
  makeRuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import {
  initialRuntimeContextEventState,
  makePerContextRuntimeContextStateStore,
} from "../../src/tables/runtime-context-state.ts"
import {
  transitionInputEvent,
  transitionOutputEvent,
} from "../../src/workflow-engine/workflows/runtime-context.ts"
import type {
  AgentInputEvent,
  RuntimeAgentOutputObservation,
} from "../../src/events/index.ts"

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

const PERMISSION_ID = "perm-req-1"
const ATTEMPT = 0

const storeEffect = () => {
  if (baseUrl === undefined) throw new Error("server not started")
  const prefix: HostStreamPrefix = makeHostStreamPrefix({
    namespace: "tf-aseo-test",
    hostId: "tf-aseo-test_host" as HostId,
  })
  return makePerContextRuntimeContextStateStore({ durableStreamsBaseUrl: baseUrl }, prefix)
}

const contextFor = (contextId: string): RuntimeContext =>
  // The store only reads `contextId`; the rest of RuntimeContext is irrelevant
  // to load/save/nextOutput, so a narrowed literal is sufficient here.
  ({ contextId }) as unknown as RuntimeContext

const permissionResponse: AgentInputEvent = {
  _tag: "PermissionResponse",
  permissionRequestId: PERMISSION_ID,
  decision: { _tag: "Allow" },
}

const permissionRequestObservation = (
  contextId: string,
  sequence: number,
): RuntimeAgentOutputObservation =>
  ({
    contextId,
    activityAttempt: ATTEMPT,
    sequence,
    _tag: "PermissionRequest",
    event: { _tag: "PermissionRequest", permissionRequestId: PERMISSION_ID },
    permissionRequestId: PERMISSION_ID,
  }) as unknown as RuntimeAgentOutputObservation

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect))

describe("runtime-context durable loop state (tf-aseo)", () => {
  it("firegrid-workflow-driven-runtime.PHASE_0B_OUTPUT_RESULT_RETURN.3 reloads a pending permission REQUEST across replay and matches a later response", async () => {
    const contextId = `ctx_${crypto.randomUUID()}`
    const context = contextFor(contextId)

    await run(Effect.gen(function*() {
      const store = yield* storeEffect()
      // Request output processed in execution #1, then the durable state is saved.
      const afterRequest = transitionOutputEvent(
        context,
        initialRuntimeContextEventState,
        permissionRequestObservation(contextId, 3),
      )
      expect(afterRequest.action._tag).toBe("None")
      expect(afterRequest.state.pendingPermissionRequests).toEqual([PERMISSION_ID])
      yield* store.save(context, ATTEMPT, afterRequest.state)

      // Execution #2 (replay): state is reloaded with one point read, NOT
      // rebuilt by re-walking the output history.
      const reloaded = yield* store.load(context, ATTEMPT)
      expect(reloaded.pendingPermissionRequests).toEqual([PERMISSION_ID])
      expect(reloaded.lastProcessedOutputSequence).toBe(3)

      // The response input now matches the reloaded pending request → send.
      const row = makeRuntimeIngressInputRow({
        contextId,
        kind: "control",
        authoredBy: "client",
        payload: { permissionRequestId: PERMISSION_ID },
      })
      const afterResponse = transitionInputEvent(reloaded, row, permissionResponse)
      expect(afterResponse.action._tag).toBe("SendPermissionResponse")
      if (afterResponse.action._tag === "SendPermissionResponse") {
        expect(afterResponse.action.permissionRequestId).toBe(PERMISSION_ID)
      }
      expect(afterResponse.state.pendingPermissionRequests).toEqual([])
    }))
  })

  it("firegrid-workflow-driven-runtime.PHASE_0B_OUTPUT_RESULT_RETURN.3 reloads a pending permission RESPONSE (incl. its ingress row) across replay and matches a later request", async () => {
    const contextId = `ctx_${crypto.randomUUID()}`
    const context = contextFor(contextId)

    await run(Effect.gen(function*() {
      const store = yield* storeEffect()
      // Response input arrives BEFORE the request (response-first), so it is
      // stored pending — including its full ingress row, which must survive the
      // durable round trip.
      const row = makeRuntimeIngressInputRow({
        contextId,
        kind: "control",
        authoredBy: "client",
        payload: { permissionRequestId: PERMISSION_ID },
      })
      const afterResponse = transitionInputEvent(
        initialRuntimeContextEventState,
        row,
        permissionResponse,
      )
      expect(afterResponse.action._tag).toBe("None")
      expect(afterResponse.state.pendingPermissionResponses).toHaveLength(1)
      yield* store.save(context, ATTEMPT, afterResponse.state)

      // Replay: reload the pending response and assert the nested ingress row
      // round-tripped through the durable state schema unchanged.
      const reloaded = yield* store.load(context, ATTEMPT)
      expect(reloaded.pendingPermissionResponses).toHaveLength(1)
      const pending = reloaded.pendingPermissionResponses[0]!
      expect(pending.permissionRequestId).toBe(PERMISSION_ID)
      expect(pending.row).toEqual(row)

      // The matching request output now resolves the stored response → send.
      const afterRequest = transitionOutputEvent(
        context,
        reloaded,
        permissionRequestObservation(contextId, 5),
      )
      expect(afterRequest.action._tag).toBe("SendPermissionResponse")
      if (afterRequest.action._tag === "SendPermissionResponse") {
        expect(afterRequest.action.permissionRequestId).toBe(PERMISSION_ID)
        expect(afterRequest.action.row).toEqual(row)
      }
      expect(afterRequest.state.pendingPermissionResponses).toEqual([])
    }))
  })

  it("firegrid-workflow-driven-runtime.PHASE_0B_OUTPUT_RESULT_RETURN.2 nextOutput is a point read that returns none at the frontier", async () => {
    const contextId = `ctx_${crypto.randomUUID()}`
    const context = contextFor(contextId)

    await run(Effect.gen(function*() {
      const store = yield* storeEffect()
      // No output rows written yet: the cursor point-read at sequence 0 misses
      // and yields none, without scanning.
      const next = yield* store.nextOutput(context, ATTEMPT, -1)
      expect(Option.isNone(next)).toBe(true)
    }))
  })

  it("firegrid-workflow-driven-runtime.PHASE_0B_OUTPUT_RESULT_RETURN.2 nextOutput skips a shared-sequence log gap to the next observation", async () => {
    const contextId = `ctx_${crypto.randomUUID()}`
    const context = contextFor(contextId)
    const prefix: HostStreamPrefix = makeHostStreamPrefix({
      namespace: "tf-aseo-test",
      hostId: "tf-aseo-test_host" as HostId,
    })
    const outputUrl = runtimeContextOutputStreamUrl({
      baseUrl: baseUrl!,
      prefix,
      contextId,
    })

    await run(Effect.gen(function*() {
      const store = yield* storeEffect()
      // Shared sequence counter: seq 0 is a LOG row, seq 1 is the ToolUse EVENT.
      // The events collection is therefore sparse at seq 0; nextOutput(-1) must
      // skip the log gap and deliver the observation at seq 1 (not stop at 0).
      yield* Effect.gen(function*() {
        const table = yield* RuntimeOutputTable
        yield* table.logs.insert({
          logLineId: { contextId, activityAttempt: ATTEMPT, target: "logs", sequence: 0 },
          contextId,
          activityAttempt: ATTEMPT,
          sequence: 0,
          source: "stderr",
          format: "text-lines",
          receivedAt: "2026-05-22T00:00:00.000Z",
          raw: "startup log",
        })
        yield* table.events.insert({
          eventId: { contextId, activityAttempt: ATTEMPT, target: "events", sequence: 1 },
          contextId,
          activityAttempt: ATTEMPT,
          sequence: 1,
          source: "stdout",
          format: "jsonl",
          receivedAt: "2026-05-22T00:00:00.000Z",
          raw: encodeRuntimeAgentOutputEnvelope({ _tag: "Terminated", exitCode: 0 }),
        })
      }).pipe(
        Effect.provide(RuntimeOutputTable.layer({
          streamOptions: { url: outputUrl, contentType: "application/json" },
        })),
      )

      const next = yield* store.nextOutput(context, ATTEMPT, -1)
      expect(Option.isSome(next)).toBe(true)
      if (Option.isSome(next)) {
        expect(next.value.sequence).toBe(1)
        expect(next.value._tag).toBe("Terminated")
      }
    }))
  })
})
