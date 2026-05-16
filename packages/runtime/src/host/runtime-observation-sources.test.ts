import { Workflow } from "@effect/workflow"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  type HostId,
} from "@firegrid/protocol/launch"
import { Effect, Fiber, Layer, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  encodeRuntimeAgentOutputEnvelope,
  type AgentOutputEvent,
} from "../events/index.ts"
import { WaitFor, type WaitForOptions } from "../waits/index.ts"
import {
  FiregridRuntimeHostWithWorkflowLive,
  RuntimeObservationSourceNames,
} from "./index.ts"

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

describe("runtime-host wait_for observation sources", () => {
  it("firegrid-factory-aligned-agent-tools.WAIT_FOR.4, WAIT_FOR.5 observes RuntimeOutput PermissionRequest by contextId and permissionRequestId", async () => {
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
          source: RuntimeObservationSourceNames.agentOutputEvents,
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
      Layer.provideMerge(hostLayer({ namespace, hostId })),
    ) as Layer.Layer<never, unknown, never>

    const result = await runWith(
      layer,
      Effect.gen(function* () {
        const output = yield* RuntimeOutputTable
        const fiber = yield* Effect.fork(Wf.execute({
          id: "permission-wait",
          contextId,
          permissionRequestId: "permission-1",
        }))
        yield* Effect.sleep("50 millis")
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
          source: RuntimeObservationSourceNames.runtimeRuns,
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
