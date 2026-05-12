/**
 * Tracer 020 — Durable Fact Wait Descriptor.
 *
 * The wait evaluator is a composition of
 * `effect-durable-operators.DurableConsumer`, `ConsumerSource`, and
 * `ConsumerCheckpointStore` over `@firegrid/protocol/wait` request
 * rows with a host-owned named matcher table. There is no published
 * wait-specific operator module.
 *
 * Architecture and v0 contract: see
 * docs/tracers/020-durable-fact-wait-descriptor.md.
 *
 * Spec ACIDs covered:
 *   firegrid-durable-fact-wait-descriptor.{DESCRIPTOR.{1,2,3,4},
 *     EVALUATOR.{1,3,4,5,6,7}, AUTHORITY.{1,2,3}}
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
  ClaimPolicy,
  ConsumerCheckpointStoreLive,
  ConsumerSource,
  DurableConsumer,
} from "effect-durable-operators"
import { DurableStream } from "effect-durable-streams"
import { Effect, Option, Schema, Stream, type Scope } from "effect"
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

// ---------- host-owned matcher table ----------
//
// Plain `Record<"<id>@<version>", (row, params) => Option<output>>`.
// Matchers receive `unknown` rows and own their own decode, so the
// durable wait request carries no JS predicate code.

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
) =>
  DurableStream.define({
    endpoint: { url: waitStreamUrl },
    schema: Schema.Any,
  }).append(
    makeWaitRequestedRow({
      waitId,
      ownerId: "tracer-020",
      idempotencyKey: waitId,
      source: { streamUrl: sourceStreamUrl },
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

// ---------- evaluator (inline composition over existing primitives) ----------

const runEvaluator = (subscriberId: string) => {
  const outcomes = DurableStream.define({
    endpoint: { url: waitStreamUrl },
    schema: Schema.Unknown,
  })

  const appendFailed = (waitId: string, failure: WaitFailure) =>
    outcomes.append(makeWaitFailedRow({ waitId, failure }))

  const appendMatched = (req: WaitRequestedRow, matchedValue: unknown) => {
    const match: WaitMatch = {
      waitId: req.waitId,
      matcherId: req.matcherId,
      matcherVersion: req.matcherVersion,
      matchedAt: new Date().toISOString(),
      matchedValue,
    }
    return outcomes.append(makeWaitMatchedRow({ waitId: req.waitId, match }))
  }

  const handleWait = (req: WaitRequestedRow) =>
    Effect.gen(function* () {
      const matcher = matchers[`${req.matcherId}@${req.matcherVersion}`]
      if (matcher === undefined) {
        yield* appendFailed(req.waitId, { reason: "unknown-matcher" })
        return
      }
      const sourceBound = DurableStream.define({
        endpoint: { url: req.source.streamUrl },
        schema: Schema.Unknown,
      })
      const found = yield* Stream.runHead(
        sourceBound
          .read({ live: false })
          .pipe(Stream.filterMap((row) => matcher(row, req.matcherParams))),
      )
      yield* Option.match(found, {
        onNone: () => appendFailed(req.waitId, { reason: "matcher-error" }),
        onSome: (value) => appendMatched(req, value),
      })
    })

  return DurableConsumer.run({
    source: ConsumerSource.fromDurableStream(
      DurableStream.define({
        endpoint: { url: waitStreamUrl },
        schema: WaitRowSchema,
      }),
    ),
    checkpoint: { subscriberId },
    definition: DurableConsumer.define({
      name: "firegrid.wait.evaluator",
      select: (row: WaitRow) =>
        row.type === "firegrid.wait.requested"
          ? Option.some(row satisfies WaitRequestedRow)
          : Option.none(),
      key: (req: WaitRequestedRow) => req.waitId,
    }),
    policy: ClaimPolicy.AtMostOnce(),
    live: false,
    process: handleWait,
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
}

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
})
