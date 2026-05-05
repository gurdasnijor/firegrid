import { Effect, Exit, Layer, Ref, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Work, WorkClaimLive } from "../facade/work.ts"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"
import { DurableStream } from "@durable-streams/client"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

interface ToolInvocation {
  readonly invocationId: string
  readonly tool: string
  readonly input: unknown
}

// Domain-neutral substrate-shaped tool transport service stand-in. Substrate
// has no `tool` concept; this is the user's domain code preserved through the
// pipeline R channel (ergonomic-facade.CLAIMED_WORK_API.7,
// effect-native-api.OPERATOR_PROGRAMS.10).
import { Context } from "effect"
class FakeToolTransport extends Context.Tag("test/FakeToolTransport")<
  FakeToolTransport,
  {
    readonly invoke: (
      i: ToolInvocation,
    ) => Effect.Effect<{ readonly outputFor: string }>
  }
>() {}

const FakeToolTransportLive = Layer.succeed(FakeToolTransport, {
  invoke: (i) =>
    Effect.succeed({ outputFor: `${i.tool}:${(i.input as { x: number }).x}` }),
})

// ergonomic-facade.COMMON_USAGE_EXAMPLES.4
// ergonomic-facade.CLAIMED_WORK_API.1, .9
describe("ergonomic-facade.COMMON_USAGE_EXAMPLES.4 — tool execution via the Work pipeline", () => {
  it("Work.claimedBy + Work.perform + Work.recordOutcome composes with cross-cutting Effect.tap without semantic change", async () => {
    // We need a real stream URL for WorkClaim attempts (the claim layer is
    // backed by Durable Streams). Pre-create the stream.
    const url = freshStreamUrl("facade-tool-exec")
    await DurableStream.create({ url, contentType: "application/json" })

    const invocations: ReadonlyArray<ToolInvocation> = [
      { invocationId: "inv-1", tool: "search", input: { x: 1 } },
      { invocationId: "inv-2", tool: "search", input: { x: 2 } },
      { invocationId: "inv-3", tool: "search", input: { x: 3 } },
    ]

    const recordedRef = await Effect.runPromise(
      Ref.make<Array<{ id: string; out: { outputFor: string } | "fail" }>>([]),
    )

    const recorder = (
      i: ToolInvocation,
      exit: Exit.Exit<{ readonly outputFor: string }, unknown>,
    ) =>
      Ref.update(recordedRef, (a) => [
        ...a,
        Exit.match(exit, {
          onSuccess: (out) => ({ id: i.invocationId, out: out }),
          onFailure: () => ({ id: i.invocationId, out: "fail" as const }),
        }),
      ])

    const tappedCountsRef = await Effect.runPromise(Ref.make<number>(0))

    const program = Effect.scoped(
      Work.runScoped(
        Stream.fromIterable(invocations).pipe(
          // Cross-cutting layer mid-pipeline (ergonomic-facade.CLAIMED_WORK_API.9).
          Stream.tap(() => Ref.update(tappedCountsRef, (n) => n + 1)),
          Work.claimedBy<ToolInvocation>("operator-tool", (i) => i.invocationId),
          Work.perform((i) =>
            Effect.gen(function* () {
              const transport = yield* FakeToolTransport
              return yield* transport.invoke(i)
            }),
          ),
          Work.recordOutcome(recorder),
        ),
      ),
    )

    await Effect.runPromise(
      program.pipe(
        Effect.provide(WorkClaimLive({ streamUrl: url })),
        Effect.provide(FakeToolTransportLive),
      ),
    )

    const recorded = await Effect.runPromise(Ref.get(recordedRef))
    expect(recorded).toHaveLength(3)
    expect(recorded.map((r) => r.id).sort()).toEqual(["inv-1", "inv-2", "inv-3"])
    for (const r of recorded) {
      expect(r.out).not.toBe("fail")
      if (r.out !== "fail") {
        expect(r.out.outputFor.startsWith("search:")).toBe(true)
      }
    }
    const tappedCount = await Effect.runPromise(Ref.get(tappedCountsRef))
    expect(tappedCount).toBe(3)
  })
})
