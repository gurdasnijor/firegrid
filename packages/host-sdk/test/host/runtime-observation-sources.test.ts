import { Workflow } from "@effect/workflow"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
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
import { WaitFor, type WaitForOptions } from "@firegrid/runtime/durable-tools"
import {
  FiregridRuntimeHostWithWorkflowLive,
} from "../../src/host/index.ts"
import {
  DurableStreamsWorkflowEngine,
} from "@firegrid/runtime/workflow-engine"
import {
  HostRuntimeObservationSubstrateLive,
} from "../../src/host/runtime-substrate.ts"

// Typed runtime wait sources. firegrid-typed-wait-source-redesign.TYPED_SOURCES.6
const AGENT_OUTPUT_SOURCE = { _tag: "AgentOutput" } as const
const RUNTIME_RUN_SOURCE = { _tag: "RuntimeRun" } as const

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

const waitForOrDie = <A>(options: WaitForOptions<A>) =>
  WaitFor.match<A>(options).pipe(Effect.orDie)

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

const PermissionObservationSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  _tag: Schema.Literal("PermissionRequest"),
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
  event: Schema.Unknown,
})

const RuntimeExitedRowSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  provider: Schema.String,
  status: Schema.Literal("exited"),
  at: Schema.String,
  exitCode: Schema.Number,
  runEventId: Schema.Unknown,
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

    const Wf = Workflow.make({
      name: "runtime-observation-permission",
      payload: Schema.Struct({
        id: Schema.String,
        contextId: Schema.String,
        permissionRequestId: Schema.String,
      }),
      success: PermissionObservationSchema,
      idempotencyKey: p => p.id,
    })

    const workflowLayer = Wf.toLayer(payload =>
      Effect.gen(function* () {
        const outcome = yield* waitForOrDie({
          name: "permission-request",
          source: AGENT_OUTPUT_SOURCE,
          trigger: [
            { path: ["contextId"], equals: payload.contextId },
            { path: ["_tag"], equals: "PermissionRequest" },
            { path: ["permissionRequestId"], equals: payload.permissionRequestId },
          ],
          resultSchema: PermissionObservationSchema,
        })
        if (outcome._tag !== "Match") throw new Error("expected Match")
        return outcome.row
      }))

    const layer = workflowLayer.pipe(
      Layer.provideMerge(HostRuntimeObservationSubstrateLive),
      Layer.provideMerge(workflowEngineLayer({ namespace, contextId })),
      Layer.provideMerge(hostLayer({ namespace, hostId })),
    ) as Layer.Layer<never, unknown, never>

    const result = await runWith(
      layer,
      Effect.gen(function* () {
        const session = yield* CurrentHostSession
        const fiber = yield* Effect.fork(Wf.execute({
          id: "permission-wait",
          contextId,
          permissionRequestId: "permission-1",
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
        return yield* Fiber.join(fiber)
      }),
    )

    expect(result).toMatchObject({
      contextId,
      _tag: "PermissionRequest",
      permissionRequestId: "permission-1",
      toolUseId: "tool-permission",
    })
  })

  it("firegrid-factory-aligned-agent-tools.OBSERVATION.3 observes terminal RuntimeControlPlane run status", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `runtime-observation-run-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const contextId = `ctx_${crypto.randomUUID()}`

    const Wf = Workflow.make({
      name: "runtime-observation-terminal-run",
      payload: Schema.Struct({ id: Schema.String, contextId: Schema.String }),
      success: RuntimeExitedRowSchema,
      idempotencyKey: p => p.id,
    })

    const workflowLayer = Wf.toLayer(payload =>
      Effect.gen(function* () {
        const outcome = yield* waitForOrDie({
          name: "runtime-exited",
          source: RUNTIME_RUN_SOURCE,
          trigger: [
            { path: ["contextId"], equals: payload.contextId },
            { path: ["status"], equals: "exited" },
          ],
          resultSchema: RuntimeExitedRowSchema,
        })
        if (outcome._tag !== "Match") throw new Error("expected Match")
        return outcome.row
      }))

    const layer = workflowLayer.pipe(
      Layer.provideMerge(HostRuntimeObservationSubstrateLive),
      Layer.provideMerge(workflowEngineLayer({ namespace, contextId })),
      Layer.provideMerge(hostLayer({ namespace, hostId })),
    ) as Layer.Layer<never, unknown, never>

    const result = await runWith(
      layer,
      Effect.gen(function* () {
        const controlPlane = yield* RuntimeControlPlaneTable
        const fiber = yield* Effect.fork(Wf.execute({
          id: "runtime-exited-wait",
          contextId,
        }))
        yield* Effect.sleep("50 millis")
        yield* controlPlane.runs.upsert({
          runEventId: {
            contextId,
            activityAttempt: 1,
            status: "exited",
          },
          contextId,
          activityAttempt: 1,
          provider: "local-process",
          status: "exited",
          at: new Date().toISOString(),
          exitCode: 0,
        })
        return yield* Fiber.join(fiber)
      }),
    )

    expect(result).toMatchObject({
      contextId,
      status: "exited",
      activityAttempt: 1,
      exitCode: 0,
    })
  })
})
