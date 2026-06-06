import { FiregridConfig } from "@firegrid/client-sdk/config"
import { Effect, Schedule } from "effect"

const sessionId = "fluent-durable-wait-session"
const reviewTurnId = "fluent-durable-wait-review-turn"
const mainTurnId = "fluent-durable-wait-main-turn"
const consumerId = "fluent-durable-wait-consumer"

interface DurableWaitResult {
  readonly sessionRows: number
  readonly reviewTurnRows: number
  readonly mainTurnRows: number
  readonly wakeRows: number
  readonly consumerOffset: string
}

const pathFrom = (
  namespace: string,
  parts: ReadonlyArray<string>,
): string =>
  [
    namespace,
    ...parts,
  ].map(encodeURIComponent).join("/")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const field = (
  row: Record<string, unknown>,
  key: string,
): unknown => row[key]

const readStream = (
  baseUrl: string,
  path: string,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${baseUrl}/v1/stream/${path}?offset=-1`)
      if (!response.ok) {
        throw new Error(`read ${path} failed with ${response.status}: ${await response.text()}`)
      }
      const body: unknown = await response.json()
      if (!Array.isArray(body)) {
        throw new Error(`read ${path} returned a non-array payload`)
      }
      return body.filter(isRecord)
    },
    catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
  })

const readConsumer = (
  baseUrl: string,
): Effect.Effect<Record<string, unknown>, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${baseUrl}/consumers/${consumerId}`)
      if (!response.ok) {
        throw new Error(`consumer read failed with ${response.status}: ${await response.text()}`)
      }
      const body: unknown = await response.json()
      if (!isRecord(body)) {
        throw new Error("consumer endpoint returned a non-object payload")
      }
      return body
    },
    catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
  })

const sessionEvents = (
  rows: ReadonlyArray<Record<string, unknown>>,
  name: string,
): ReadonlyArray<Record<string, unknown>> =>
  rows.filter(row =>
    field(row, "type") === "session.event_appended" &&
    field(row, "name") === name,
  )

const stateChanges = (
  rows: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> =>
  rows.filter(row =>
    field(row, "type") === "review.posted" ||
    field(row, "type") === "github.issue" ||
    field(row, "type") === "github.pr",
  )

const payloadOf = (
  row: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const payload = field(row, "payload")
  return isRecord(payload) ? payload : undefined
}

const eventKey = (
  row: Record<string, unknown>,
): string => {
  const event = field(row, "event")
  return isRecord(event) ? String(field(event, "key")) : ""
}

const expect = (
  condition: boolean,
  message: string,
): Effect.Effect<void, Error> =>
  condition ? Effect.void : Effect.fail(new Error(message))

const assertWakeOutcomes = (
  rows: ReadonlyArray<Record<string, unknown>>,
): Effect.Effect<void, Error> =>
  Effect.gen(function*() {
    const outcomes = sessionEvents(rows, "fluent.durable_wait.wake.outcome")
      .map(payloadOf)
      .filter((payload): payload is Record<string, unknown> => payload !== undefined)
    yield* expect(outcomes.length === 4, `expected 4 wake outcomes, got ${outcomes.length}`)

    const review = outcomes.find(outcome => field(outcome, "deliveryId") === "review-e-catchup")
    const issue = outcomes.find(outcome => field(outcome, "deliveryId") === "issue-e-nonmatch")
    const match = outcomes.find(outcome => field(outcome, "deliveryId") === "pr-e1")
    const replay = outcomes.find(outcome => field(outcome, "deliveryId") === "pr-e2")

    yield* expect(
      isRecord(review) &&
        Array.isArray(field(review, "matched")) &&
        (field(review, "matched") as ReadonlyArray<unknown>).includes("review-posted"),
      "review catch-up wake did not match the parked review wait",
    )
    yield* expect(
      isRecord(issue) &&
        Array.isArray(field(issue, "notMatched")) &&
        (field(issue, "notMatched") as ReadonlyArray<unknown>).includes("pr-merged"),
      "github.issue wake did not leave pr wait pending",
    )
    yield* expect(
      isRecord(match) &&
        Array.isArray(field(match, "matched")) &&
        (field(match, "matched") as ReadonlyArray<unknown>).includes("pr-merged") &&
        field(match, "eventKey") === "pr/e1",
      "github.pr merged wake did not commit the pr wait match",
    )
    yield* expect(
      isRecord(replay) &&
        Array.isArray(field(replay, "alreadyMatched")) &&
        (field(replay, "alreadyMatched") as ReadonlyArray<unknown>).length === 1 &&
        field(replay, "eventKey") === "pr/e2",
      "redrive did not serve the journaled match for newer satisfying event",
    )
  })

const assertSession = (
  rows: ReadonlyArray<Record<string, unknown>>,
): Effect.Effect<void, Error> =>
  Effect.gen(function*() {
    yield* expect(
      sessionEvents(rows, "fluent.durable_wait.correlation.snapshot").length === 1,
      "missing session correlation snapshot",
    )
    yield* expect(
      sessionEvents(rows, "fluent.durable_wait.turn.parked").length === 2,
      "expected two durable park facts",
    )
    yield* expect(
      sessionEvents(rows, "fluent.durable_wait.live_projection.changed").length === 1,
      "missing live projection change fact",
    )
    const changes = stateChanges(rows)
    yield* expect(
      changes.map(row => String(field(row, "key"))).join(",") ===
        "review/e-catchup,issue/e-nonmatch,pr/e1,pr/e2",
      "provider events were not durable session facts in arrival order",
    )
    yield* assertWakeOutcomes(rows)
  })

const assertReviewTurn = (
  rows: ReadonlyArray<Record<string, unknown>>,
): Effect.Effect<void, Error> =>
  Effect.gen(function*() {
    yield* expect(
      rows.map(row => String(field(row, "type"))).join(",") ===
        "turn.started,turn.wait_registered,turn.wait_matched",
      "review turn did not journal wait intent and matched event",
    )
    const intent = rows[1]
    const match = rows[2]
    yield* expect(
      intent !== undefined &&
        field(intent, "predicate") === "event.type == 'review.posted'" &&
        field(intent, "afterOffset") === "-1",
      "review wait intent did not preserve predicate and afterOffset",
    )
    yield* expect(
      match !== undefined && eventKey(match) === "review/e-catchup",
      "review catch-up match did not journal the provider event",
    )
  })

const assertMainTurn = (
  rows: ReadonlyArray<Record<string, unknown>>,
): Effect.Effect<void, Error> =>
  Effect.gen(function*() {
    yield* expect(
      rows.map(row => String(field(row, "type"))).join(",") ===
        "turn.started,turn.wait_registered,turn.wait_matched",
      "main turn should contain one wait intent and one journaled match",
    )
    const intent = rows[1]
    const match = rows[2]
    const self = intent === undefined ? undefined : field(intent, "self")
    yield* expect(
      intent !== undefined &&
        field(intent, "predicate") ===
          "event.type == 'github.pr' && event.value.state == 'merged' && event.value.repo == self.repo && event.value.issueId == self.issueId" &&
        isRecord(self) &&
        field(self, "repo") === "firegrid" &&
        field(self, "issueId") === "42",
      "main wait intent did not record desugared CEL predicate and self snapshot",
    )
    yield* expect(
      match !== undefined && eventKey(match) === "pr/e1",
      "main wait did not journal the first matching event",
    )
  })

const assertWakeStream = (
  rows: ReadonlyArray<Record<string, unknown>>,
): Effect.Effect<number, Error> => {
  const wakes = rows.filter(row =>
    field(row, "type") === "wake" && field(row, "consumer") === consumerId,
  )
  const claimed = rows.filter(row =>
    field(row, "type") === "claimed" && field(row, "consumer") === consumerId,
  )
  return wakes.length >= 4 && claimed.length >= 4
    ? Effect.succeed(rows.length)
    : Effect.fail(new Error(`expected wake/claimed rows, got ${wakes.length}/${claimed.length}`))
}

const offsetFor = (
  consumer: Record<string, unknown>,
  path: string,
): string => {
  const streams = field(consumer, "streams")
  if (!Array.isArray(streams)) return ""
  const stream = streams.filter(isRecord).find(row => field(row, "path") === path)
  return stream === undefined ? "" : String(field(stream, "offset"))
}

const observe = (
  baseUrl: string,
  namespace: string,
): Effect.Effect<DurableWaitResult, Error> =>
  Effect.gen(function*() {
    const sessionRows = yield* readStream(baseUrl, pathFrom(namespace, ["sessions", sessionId]))
    yield* assertSession(sessionRows)
    const reviewTurnRows = yield* readStream(baseUrl, pathFrom(namespace, [
      "sessions",
      sessionId,
      "turns",
      reviewTurnId,
    ]))
    yield* assertReviewTurn(reviewTurnRows)
    const mainTurnRows = yield* readStream(baseUrl, pathFrom(namespace, [
      "sessions",
      sessionId,
      "turns",
      mainTurnId,
    ]))
    yield* assertMainTurn(mainTurnRows)
    const wakeRows = yield* readStream(baseUrl, pathFrom(namespace, ["fluent-durable-wait", "wake"]))
    const wakeCount = yield* assertWakeStream(wakeRows)
    const consumer = yield* readConsumer(baseUrl)
    const consumerOffset = offsetFor(
      consumer,
      `/v1/stream/${pathFrom(namespace, ["fluent-durable-wait", "work"])}`,
    )
    yield* expect(consumerOffset !== "", "consumer did not expose work-stream cursor")
    return {
      sessionRows: sessionRows.length,
      reviewTurnRows: reviewTurnRows.length,
      mainTurnRows: mainTurnRows.length,
      wakeRows: wakeCount,
      consumerOffset,
    }
  }).pipe(
    Effect.retry({
      // Driver observation wait only; host owns provider ingress and session wake handling.
      // eslint-disable-next-line local/no-fixed-polling
      schedule: Schedule.spaced("100 millis").pipe(
        // eslint-disable-next-line local/no-fixed-polling
        Schedule.intersect(Schedule.recurs(50)),
      ),
    }),
  )

export const driver: Effect.Effect<DurableWaitResult, Error, FiregridConfig> =
  Effect.gen(function*() {
    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(
        new Error("fluent-durable-wait requires durableStreamsBaseUrl and namespace"),
      )
    }
    const result = yield* observe(config.durableStreamsBaseUrl, config.namespace)
    yield* Effect.annotateCurrentSpan({
      "firegrid.fluent_durable_wait.session_rows": result.sessionRows,
      "firegrid.fluent_durable_wait.review_turn_rows": result.reviewTurnRows,
      "firegrid.fluent_durable_wait.main_turn_rows": result.mainTurnRows,
      "firegrid.fluent_durable_wait.wake_rows": result.wakeRows,
      "firegrid.fluent_durable_wait.consumer_offset": result.consumerOffset,
    })
    return result
  }).pipe(
    Effect.withSpan("firelab.fluent_durable_wait.driver", {
      attributes: {
        "firegrid.bead": "tf-g5wz",
        "firegrid.simulation.intent": "fluent-durable-wait",
      },
    }),
  )
