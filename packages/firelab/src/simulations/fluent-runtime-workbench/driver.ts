import { FetchHttpClient } from "@effect/platform"
import { FiregridConfig } from "@firegrid/client-sdk/config"
import {
  execute as executeOperation,
  gen,
  run,
  workflow,
} from "@firegrid/fluent-firegrid"
import { FluentStore, FluentStoreLive } from "@firegrid/fluent-runtime"
import { Effect } from "effect"
import { executeSandboxCommandActivity } from "./sandbox-activity-host.ts"

const sanitize = (value: string): string =>
  value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-")

const runtimeConfig = Effect.gen(function* () {
  const config = yield* FiregridConfig
  const durableStreamsBaseUrl = config.durableStreamsBaseUrl
  if (durableStreamsBaseUrl === undefined) {
    return yield* Effect.fail(new Error("firelab did not provide durableStreamsBaseUrl"))
  }
  return {
    durableStreamsBaseUrl,
    namespace: config.namespace ?? "firelab",
  }
})

interface SandboxActivityInput {
  readonly sessionId: string
  readonly argv: ReadonlyArray<string>
}

const sandboxActivityWorkflow = (
  executionCount: { count: number },
) =>
  workflow({
    name: "fluentRuntimeSandboxActivity",
    handlers: {
      runCommand: (ctx, input: SandboxActivityInput) =>
        executeOperation(
          ctx,
          gen(function* () {
            const result = yield* run(
              () => {
                executionCount.count += 1
                return executeSandboxCommandActivity(input)
              },
              { name: "sandbox-provider-execute" },
            )
            return {
              exitCode: result.exitCode,
              stdout: result.stdout,
              providerExecutions: executionCount.count,
            }
          }),
        ),
    },
  })

export const fluentRuntimeWorkbenchDriver = Effect.gen(function* () {
  const config = yield* runtimeConfig
  const runKey = sanitize(`${config.namespace}-fluent-runtime-workbench`)
  const parentSessionId = `${runKey}-parent`
  const childSessionId = `${runKey}-child`
  const turnId = `${runKey}-turn`

  yield* Effect.gen(function* () {
    const store = yield* FluentStore
    const session = yield* store.createSession({
      sessionId: parentSessionId,
      agent: "workbench-agent",
    })
    yield* Effect.annotateCurrentSpan({
      "firegrid.session.id": session.sessionId,
      "fluent_runtime.session.events_url": session.eventsUrl,
    })

    yield* store.appendSessionEvent({
      sessionId: parentSessionId,
      name: "resource.mounted",
      payload: {
        source: "repo:firegrid",
        mountPath: "/workspace/firegrid",
      },
    })
    const parentEvents = yield* store.collectSession(parentSessionId)
    const parentHead = yield* store.headSession(parentSessionId)
    yield* Effect.annotateCurrentSpan({
      "fluent_runtime.parent.events": parentEvents.length,
      "fluent_runtime.parent.offset": parentHead.offset,
      "fluent_runtime.parent.closed": parentHead.streamClosed,
    })

    const fork = yield* store.forkSession({
      parentSessionId,
      childSessionId,
      forkOffset: parentHead.offset,
    })
    yield* Effect.annotateCurrentSpan({
      "fluent_runtime.fork.result": fork._tag,
      ...(fork._tag === "Unsupported" ? { "fluent_runtime.fork.reason": fork.reason } : {}),
    })
    if (fork._tag === "Forked") {
      yield* store.appendSessionEvent({
        sessionId: parentSessionId,
        name: "parent.after_fork",
        payload: { visibleToChild: false },
      })
      yield* store.appendSessionEvent({
        sessionId: childSessionId,
        name: "child.diverged",
        payload: { inheritedParentPrefix: true },
      })
      const parentAfterFork = yield* store.collectSession(parentSessionId)
      const childAfterFork = yield* store.collectSession(childSessionId)
      yield* Effect.annotateCurrentSpan({
        "fluent_runtime.fork.parent_events_after": parentAfterFork.length,
        "fluent_runtime.fork.child_events_after": childAfterFork.length,
        "fluent_runtime.fork.child_event_names": childAfterFork
          .map((event) => event.type === "session.event_appended" ? event.name : event.type)
          .join(","),
      })
    }

    const turn = yield* store.startTurn({
      sessionId: parentSessionId,
      turnId,
      prompt: "Summarize whether the fluent runtime store can model finite turns.",
    })
    yield* store.completeTurn({
      sessionId: parentSessionId,
      turnId,
      result: {
        summary: "turn streams close on completion",
        eventStream: turn.eventsUrl,
      },
    })
    const read = yield* store.readTurn(parentSessionId, turnId)
    yield* Effect.annotateCurrentSpan({
      "firegrid.turn.id": turnId,
      "fluent_runtime.turn.events": read.events.length,
      "fluent_runtime.turn.closed": read.streamClosed,
      "fluent_runtime.turn.offset": read.head.offset,
    })
  }).pipe(
    Effect.provide(FluentStoreLive(config)),
    Effect.provide(FetchHttpClient.layer),
    Effect.withSpan("firelab.fluent_runtime_workbench.store_slice", {
      attributes: {
        "firegrid.namespace": config.namespace,
        "firegrid.durable_streams.base_url": config.durableStreamsBaseUrl,
      },
    }),
  )

  yield* Effect.gen(function* () {
    const executionCount = { count: 0 }
    const activityWorkflow = sandboxActivityWorkflow(executionCount)
    const ctx = {
      journal: {
        endpoint: {
          url:
            `${config.durableStreamsBaseUrl}/v1/stream/${config.namespace}/fluent-runtime-workbench/sandbox-activity`,
        },
      },
    }
    const input = {
      sessionId: parentSessionId,
      argv: [
        process.execPath,
        "--input-type=module",
        "-e",
        "console.log(JSON.stringify({activity:'sandbox-provider-execute',ok:true}))",
      ],
    }

    // fluent-runtime-workbench.SIM.3
    const first = yield* activityWorkflow.handlers.runCommand(ctx, input)
    const replay = yield* activityWorkflow.handlers.runCommand(ctx, input)
    yield* Effect.annotateCurrentSpan({
      "fluent_runtime.sandbox_activity.first_exit_code": first.exitCode,
      "fluent_runtime.sandbox_activity.replay_exit_code": replay.exitCode,
      "fluent_runtime.sandbox_activity.stdout": replay.stdout,
      "fluent_runtime.sandbox_activity.provider_executions": executionCount.count,
      "fluent_runtime.sandbox_activity.replay_reused_journal":
        executionCount.count === 1 && first.stdout === replay.stdout,
    })
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.withSpan("firelab.fluent_runtime_workbench.sandbox_activity", {
      attributes: {
        "firegrid.namespace": config.namespace,
        "firegrid.durable_streams.base_url": config.durableStreamsBaseUrl,
      },
    }),
  )
}).pipe(
  Effect.withSpan("firelab.fluent_runtime_workbench.driver"),
)
