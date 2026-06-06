import { FiregridConfig } from "@firegrid/client-sdk/config"
import { Effect, Schedule } from "effect"

// Airgapped from host code (firelab rule: import only @firegrid/client-sdk +
// effect). The driver does NOT draw the verdict — the coverage gates judge the
// run from forge-proof host-substrate spans. Here the driver only OBSERVES the
// durable session stream and annotates what it saw, for corroboration.
const HOST_SESSION_ID = "fluent-acp-real-spawn-session"
const L1_SESSION_UPDATE = "acp.session_update"

interface RealSpawnObservation {
  readonly sessionEvents: number
  readonly sessionUpdateFacts: number
  readonly agentMessageChunks: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const sessionStreamPath = (namespace: string): string =>
  [namespace, "sessions", HOST_SESSION_ID].map(encodeURIComponent).join("/")

const readSessionEvents = (
  baseUrl: string,
  namespace: string,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, Error> =>
  Effect.tryPromise({
    try: async () => {
      const path = sessionStreamPath(namespace)
      const response = await fetch(`${baseUrl}/v1/stream/${path}?offset=-1`, { method: "GET" })
      if (!response.ok) {
        throw new Error(`read ${path} failed with ${response.status}`)
      }
      const parsed: unknown = await response.json()
      if (!Array.isArray(parsed)) {
        throw new Error(`read ${path} returned a non-array payload`)
      }
      return parsed.filter(isRecord)
    },
    catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
  })

const isAgentMessageChunk = (fact: Record<string, unknown>): boolean => {
  const payload = fact["payload"]
  if (!isRecord(payload)) return false
  const observation = payload["observation"]
  if (!isRecord(observation)) return false
  const update = observation["update"]
  return isRecord(update) && update["sessionUpdate"] === "agent_message_chunk"
}

const observe = (events: ReadonlyArray<Record<string, unknown>>): RealSpawnObservation => {
  const sessionUpdates = events.filter((e) =>
    e["type"] === "session.event_appended" && e["name"] === L1_SESSION_UPDATE)
  return {
    sessionEvents: events.length,
    sessionUpdateFacts: sessionUpdates.length,
    agentMessageChunks: sessionUpdates.filter(isAgentMessageChunk).length,
  }
}

export const driver: Effect.Effect<RealSpawnObservation, Error, FiregridConfig> = Effect.gen(
  function*() {
    const config = yield* FiregridConfig
    const baseUrl = config.durableStreamsBaseUrl
    const namespace = config.namespace
    if (baseUrl === undefined || namespace === undefined) {
      return yield* Effect.fail(
        new Error("fluent-acp-real-spawn-acceptance requires durableStreamsBaseUrl and namespace"),
      )
    }

    // Keep the run ALIVE until the real agent's output is observable, then
    // return — this is a liveness WAIT on a public marker, not a verdict. The
    // driver draws no pass/fail: it waits for the agent_message_chunk L1 marker
    // (the real turn takes tens of seconds incl. npx fetch + model turn) and, if
    // it never appears before the bound, returns whatever it observed so the
    // gates judge a not-covered verdict. (Returning early on session.created
    // alone would tear the host/agent down mid-turn.)
    const events = yield* readSessionEvents(baseUrl, namespace).pipe(
      Effect.flatMap((evs) =>
        observe(evs).agentMessageChunks >= 1
          ? Effect.succeed(evs)
          : Effect.fail(new Error("waiting for real agent output")),
      ),
      Effect.retry({
        // eslint-disable-next-line local/no-fixed-polling
        schedule: Schedule.spaced("1 seconds").pipe(
          // eslint-disable-next-line local/no-fixed-polling
          Schedule.intersect(Schedule.recurs(240)),
        ),
      }),
      // Bound exhausted: observe whatever exists and return — the gates judge.
      Effect.catchAll(() => readSessionEvents(baseUrl, namespace)),
    )

    const seen = observe(events)
    yield* Effect.annotateCurrentSpan({
      "fluent_acp_real_spawn.session_events": seen.sessionEvents,
      "fluent_acp_real_spawn.session_update_facts": seen.sessionUpdateFacts,
      "fluent_acp_real_spawn.agent_message_chunks": seen.agentMessageChunks,
    })
    return seen
  },
).pipe(
  Effect.withSpan("firelab.fluent_acp_real_spawn.driver", {
    attributes: {
      "firegrid.bead": "tf-88bd.1",
      "firegrid.simulation.intent": "fluent-acp-real-spawn-acceptance",
    },
  }),
)
