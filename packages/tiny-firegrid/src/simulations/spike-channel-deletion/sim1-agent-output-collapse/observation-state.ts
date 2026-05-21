import type { RuntimeAgentOutputObservation } from "@firegrid/protocol/session-facade"
import { Effect } from "effect"

export const sim1ExternalKey = {
  source: "tiny-firegrid",
  id: "sim1-agent-output-collapse",
} as const

export const sim1Token = "SIM1_AGENT_OUTPUT_COLLAPSE"

export type Sim1ObserverPath =
  | "session.wait.forAgentOutput"
  | "SessionAgentOutputChannel"

export interface Sim1EventSignature {
  readonly sequence: number
  readonly tag: RuntimeAgentOutputObservation["_tag"]
  readonly detail: string
}

const observations = new Map<Sim1ObserverPath, ReadonlyArray<Sim1EventSignature>>()

export const sim1ObserverPaths: ReadonlyArray<Sim1ObserverPath> = [
  "session.wait.forAgentOutput",
  "SessionAgentOutputChannel",
]

export const resetSim1Observations: Effect.Effect<void> =
  Effect.sync(() => observations.clear())

export const recordSim1Observations = (
  path: Sim1ObserverPath,
  events: ReadonlyArray<Sim1EventSignature>,
): Effect.Effect<void> =>
  Effect.sync(() => observations.set(path, events))

export const sim1ObservationsSnapshot: Effect.Effect<
  ReadonlyMap<Sim1ObserverPath, ReadonlyArray<Sim1EventSignature>>
> =
  Effect.sync(() => new Map(observations))

export const isSim1ExpectedEvent = (
  observation: RuntimeAgentOutputObservation,
): boolean =>
  observation._tag === "TurnComplete" ||
  (observation._tag === "TextChunk" &&
    (observation.event.part.delta === `${sim1Token}:one` ||
      observation.event.part.delta === `${sim1Token}:two`))

export const sim1EventSignature = (
  observation: RuntimeAgentOutputObservation,
): Sim1EventSignature => ({
  sequence: observation.sequence,
  tag: observation._tag,
  detail: observation._tag === "TextChunk"
    ? observation.event.part.delta
    : observation._tag === "TurnComplete"
    ? observation.event.finishReason
    : observation._tag,
})

export const sim1SignaturesText = (
  events: ReadonlyArray<Sim1EventSignature>,
): string =>
  events.map(event => `${event.sequence}:${event.tag}:${event.detail}`).join("|")
