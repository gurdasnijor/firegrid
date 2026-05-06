import { DurableStream } from "@durable-streams/client"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  Projection,
  ProjectionLive,
  ProjectionWaitTimeout,
  type ProjectionQuery,
} from "../facade/projection.ts"
import { createPendingCompletion, resolveCompletion } from "./state-machine-sync.ts"
import type { CompletionValue } from "../protocol/schema/rows.ts"
import {
  freshStreamUrl,
  publishToStream,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

// Domain-neutral substrate-shaped "terminal" view of one durable.completion.
// Stands in for a Fireline-like prompt terminal row without naming "prompt"
// in substrate code (ergonomic-facade.API_BOUNDARY.1).
const completionTerminalQuery = (
  completionId: string,
): ProjectionQuery<CompletionValue | undefined> => ({
  label: `completionTerminal(${completionId})`,
  evaluate: (snap) => Effect.succeed(snap.completions.get(completionId)),
})

const isTerminal = (c: CompletionValue | undefined) =>
  c !== undefined &&
  (c.state === "resolved" || c.state === "rejected" || c.state === "cancelled")

describe("ergonomic-facade.PROJECTION_API.4 — Projection.until snapshot-first resolves from pre-existing rows", () => {
  it("resolves from snapshot when the matching row already exists at acquire time", async () => {
    const url = freshStreamUrl("facade-prompt-snapshot-first")
    const completionId = "cmp-await-snap"
    const pending = createPendingCompletion({
      completionId,
      kind: "externally_resolved_awakeable",
    })
    const resolved = resolveCompletion(pending.value as CompletionValue, {
      result: { ok: true },
    })
    await publishToStream(url, [pending, resolved])

    const program = Effect.gen(function* () {
      const projection = yield* Projection
      return yield* projection.until(
        completionTerminalQuery(completionId),
        isTerminal,
        { timeout: Duration.seconds(2) },
      )
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(ProjectionLive({ streamUrl: url }))),
    )
    expect(result?.state).toBe("resolved")
    expect(result?.result).toEqual({ ok: true })
  })
})

describe("ergonomic-facade.PROJECTION_API.4 — Projection.until follows live changes after the snapshot boundary", () => {
  it("snapshot returns no match, then live append resolves the wait", async () => {
    const url = freshStreamUrl("facade-prompt-follow")
    const completionId = "cmp-await-follow"
    const pending = createPendingCompletion({
      completionId,
      kind: "externally_resolved_awakeable",
    })
    await publishToStream(url, [pending])

    const program = Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* Projection
        // Fork the wait first so we observe the snapshot (pending, not terminal).
        const fiber = yield* Effect.fork(
          projection.until(
            completionTerminalQuery(completionId),
            isTerminal,
            { timeout: Duration.seconds(5) },
          ),
        )
        // Append the resolution after the wait is live.
        yield* Effect.sleep(Duration.millis(50))
        const stream = new DurableStream({ url, contentType: "application/json" })
        const resolved = resolveCompletion(pending.value as CompletionValue, {
          result: { live: true },
        })
        yield* Effect.tryPromise(() =>
          stream.append(JSON.stringify(resolved)),
        )
        return yield* fiber
      }),
    )

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(ProjectionLive({ streamUrl: url }))),
    )
    expect(result?.state).toBe("resolved")
    expect(result?.result).toEqual({ live: true })
  })
})

describe("ergonomic-facade.PROJECTION_API.5 — Projection.until fails with ProjectionWaitTimeout on no match within timeout", () => {
  it("times out as a typed ProjectionWaitTimeout carrying the query label and elapsed Duration", async () => {
    const url = freshStreamUrl("facade-prompt-timeout")
    const completionId = "cmp-await-timeout"
    const pending = createPendingCompletion({
      completionId,
      kind: "externally_resolved_awakeable",
    })
    await publishToStream(url, [pending])

    const timeout = Duration.millis(150)
    const program = Effect.gen(function* () {
      const projection = yield* Projection
      return yield* projection.until(
        completionTerminalQuery(completionId),
        isTerminal,
        { timeout },
      )
    })

    const exit = await Effect.runPromise(
      Effect.exit(
        program.pipe(Effect.scoped, Effect.provide(ProjectionLive({ streamUrl: url }))),
      ),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failureOption = exit.cause._tag === "Fail" ? exit.cause.error : null
      expect(failureOption).toBeInstanceOf(ProjectionWaitTimeout)
      if (failureOption instanceof ProjectionWaitTimeout) {
        expect(failureOption.label).toBe(`completionTerminal(${completionId})`)
        expect(Duration.toMillis(failureOption.elapsed)).toBe(
          Duration.toMillis(timeout),
        )
      }
    }
  })
})

// effect-native-api.EFFECT_SERVICES.7
// ergonomic-facade.PROJECTION_API.6 — query dependency requirements are
// preserved in the returned Effect requirement channel.
class TerminalSchema extends Context.Tag("test/TerminalSchema")<
  TerminalSchema,
  Schema.Schema<{
    readonly completionId: string
    readonly state: "resolved" | "rejected" | "cancelled"
    readonly result: unknown
  }>
>() {}

describe("ergonomic-facade.PROJECTION_API.6 — Projection.until preserves query R requirements", () => {
  it("an evaluator that yields a Context service requires that service in the returned Effect", async () => {
    const url = freshStreamUrl("facade-prompt-deps")
    const completionId = "cmp-await-deps"
    const pending = createPendingCompletion({
      completionId,
      kind: "externally_resolved_awakeable",
    })
    const resolved = resolveCompletion(pending.value as CompletionValue, {
      result: 123,
    })
    await publishToStream(url, [pending, resolved])

    type Decoded = {
      readonly completionId: string
      readonly state: "resolved" | "rejected" | "cancelled"
      readonly result: unknown
    }
    const decodedQuery: ProjectionQuery<Decoded | undefined, never, TerminalSchema> = {
      label: `decoded(${completionId})`,
      evaluate: (snap) =>
        Effect.gen(function* () {
          const schema = yield* TerminalSchema
          const raw = snap.completions.get(completionId)
          if (raw === undefined || raw.state === "pending") return undefined
          return Schema.decodeUnknownSync(schema)({
            completionId: raw.completionId,
            state: raw.state,
            result: raw.result,
          })
        }),
    }

    const TerminalSchemaLive = Layer.succeed(
      TerminalSchema,
      Schema.Struct({
        completionId: Schema.String,
        state: Schema.Literal("resolved", "rejected", "cancelled"),
        result: Schema.Unknown,
      }),
    )

    const program = Effect.gen(function* () {
      const projection = yield* Projection
      return yield* projection.until(
        decodedQuery,
        (d): d is Decoded => d !== undefined,
        { timeout: Duration.seconds(2) },
      )
    })

    const decoded = await Effect.runPromise(
      program.pipe(
        Effect.scoped,
        Effect.provide(ProjectionLive({ streamUrl: url })),
        Effect.provide(TerminalSchemaLive),
      ),
    )
    expect(decoded?.completionId).toBe(completionId)
    expect(decoded?.state).toBe("resolved")
    expect(decoded?.result).toBe(123)
  })
})
