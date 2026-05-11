import { FetchHttpClient } from "@effect/platform"
import {
  startDurableStreamsTestServer,
  type DurableStreamsTestServerHandle,
} from "@firegrid/durable-streams/test-utils"
import {
  local,
  normalizeRuntimeIntent,
  RuntimeJournalEventSchema,
  type RuntimeJournalEvent,
} from "@firegrid/protocol/launch"
import { Effect, Either, Option } from "effect"
import { DurableStream } from "effect-durable-streams"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  startRuntime,
  FiregridRuntimeHostLive,
} from "../runtime-host/index.ts"
import {
  RuntimeControlPlane,
  RuntimeControlPlaneLive,
} from "./service.ts"
import {
  makeWorkflowStateStore,
} from "@firegrid/durable-streams/workflow-engine"

let server: DurableStreamsTestServerHandle | undefined

beforeEach(async () => {
  server = await startDurableStreamsTestServer()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
})

const createStreamUrl = async (name: string): Promise<string> => {
  if (!server) throw new Error("server not started")
  return server.createStreamUrl(name)
}

const appendRuntimeContext = (
  controlPlaneStreamUrl: string,
  argv: ReadonlyArray<string>,
): Promise<string> =>
  Effect.runPromise(Effect.gen(function* () {
    const controlPlane = yield* RuntimeControlPlane
    const contextId = `ctx_${crypto.randomUUID()}`
    yield* controlPlane.appendContext({
      contextId,
      createdAt: new Date().toISOString(),
      runtime: normalizeRuntimeIntent(local.jsonl({
        argv: [...argv],
      })),
    })
    return contextId
  }).pipe(
    Effect.provide(RuntimeControlPlaneLive({ streamUrl: controlPlaneStreamUrl })),
  ))

const readDataPlane = async (
  streamUrl: string,
): Promise<ReadonlyArray<RuntimeJournalEvent>> => {
  return await Effect.runPromise(DurableStream.define({
    endpoint: { url: streamUrl },
    schema: RuntimeJournalEventSchema,
  }).collect.pipe(
    Effect.provide(FetchHttpClient.layer),
  ))
}

describe("durable launch tracer bullet 001", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1 firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.7 firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.5 journals child JSONL stdout events and stderr logs durably", async () => {
    const controlPlaneStreamUrl = await createStreamUrl("runtime-control")
    const dataPlaneStreamUrl = await createStreamUrl("runtime-data")
    const workflowStreamUrl = await createStreamUrl("workflow")
    const childCode = `
console.log(JSON.stringify({
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "pong" }
    ]
  }
}))
console.log("{malformed")
console.error("diagnostic: child stderr")
`
    const contextId = await appendRuntimeContext(
      controlPlaneStreamUrl,
      [process.execPath, "--input-type=module", "-e", childCode],
    )

    const result = await Effect.runPromise(
      startRuntime({
        contextId,
      }).pipe(
        // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.1
        // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.2
        // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.3
        Effect.provide(FiregridRuntimeHostLive({
          streams: {
            workflow: workflowStreamUrl,
            controlPlane: controlPlaneStreamUrl,
            runtimeOutput: dataPlaneStreamUrl,
          },
        })),
      ),
    )

    expect(result).toMatchObject({
      contextId,
      activityAttempt: 1,
      exitCode: 0,
    })

    const retained = await Effect.runPromise(Effect.gen(function* () {
      const controlPlane = yield* RuntimeControlPlane
      const dataPlane = yield* Effect.promise(() => readDataPlane(dataPlaneStreamUrl))
      return {
        context: controlPlane.getContext(contextId),
        runs: controlPlane.runsFor(contextId),
        events: dataPlane
          .flatMap(event => event.type === "firegrid.runtime.output.stdout" ? [event.event] : [])
          .sort((left, right) => left.sequence - right.sequence),
        logs: dataPlane
          .flatMap(event => event.type === "firegrid.runtime.output.stderr" ? [event.log] : []),
      }
    }).pipe(
      Effect.provide(RuntimeControlPlaneLive({ streamUrl: controlPlaneStreamUrl })),
    ))

    expect(Option.getOrUndefined(retained.context)).toMatchObject({
      contextId,
      runtime: {
        provider: "local-process",
      },
    })

    const statuses = retained.runs
      .map(event => event.status)
    expect(statuses).toEqual(expect.arrayContaining(["started", "exited"]))
    expect(statuses).toHaveLength(2)

    expect(retained.events).toHaveLength(2)
    expect(retained.events[0]).toMatchObject({
      sequence: 0,
      source: "stdout",
      format: "jsonl",
    })
    const firstEvent = retained.events[0]
    expect(firstEvent).toBeDefined()
    expect(JSON.parse(firstEvent!.raw)).toMatchObject({
      type: "assistant",
    })
    expect(retained.events[1]).toMatchObject({
      sequence: 1,
      raw: "{malformed",
    })

    expect(retained.logs).toContainEqual(expect.objectContaining({
      source: "stderr",
      raw: "diagnostic: child stderr",
    }))

    const activityClaimNames = await Effect.runPromise(
      Effect.acquireUseRelease(
        makeWorkflowStateStore({ streamUrl: workflowStreamUrl }),
        store =>
          Effect.sync(() => store.activityClaims().map(claim => claim.activityName)),
        store => store.close,
      ),
    )
    {
      // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.2
      // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.8
      expect(activityClaimNames).toContain(
        "firegrid.runtime-context.run-process-attempt",
      )
    }
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.4 records failed when local command streaming cannot start", async () => {
    const controlPlaneStreamUrl = await createStreamUrl("runtime-control")
    const dataPlaneStreamUrl = await createStreamUrl("runtime-data")
    const workflowStreamUrl = await createStreamUrl("workflow")
    const contextId = await appendRuntimeContext(
      controlPlaneStreamUrl,
      [`missing-firegrid-command-${crypto.randomUUID()}`],
    )

    const result = await Effect.runPromise(
      Effect.either(startRuntime({
        contextId,
      }).pipe(
        Effect.provide(FiregridRuntimeHostLive({
          streams: {
            workflow: workflowStreamUrl,
            controlPlane: controlPlaneStreamUrl,
            runtimeOutput: dataPlaneStreamUrl,
          },
        })),
      )),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "RuntimeContextError",
        op: "sandbox.stream",
      })
    }

    const statuses = await Effect.runPromise(Effect.gen(function* () {
      const controlPlane = yield* RuntimeControlPlane
      return controlPlane.runsFor(contextId).map(event => event.status)
    }).pipe(
      Effect.provide(RuntimeControlPlaneLive({ streamUrl: controlPlaneStreamUrl })),
    ))
    expect(statuses).toEqual(expect.arrayContaining(["started", "failed"]))
    expect(statuses).toHaveLength(2)
  })
})
