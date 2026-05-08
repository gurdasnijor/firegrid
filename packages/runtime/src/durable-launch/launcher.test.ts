import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { NodeContext } from "@effect/platform-node"
import {
  local,
  normalizeRuntimeIntent,
} from "@firegrid/protocol/launch"
import { Effect, Either, Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  LocalProcessSandboxProviderLive,
} from "./execution/providers/local-process.ts"
import {
  runLaunchOnce,
} from "./launcher.ts"
import {
  RuntimeLaunchDb,
  RuntimeLaunchDbLive,
} from "./store.ts"
import {
  makeWorkflowStateStore,
} from "../durable-workflow/workflows.ts"

let server: DurableStreamTestServer | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
})

const createStreamUrl = async (name: string): Promise<string> => {
  if (!server) throw new Error("server not started")
  const streamUrl = `${server.url}/v1/stream/${name}-${crypto.randomUUID()}`
  await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
  })
  return streamUrl
}

const appendLaunchIntent = (
  launchStreamUrl: string,
  argv: ReadonlyArray<string>,
): Promise<string> =>
  Effect.runPromise(Effect.gen(function* () {
    const db = yield* RuntimeLaunchDb
    const launchId = `launch_${crypto.randomUUID()}`
    yield* db.appendLaunchRequest({
      launchId,
      requestedAt: new Date().toISOString(),
      runtime: normalizeRuntimeIntent(local.jsonl({
        argv: [...argv],
      })),
    })
    return launchId
  }).pipe(
    Effect.provide(RuntimeLaunchDbLive({ streamUrl: launchStreamUrl })),
  ))

describe("durable launch tracer bullet 001", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1 firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.7 firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.5 journals child JSONL stdout and stderr diagnostics durably", async () => {
    const launchStreamUrl = await createStreamUrl("launch-control")
    const workflowStreamUrl = await createStreamUrl("launch-workflow")
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
    const launchId = await appendLaunchIntent(
      launchStreamUrl,
      [process.execPath, "--input-type=module", "-e", childCode],
    )

    const result = await Effect.runPromise(
      runLaunchOnce({
        launchStreamUrl,
        workflowStreamUrl,
        launchId,
      }).pipe(
        Effect.provide(Layer.mergeAll(
          LocalProcessSandboxProviderLive,
          NodeContext.layer,
        )),
      ),
    )

    expect(result).toMatchObject({
      launchId,
      activityAttempt: 1,
      exitCode: 0,
    })

    const retained = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* RuntimeLaunchDb
      return {
        request: db.getLaunchRequest(launchId),
        processEvents: db.processEventsFor(launchId),
        providerWireRows: [...db.providerWireFor(launchId)]
          .sort((left, right) => left.sequence - right.sequence),
        diagnosticRows: db.diagnosticsFor(launchId),
      }
    }).pipe(
      Effect.provide(RuntimeLaunchDbLive({ streamUrl: launchStreamUrl })),
    ))

    expect(Option.getOrUndefined(retained.request)).toMatchObject({
      launchId,
      runtime: {
        provider: "local-process",
      },
    })

    const statuses = retained.processEvents
      .map(event => event.status)
    expect(statuses).toEqual(expect.arrayContaining(["started", "exited"]))
    expect(statuses).toHaveLength(2)

    expect(retained.providerWireRows).toHaveLength(2)
    expect(retained.providerWireRows[0]).toMatchObject({
      sequence: 0,
      channel: "stdout",
      format: "jsonl",
      stream: "provider-wire",
      parseStatus: "valid-json",
    })
    expect(JSON.parse(retained.providerWireRows[0]?.raw ?? "{}")).toMatchObject({
      type: "assistant",
    })
    expect(retained.providerWireRows[1]).toMatchObject({
      sequence: 1,
      raw: "{malformed",
      parseStatus: "malformed-json",
    })

    expect(retained.diagnosticRows).toContainEqual(expect.objectContaining({
      channel: "stderr",
      stream: "diagnostics",
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
        "firegrid.launch-agent.run-process-attempt",
      )
    }
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.4 records failed when local command streaming cannot start", async () => {
    const launchStreamUrl = await createStreamUrl("launch-control")
    const workflowStreamUrl = await createStreamUrl("launch-workflow")
    const launchId = await appendLaunchIntent(
      launchStreamUrl,
      [`missing-firegrid-command-${crypto.randomUUID()}`],
    )

    const result = await Effect.runPromise(
      Effect.either(runLaunchOnce({
        launchStreamUrl,
        workflowStreamUrl,
        launchId,
      }).pipe(
        Effect.provide(Layer.mergeAll(
          LocalProcessSandboxProviderLive,
          NodeContext.layer,
        )),
      )),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "RuntimeLaunchError",
        op: "sandbox.stream",
      })
    }

    const statuses = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* RuntimeLaunchDb
      return db.processEventsFor(launchId).map(event => event.status)
    }).pipe(
      Effect.provide(RuntimeLaunchDbLive({ streamUrl: launchStreamUrl })),
    ))
    expect(statuses).toEqual(expect.arrayContaining(["started", "failed"]))
    expect(statuses).toHaveLength(2)
  })
})
