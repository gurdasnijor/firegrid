import { SessionAgentOutputChannel } from "@firegrid/protocol/channels"
import {
  sessionContextIdForExternalKey,
} from "@firegrid/protocol/session-facade"
import { FiregridLocalHostLive } from "@firegrid/runtime/composition/host-live"
import { FiregridLocalProcessFromEnv } from "@firegrid/runtime/producers/sandbox/local-process-from-env"
import { Chunk, Effect, Layer, Stream } from "effect"
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

const sessionAgentOutputChannelPath: Layer.Layer<
  never,
  unknown,
  SessionAgentOutputChannel
> =
  Layer.scopedDiscard(
    Effect.gen(function*() {
      const output = yield* SessionAgentOutputChannel
      yield* collectExpected(
        "SessionAgentOutputChannel",
        output.forContext(sim1ContextId).binding.stream,
      )
    }),
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
    sessionAgentOutputChannelPath,
  ).pipe(
    Layer.provideMerge(host),
  )
}
