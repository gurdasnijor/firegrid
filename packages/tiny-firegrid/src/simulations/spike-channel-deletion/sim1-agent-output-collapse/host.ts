import {
  CurrentHostSession,
  RuntimeOutputTable,
  runtimeContextOutputStreamUrl,
} from "@firegrid/protocol/launch"
import {
  sessionContextIdForExternalKey,
} from "@firegrid/protocol/session-facade"
import {
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  hostProjectionObserver,
} from "@firegrid/host-sdk"
import type { SessionAgentOutputChannel } from "@firegrid/protocol/channels"
import { runtimeAgentOutputObservationFromRow } from "@firegrid/runtime/events"
import { RuntimeAgentOutputAfterEvents } from "@firegrid/runtime/runtime-output"
import { Chunk, Effect, Layer, Option, Stream } from "effect"
import type { Scope } from "effect"
import type { TinyFiregridHostEnv } from "../../../types.ts"
import {
  isSim1ExpectedEvent,
  recordSim1Observations,
  resetSim1Observations,
  sim1EventSignature,
  sim1ExternalKey,
  sim1SignaturesText,
  type Sim1EventSignature,
  type Sim1ObserverPath,
} from "./observation-state.ts"

const sim1ContextId = sessionContextIdForExternalKey(sim1ExternalKey)

const recordWithSpan = (
  path: Sim1ObserverPath,
  events: ReadonlyArray<Sim1EventSignature>,
): Effect.Effect<void> =>
  recordSim1Observations(path, events).pipe(
    Effect.withSpan("firegrid.simulation.sim1.observer.record", {
      kind: "internal",
      attributes: {
        "firegrid.simulation.path": path,
        "firegrid.simulation.event_count": events.length,
        "firegrid.simulation.event_signatures": sim1SignaturesText(events),
      },
    }),
  )

const collectExpected = <R = never>(
  path: Sim1ObserverPath,
  stream: Stream.Stream<Parameters<typeof sim1EventSignature>[0], unknown, R>,
): Effect.Effect<void, unknown, Scope.Scope | R> =>
  stream.pipe(
    Stream.filter(observation => observation.contextId === sim1ContextId),
    Stream.filter(isSim1ExpectedEvent),
    Stream.map(sim1EventSignature),
    Stream.take(3),
    Stream.runCollect,
    Effect.flatMap(chunk => recordWithSpan(path, Chunk.toReadonlyArray(chunk))),
    Effect.forkScoped,
    Effect.asVoid,
  )

const hostProjectionObserverPath: Layer.Layer<
  never,
  unknown,
  SessionAgentOutputChannel
> =
  hostProjectionObserver({
    spanName: "firegrid.simulation.sim1.host_projection_observer",
    contextId: sim1ContextId,
    initialState: [] as ReadonlyArray<Sim1EventSignature>,
    attributes: {
      "firegrid.simulation.path": "hostProjectionObserver",
    },
    project: (state, observation) => {
      if (!isSim1ExpectedEvent(observation)) return [state, Option.none()]
      const next = [...state, sim1EventSignature(observation)]
      return [
        next,
        next.length === 3 ? Option.some(next) : Option.none(),
      ]
    },
    onMatch: events => recordWithSpan("hostProjectionObserver", events),
  })

const runtimeAgentOutputAfterEventsPath: Layer.Layer<
  never,
  unknown,
  RuntimeAgentOutputAfterEvents
> =
  Layer.scopedDiscard(
    Effect.gen(function*() {
      const output = yield* RuntimeAgentOutputAfterEvents
      yield* collectExpected(
        "RuntimeAgentOutputAfterEvents.forContext",
        output.forContext(sim1ContextId),
      )
    }),
  )

const rawRuntimeOutputTableLayer = (
  env: TinyFiregridHostEnv,
) =>
  Layer.unwrapEffect(
    Effect.map(CurrentHostSession, hostSession =>
      RuntimeOutputTable.layer({
        streamOptions: {
          url: runtimeContextOutputStreamUrl({
            baseUrl: env.durableStreamsBaseUrl,
            prefix: hostSession.streamPrefix,
            contextId: sim1ContextId,
          }),
          contentType: "application/json",
        },
      })),
  )

const rawRuntimeOutputTablePath = (
  env: TinyFiregridHostEnv,
): Layer.Layer<never, unknown, CurrentHostSession> =>
  Layer.scopedDiscard(
    collectExpected(
      "RuntimeOutputTable.events.rows",
      Stream.unwrap(
        Effect.map(RuntimeOutputTable, table =>
          table.events.rows().pipe(
            Stream.filterMap(runtimeAgentOutputObservationFromRow),
          )),
      ).pipe(Stream.provideLayer(rawRuntimeOutputTableLayer(env))),
    ),
  )

const resetLayer = Layer.scopedDiscard(resetSim1Observations)

export const sim1AgentOutputCollapseHost = (
  env: TinyFiregridHostEnv,
) => {
  const host = FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
  )

  return Layer.mergeAll(
    resetLayer,
    hostProjectionObserverPath,
    runtimeAgentOutputAfterEventsPath,
    rawRuntimeOutputTablePath(env),
  ).pipe(
    Layer.provideMerge(host),
  )
}
