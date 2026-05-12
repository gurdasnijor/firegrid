/**
 * Tracer 020 — Durable Fact Wait Descriptor.
 *
 * The wait evaluator is composed from existing
 * `effect-durable-operators` helpers — `DurableConsumer.forEach`
 * (once-per-wait request consumption) + `ConsumerSource.findFirst`
 * (source predicate lookup) + `ConsumerSource.fromDurableStream({
 * cursor })` (offset start) — over `@firegrid/protocol/wait` rows
 * with a host-owned named matcher table. No wait-specific operator
 * module exists.
 *
 * Architecture and v0 contract: see
 * docs/tracers/020-durable-fact-wait-descriptor.md.
 *
 * Spec ACIDs covered:
 *   firegrid-durable-fact-wait-descriptor.{DESCRIPTOR.{1,2,3,4},
 *     EVALUATOR.{1,3,4,5,6,7}, AUTHORITY.{1,2,3}}
 *   effect-durable-operators.{CONSUMER.9, SOURCE.6, SOURCE.7}
 */

import {
  startDurableStreamsTestServer,
  type DurableStreamsTestServerHandle,
} from "@firegrid/durable-streams/test-utils"
import { FetchHttpClient, type HttpClient } from "@effect/platform"
import {
  makeWaitFailedRow,
  makeWaitMatchedRow,
  makeWaitRequestedRow,
  WaitRowSchema,
  type WaitFailure,
  type WaitMatch,
  type WaitRequestedRow,
  type WaitRow,
} from "@firegrid/protocol/wait"
import {
  ConsumerCheckpointStoreLive,
  ConsumerSource,
  DurableConsumer,
} from "effect-durable-operators"
import { DurableStream } from "effect-durable-streams"
import { Effect, Option, Schema, type Scope } from "effect"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

// ---------- harness ----------

let server: DurableStreamsTestServerHandle | undefined
beforeAll(async () => {
  server = await startDurableStreamsTestServer()
})
afterAll(async () => {
  await server?.stop()
})
const streamUrl = async (name: string): Promise<string> => {
  if (server === undefined) throw new Error("server not started")
  return server.createStreamUrl(name)
}
type Reqs = FetchHttpClient.Fetch | HttpClient.HttpClient | Scope.Scope
const runtime = <A, E>(eff: Effect.Effect<A, E, Reqs>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      eff.pipe(Effect.provide(FetchHttpClient.layer)) as Effect.Effect<
        A,
        E,
        Scope.Scope
      >,
    ),
  )

// ---------- matcher table (host config) ----------

type Matcher = (row: unknown, params: unknown) => Option.Option<unknown>

const SourceFact = Schema.Struct({
  sequence: Schema.Number,
  text: Schema.String,
})
type SourceFact = Schema.Schema.Type<typeof SourceFact>

const textEquals: Matcher = (row, params) => {
  if (typeof row !== "object" || row === null) return Option.none()
  const rec = row as Record<string, unknown>
  const want = (params as { readonly text?: unknown })?.text
  if (typeof rec.text !== "string" || typeof rec.sequence !== "number") {
    return Option.none()
  }
  return rec.text === want
    ? Option.some({ sequence: rec.sequence, text: rec.text } satisfies SourceFact)
    : Option.none()
}

const matchers: Record<string, Matcher> = {
  "test.text-equals@1": textEquals,
}

// ---------- shared setup ----------

let waitStreamUrl: string
let sourceStreamUrl: string
let checkpointsStreamUrl: string

beforeEach(async () => {
  waitStreamUrl = await streamUrl("tracer-020-wait")
  sourceStreamUrl = await streamUrl("tracer-020-source")
  checkpointsStreamUrl = await streamUrl("tracer-020-wait-checkpoints")
})

const appendSource = (fact: SourceFact) =>
  DurableStream.define({
    endpoint: { url: sourceStreamUrl },
    schema: SourceFact,
  }).append(fact)

const appendWaitRequested = (
  waitId: string,
  matcherId: string,
  matcherVersion: number,
  params: unknown,
  options?: { readonly cursor?: string },
) =>
  DurableStream.define({
    endpoint: { url: waitStreamUrl },
    schema: Schema.Any,
  }).append(
    makeWaitRequestedRow({
      waitId,
      ownerId: "tracer-020",
      idempotencyKey: waitId,
      source: {
        streamUrl: sourceStreamUrl,
        ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
      },
      matcherId,
      matcherVersion,
      matcherParams: params,
    }),
  )

const readWaitRows = () =>
  Effect.map(
    DurableStream.define({
      endpoint: { url: waitStreamUrl },
      schema: Schema.Unknown,
    }).collect,
    (rows) =>
      rows.flatMap((r): ReadonlyArray<WaitRow> => {
        const decoded = Schema.decodeUnknownEither(WaitRowSchema)(r)
        return decoded._tag === "Right" ? [decoded.right] : []
      }),
  )

// ---------- evaluator: forEach + findFirst + protocol-row append ----------

const evaluateSnapshotWait = (req: WaitRequestedRow) => {
  const outcomes = DurableStream.define({
    endpoint: { url: waitStreamUrl },
    schema: Schema.Unknown,
  })
  const appendFailed = (failure: WaitFailure) =>
    outcomes.append(makeWaitFailedRow({ waitId: req.waitId, failure }))
  const appendMatched = (matchedValue: unknown) => {
    const match: WaitMatch = {
      waitId: req.waitId,
      matcherId: req.matcherId,
      matcherVersion: req.matcherVersion,
      matchedAt: new Date().toISOString(),
      matchedValue,
    }
    return outcomes.append(makeWaitMatchedRow({ waitId: req.waitId, match }))
  }

  return Effect.gen(function* () {
    const matcher = matchers[`${req.matcherId}@${req.matcherVersion}`]
    if (matcher === undefined) {
      yield* appendFailed({ reason: "unknown-matcher" })
      return
    }
    const found = yield* ConsumerSource.findFirst(
      ConsumerSource.fromDurableStream(
        DurableStream.define({
          endpoint: { url: req.source.streamUrl },
          schema: Schema.Unknown,
        }),
        req.source.cursor === undefined ? undefined : { cursor: req.source.cursor },
      ),
      (row) => matcher(row, req.matcherParams),
    )
    yield* Option.match(found, {
      onNone: () => appendFailed({ reason: "matcher-error" }),
      onSome: (value) => appendMatched(value),
    })
  })
}

const runEvaluator = (subscriberId: string) =>
  DurableConsumer.forEach({
    name: "firegrid.wait.evaluator",
    source: ConsumerSource.fromDurableStream(
      DurableStream.define({
        endpoint: { url: waitStreamUrl },
        schema: WaitRowSchema,
      }),
    ),
    checkpoint: { subscriberId },
    select: (row: WaitRow) =>
      row.type === "firegrid.wait.requested"
        ? Option.some(row satisfies WaitRequestedRow)
        : Option.none(),
    key: (req: WaitRequestedRow) => req.waitId,
    live: false,
    process: evaluateSnapshotWait,
  }).pipe(
    Effect.provide(
      ConsumerCheckpointStoreLive({
        streamOptions: {
          endpoint: { url: checkpointsStreamUrl },
          producerId: `tracer-020-checkpoints:${subscriberId}`,
        },
      }),
    ),
  )

// ---------- tests ----------

describe("firegrid tracer 020 durable fact wait descriptor", () => {
  it(
    "firegrid-durable-fact-wait-descriptor.DESCRIPTOR.1 firegrid-durable-fact-wait-descriptor.DESCRIPTOR.2 firegrid-durable-fact-wait-descriptor.EVALUATOR.3 retained source fact matched + durable wait.matched outcome",
    async () => {
      await runtime(
        Effect.gen(function* () {
          yield* appendSource({ sequence: 0, text: "hello" })
          yield* appendSource({ sequence: 1, text: "match-me" })
          yield* appendSource({ sequence: 2, text: "world" })

          yield* appendWaitRequested(
            "wait:retained-match",
            "test.text-equals",
            1,
            { text: "match-me" },
          )

          const result = yield* runEvaluator("evaluator:retained")
          expect(result.processed).toBe(1)

          const rows = yield* readWaitRows()
          const matched = rows.filter((r) => r.type === "firegrid.wait.matched")
          expect(matched).toHaveLength(1)
          if (matched[0]?.type === "firegrid.wait.matched") {
            expect(matched[0].waitId).toBe("wait:retained-match")
            expect(matched[0].match.matcherId).toBe("test.text-equals")
            expect(matched[0].match.matchedValue).toMatchObject({
              sequence: 1,
              text: "match-me",
            })
          }
        }),
      )
    },
  )

  it(
    "firegrid-durable-fact-wait-descriptor.EVALUATOR.4 firegrid-durable-fact-wait-descriptor.AUTHORITY.2 restart + rescan does not append duplicate outcomes (exact row counts asserted)",
    async () => {
      await runtime(
        Effect.gen(function* () {
          yield* appendSource({ sequence: 0, text: "once-only" })
          yield* appendWaitRequested(
            "wait:restart-dedupe",
            "test.text-equals",
            1,
            { text: "once-only" },
          )

          const first = yield* runEvaluator("evaluator:restart")
          expect(first.processed).toBe(1)

          const second = yield* runEvaluator("evaluator:restart")
          expect(second.processed).toBe(0)

          const rows = yield* readWaitRows()
          expect(
            rows.filter((r) => r.type === "firegrid.wait.requested"),
          ).toHaveLength(1)
          expect(
            rows.filter((r) => r.type === "firegrid.wait.matched"),
          ).toHaveLength(1)
          expect(
            rows.filter((r) => r.type === "firegrid.wait.failed"),
          ).toHaveLength(0)
        }),
      )
    },
  )

  it(
    "firegrid-durable-fact-wait-descriptor.EVALUATOR.5 unknown matcher produces a typed durable wait.failed outcome (not a silent skip)",
    async () => {
      await runtime(
        Effect.gen(function* () {
          yield* appendWaitRequested(
            "wait:unknown-matcher",
            "does-not-exist",
            1,
            {},
          )
          const result = yield* runEvaluator("evaluator:failure")
          expect(result.processed).toBe(1)

          const rows = yield* readWaitRows()
          const failed = rows.filter((r) => r.type === "firegrid.wait.failed")
          const matched = rows.filter((r) => r.type === "firegrid.wait.matched")
          expect(failed).toHaveLength(1)
          if (failed[0]?.type === "firegrid.wait.failed") {
            expect(failed[0].waitId).toBe("wait:unknown-matcher")
            expect(failed[0].failure.reason).toBe("unknown-matcher")
          }
          expect(matched).toHaveLength(0)
        }),
      )
    },
  )

  it(
    "firegrid-durable-fact-wait-descriptor.EVALUATOR.7 snapshot closes without a match → typed matcher-error wait.failed outcome",
    async () => {
      await runtime(
        Effect.gen(function* () {
          yield* appendSource({ sequence: 0, text: "alpha" })
          yield* appendSource({ sequence: 1, text: "beta" })
          yield* appendWaitRequested(
            "wait:no-match",
            "test.text-equals",
            1,
            { text: "never-appears" },
          )
          const result = yield* runEvaluator("evaluator:no-match")
          expect(result.processed).toBe(1)

          const rows = yield* readWaitRows()
          const failed = rows.filter((r) => r.type === "firegrid.wait.failed")
          const matched = rows.filter((r) => r.type === "firegrid.wait.matched")
          expect(failed).toHaveLength(1)
          if (failed[0]?.type === "firegrid.wait.failed") {
            expect(failed[0].waitId).toBe("wait:no-match")
            expect(failed[0].failure.reason).toBe("matcher-error")
          }
          expect(matched).toHaveLength(0)
        }),
      )
    },
  )

  it(
    "firegrid-durable-fact-wait-descriptor.DESCRIPTOR.1 starting cursor honored — rows at/before cursor do not match; rows after the cursor can match",
    async () => {
      await runtime(
        Effect.gen(function* () {
          // Append three source rows; capture the offset of the first.
          // findFirst (via fromDurableStream({ cursor })) reads
          // strictly past the cursor.
          const sourceBound = DurableStream.define({
            endpoint: { url: sourceStreamUrl },
            schema: SourceFact,
          })
          const { offset: oA } = yield* sourceBound.append({
            sequence: 0,
            text: "alpha",
          })
          yield* sourceBound.append({ sequence: 1, text: "beta" })
          yield* sourceBound.append({ sequence: 2, text: "gamma" })

          yield* appendWaitRequested(
            "wait:cursor-before",
            "test.text-equals",
            1,
            { text: "alpha" },
            { cursor: oA },
          )
          yield* appendWaitRequested(
            "wait:cursor-after",
            "test.text-equals",
            1,
            { text: "gamma" },
            { cursor: oA },
          )

          const result = yield* runEvaluator("evaluator:cursor")
          expect(result.processed).toBe(2)

          const rows = yield* readWaitRows()
          const failed = rows.filter((r) => r.type === "firegrid.wait.failed")
          const matched = rows.filter((r) => r.type === "firegrid.wait.matched")

          expect(failed).toHaveLength(1)
          if (failed[0]?.type === "firegrid.wait.failed") {
            expect(failed[0].waitId).toBe("wait:cursor-before")
            expect(failed[0].failure.reason).toBe("matcher-error")
          }

          expect(matched).toHaveLength(1)
          if (matched[0]?.type === "firegrid.wait.matched") {
            expect(matched[0].waitId).toBe("wait:cursor-after")
            expect(matched[0].match.matchedValue).toMatchObject({
              sequence: 2,
              text: "gamma",
            })
          }
        }),
      )
    },
  )
})
