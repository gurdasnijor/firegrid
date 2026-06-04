import { FetchHttpClient } from "@effect/platform"
import { FiregridConfig } from "@firegrid/client-sdk/config"
import { FluentStore, FluentStoreLive } from "@firegrid/fluent-runtime"
import { Effect } from "effect"

const sanitize = (value: string): string =>
  value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-")

const runtimeConfig = Effect.gen(function* () {
  const config = yield* FiregridConfig
  const durableStreamsBaseUrl = config.durableStreamsBaseUrl
  if (durableStreamsBaseUrl === undefined) {
    return yield* Effect.fail(new Error("tiny-firegrid did not provide durableStreamsBaseUrl"))
  }
  return {
    durableStreamsBaseUrl,
    namespace: config.namespace ?? "tiny-firegrid",
  }
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
    Effect.withSpan("tiny_firegrid.fluent_runtime_workbench.store_slice", {
      attributes: {
        "firegrid.namespace": config.namespace,
        "firegrid.durable_streams.base_url": config.durableStreamsBaseUrl,
      },
    }),
  )
}).pipe(
  Effect.withSpan("tiny_firegrid.fluent_runtime_workbench.driver"),
)
