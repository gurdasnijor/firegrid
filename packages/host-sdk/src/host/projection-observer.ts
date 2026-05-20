import {
  RuntimeAgentOutputAfterEvents,
  type RuntimeAgentOutputObservation,
} from "@firegrid/runtime/runtime-output"
import { Effect, Layer, Option, Stream } from "effect"

export interface HostProjectionObserverOptions<State, Match, E, R> {
  readonly spanName: string
  readonly contextId: string
  readonly initialState: State
  readonly attributes?: Record<string, unknown>
  readonly project: (
    state: State,
    observation: RuntimeAgentOutputObservation,
  ) => readonly [State, Option.Option<Match>]
  readonly onMatch: (match: Match) => Effect.Effect<void, E, R>
}

export const hostProjectionObserver = <State, Match, E = never, R = never>(
  options: HostProjectionObserverOptions<State, Match, E, R>,
): Layer.Layer<never, unknown, RuntimeAgentOutputAfterEvents | R> =>
  Layer.scopedDiscard(
    Effect.gen(function*() {
      const output = yield* RuntimeAgentOutputAfterEvents
      yield* output.forContext(options.contextId).pipe(
        Stream.mapAccum(options.initialState, options.project),
        Stream.filterMap(match => match),
        Stream.take(1),
        Stream.runHead,
        Effect.flatMap(match =>
          Option.match(match, {
            onNone: () => Effect.void,
            onSome: options.onMatch,
          })),
        Effect.withSpan(options.spanName, {
          kind: "internal",
          attributes: {
            ...options.attributes,
            "firegrid.context.id": options.contextId,
            "firegrid.wait.bucket": "projection",
          },
        }),
        Effect.forkScoped,
      )
    }),
  )
