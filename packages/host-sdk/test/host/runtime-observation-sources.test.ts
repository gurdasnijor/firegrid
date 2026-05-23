import { DurableStreamTestServer } from "@durable-streams/server"
import {
  CurrentHostSession,
  RuntimeOutputTable,
  runtimeContextOutputStreamUrl,
  runtimeContextWorkflowStreamUrl,
  type HostId,
} from "@firegrid/protocol/launch"
import { Effect, Fiber, Layer, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  encodeRuntimeAgentOutputEnvelope,
  type AgentOutputEvent,
} from "@firegrid/runtime/events"
import {
  WaitForWorkflow,
  WaitForWorkflowLayer,
} from "@firegrid/runtime/workflows"
import {
  FiregridRuntimeHostWithWorkflowLive,
} from "../../src/host/index.ts"
import {
  DurableStreamsWorkflowEngine,
} from "@firegrid/runtime/workflow-engine"
import {
  HostRuntimeObservationStreamsLive,
} from "../../src/host/runtime-substrate.ts"

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

const runWith = <A, E>(
  layer: Layer.Layer<never, unknown, never>,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(Effect.provide(layer)),
    ) as Effect.Effect<A, unknown, never>,
  )

const hostLayer = (input: {
  readonly namespace: string
  readonly hostId: HostId
}) =>
  FiregridRuntimeHostWithWorkflowLive({
    durableStreamsBaseUrl: baseUrl!,
    namespace: input.namespace,
    hostId: input.hostId,
    input: true,
  })

const workflowEngineLayer = (input: {
  readonly namespace: string
  readonly contextId: string
}) =>
  DurableStreamsWorkflowEngine.layer({
    streamUrl: runtimeContextWorkflowStreamUrl({
      baseUrl: baseUrl!,
      namespace: input.namespace,
      contextId: input.contextId,
    }),
  })

const agentOutputRaw = (event: AgentOutputEvent): string =>
  encodeRuntimeAgentOutputEnvelope(event)

const PermissionObservationSchema = Schema.TaggedStruct("PermissionRequest", {
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
  event: Schema.Unknown,
})

describe("runtime-host wait_for source registrations", () => {
  // firegrid-typed-wait-source-redesign.WAIT_ROUTER.1
  //
  // A4 regression. The PermissionRequest row is written through the
  // production per-context output stream (the stream
  // `PerContextRuntimeOutputWriter` writes:
  // `{prefix}.runtimeOutput.context.{contextId}`), NOT the ambient
  // host-prefixed `RuntimeOutputTable`. Before the per-context
  // `AgentOutput` routing fix this wait observed the unwritten
  // host-prefixed stream and hung until timeout. See
  // docs/research/host-vs-context-boundary-audit.md §A4.
  it("firegrid-factory-aligned-agent-tools.WAIT_FOR.4, WAIT_FOR.5 observes per-context RuntimeOutput PermissionRequest by contextId and permissionRequestId", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `runtime-observation-permission-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const contextId = `ctx_${crypto.randomUUID()}`

    const layer = WaitForWorkflowLayer.pipe(
      Layer.provideMerge(HostRuntimeObservationStreamsLive),
      Layer.provideMerge(workflowEngineLayer({ namespace, contextId })),
      Layer.provideMerge(hostLayer({ namespace, hostId })),
    ) as Layer.Layer<never, unknown, never>

    const result = await runWith(
      layer,
      Effect.gen(function* () {
        const session = yield* CurrentHostSession
        const fiber = yield* Effect.fork(WaitForWorkflow.execute({
          executionKey: `runtime-observation-permission:${contextId}`,
          source: {
            _tag: "AgentOutputAfter",
            contextId,
            activityAttempt: 1,
            afterSequence: -1,
          },
          trigger: [
            { path: ["contextId"], equals: contextId },
            { path: ["_tag"], equals: "PermissionRequest" },
            { path: ["permissionRequestId"], equals: "permission-1" },
          ],
        }))
        yield* Effect.sleep("50 millis")
        // Production write path: the per-context output stream the real
        // PerContextRuntimeOutputWriter targets, not the ambient
        // host-prefixed RuntimeOutputTable.
        yield* Effect.gen(function* () {
          const output = yield* RuntimeOutputTable
          yield* output.events.upsert({
            eventId: {
              contextId,
              activityAttempt: 1,
              target: "events",
              sequence: 0,
            },
            contextId,
            activityAttempt: 1,
            sequence: 0,
            source: "stdout",
            format: "jsonl",
            receivedAt: new Date().toISOString(),
            raw: agentOutputRaw({
              _tag: "PermissionRequest",
              permissionRequestId: "permission-1",
              toolUseId: "tool-permission",
              options: [
                { optionId: "allow", kind: "allow_once", name: "Allow once" },
              ],
            }),
          })
        }).pipe(
          Effect.provide(RuntimeOutputTable.layer({
            streamOptions: {
              url: runtimeContextOutputStreamUrl({
                baseUrl: baseUrl!,
                prefix: session.streamPrefix,
                contextId,
              }),
              contentType: "application/json",
            },
          })),
          Effect.scoped,
        )
        const outcome = yield* Fiber.join(fiber)
        if (outcome._tag !== "Match") throw new Error("expected Match")
        return yield* Schema.decodeUnknown(PermissionObservationSchema)(outcome.raw)
      }),
    )

    expect(result).toMatchObject({
      contextId,
      _tag: "PermissionRequest",
      permissionRequestId: "permission-1",
      toolUseId: "tool-permission",
    })
  })

  // The legacy "observes terminal RuntimeControlPlane run status" case
  // moved to `start-runtime.test.ts` (#708): the public `startRuntime`
  // waits on `SessionLifecycleChannel.forSession(contextId)` filtered to
  // `RuntimeRunEvent` status `exited` | `failed`.
})
