import {
  Firegrid,
  local,
} from "@firegrid/client"
import type {
  RuntimeJournalEvent,
} from "@firegrid/protocol/launch"
import {
  FiregridRuntimeHostLive,
  startRuntime,
} from "@firegrid/runtime"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  startFiregridScenarioHarness,
  type FiregridScenarioHarness,
} from "./scenario-harness.ts"
import {
  readRuntimeJournalEvents,
} from "./durable-stream-fixtures.ts"

let harness: FiregridScenarioHarness | undefined

beforeEach(async () => {
  harness = await startFiregridScenarioHarness()
})

afterEach(async () => {
  await harness?.stop()
  harness = undefined
})

const createStreamUrl = async (name: string): Promise<string> => {
  if (!harness) throw new Error("scenario harness not started")
  return harness.createStreamUrl(name)
}

const runWithFiregrid = <A, E>(
  options: {
    readonly controlPlaneStreamUrl: string
    readonly dataPlaneStreamUrl: string
  },
  effect: Effect.Effect<A, E, Firegrid>,
): Promise<A> => {
  if (!harness) throw new Error("scenario harness not started")
  return harness.runWithFiregrid(options, effect)
}

describe("firegrid tracer 007 sandbox slot extraction", () => {
  it("firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.1 firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.6 firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.3 firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.5 journals stdout stderr and exit through FiregridRuntimeHostLive", async () => {
    const controlPlaneStreamUrl = await createStreamUrl("runtime-control")
    const dataPlaneStreamUrl = await createStreamUrl("runtime-output")
    const workflowStreamUrl = await createStreamUrl("workflow")
    const childCode = `
console.log(JSON.stringify({ type: "assistant", text: "sandbox-slot-pong" }))
console.error("diagnostic: sandbox-slot")
`

    const handle = await runWithFiregrid(
      { controlPlaneStreamUrl, dataPlaneStreamUrl },
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.launch({
          runtime: local.jsonl({
            argv: [process.execPath, "--input-type=module", "-e", childCode],
          }),
        })
      }),
    )

    const runtime = await Effect.runPromise(
      startRuntime({
        contextId: handle.contextId,
      }).pipe(
        // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.4
        // firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.1
        // The scenario provides only the production host root; sandbox wiring stays inside FiregridRuntimeHostLive.
        Effect.provide(FiregridRuntimeHostLive({
          streams: {
            workflow: workflowStreamUrl,
            controlPlane: controlPlaneStreamUrl,
            runtimeOutput: dataPlaneStreamUrl,
          },
        })),
      ),
    )

    expect(runtime).toMatchObject({
      contextId: handle.contextId,
      exitCode: 0,
    })

    const snapshot = await runWithFiregrid(
      { controlPlaneStreamUrl, dataPlaneStreamUrl },
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.open(handle.contextId).snapshot
      }),
    )

    expect(snapshot.runs).toContainEqual(expect.objectContaining({
      contextId: handle.contextId,
      status: "exited",
      exitCode: 0,
      provider: "local-process",
    }))

    const retainedJournal = await Effect.runPromise(
      readRuntimeJournalEvents(dataPlaneStreamUrl),
    )

    expect(retainedJournal).toContainEqual(expect.objectContaining({
      type: "firegrid.runtime.output.stdout",
      event: expect.objectContaining({
        contextId: handle.contextId,
        source: "stdout",
        raw: "{\"type\":\"assistant\",\"text\":\"sandbox-slot-pong\"}",
      }),
    }))
    expect(retainedJournal).toContainEqual(expect.objectContaining({
      type: "firegrid.runtime.output.stderr",
      log: expect.objectContaining({
        contextId: handle.contextId,
        source: "stderr",
        raw: "diagnostic: sandbox-slot",
      }),
    }))
  })
})
