import { DurableStream } from "@durable-streams/client"
import { Chunk, Duration, Effect, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  Projection,
  ProjectionLive,
  type ProjectionQuery,
} from "../coordination/projection.ts"
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

// Domain-neutral substrate-shaped "pending decisions" view: the set of
// pending completions of a given kind. Stands in for a Fireline-like
// "pending required actions" view without naming permission/approval in
// substrate code (ergonomic-facade.API_BOUNDARY.1).
const pendingDecisionsQuery: ProjectionQuery<ReadonlyArray<string>> = {
  label: "pendingDecisions",
  evaluate: (snap) =>
    Effect.succeed(
      Array.from(snap.completions.values())
        .filter(
          (c) =>
            c.kind === "externally_resolved_awakeable" && c.state === "pending",
        )
        .map((c) => c.completionId)
        .sort(),
    ),
}

// Single-decision terminal observation.
const decisionTerminalQuery = (
  completionId: string,
): ProjectionQuery<CompletionValue | undefined> => ({
  label: `decisionTerminal(${completionId})`,
  evaluate: (snap) => Effect.succeed(snap.completions.get(completionId)),
})

const isResolved = (c: CompletionValue | undefined) =>
  c !== undefined && c.state === "resolved"

describe("ergonomic-facade.PROJECTION_API.3 — Projection.stream emits initial snapshot then each subsequent change", () => {
  it("yields snapshot once at acquire and one entry per appended pending completion (no polling tick)", async () => {
    const url = freshStreamUrl("facade-req-action-stream")
    // Start with one pending decision so the snapshot is non-empty.
    const c1 = createPendingCompletion({
      completionId: "decision-1",
      kind: "externally_resolved_awakeable",
    })
    await publishToStream(url, [c1])

    const program = Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* Projection
        const fiber = yield* Effect.fork(
          projection
            .stream(pendingDecisionsQuery)
            .pipe(Stream.take(3), Stream.runCollect),
        )
        // Append two more pending decisions after the stream is live; the
        // facade must observe each change without us polling.
        yield* Effect.sleep(Duration.millis(40))
        const stream = new DurableStream({ url, contentType: "application/json" })
        const c2 = createPendingCompletion({
          completionId: "decision-2",
          kind: "externally_resolved_awakeable",
        })
        const c3 = createPendingCompletion({
          completionId: "decision-3",
          kind: "externally_resolved_awakeable",
        })
        yield* Effect.tryPromise(() => stream.append(JSON.stringify(c2)))
        yield* Effect.sleep(Duration.millis(40))
        yield* Effect.tryPromise(() => stream.append(JSON.stringify(c3)))
        return yield* fiber
      }),
    )

    const chunks = await Effect.runPromise(
      program.pipe(Effect.provide(ProjectionLive({ streamUrl: url }))),
    )
    const arrays = Chunk.toReadonlyArray(chunks).map((arr) => [...arr])
    // First emission is the snapshot (one pre-existing decision). Subsequent
    // emissions reflect each appended decision. We do not assert exact ordering
    // beyond "monotonically grows toward the final 3-decision set" because
    // subscribeChanges may coalesce. ergonomic-facade.PROJECTION_API.3 wants
    // updates over time; not a polling cadence.
    expect(arrays.length).toBeGreaterThanOrEqual(2)
    expect(arrays[0]).toEqual(["decision-1"])
    expect(arrays[arrays.length - 1]).toEqual([
      "decision-1",
      "decision-2",
      "decision-3",
    ])
  })
})

describe("ergonomic-facade.COMMON_USAGE_EXAMPLES.2 — required-action approval flow uses Projection.stream + Projection.until", () => {
  it("stream surfaces the pending decision; until resolves the terminal once an external resolution is appended", async () => {
    const url = freshStreamUrl("facade-req-action-until")
    const completionId = "decision-approval"
    const pending = createPendingCompletion({
      completionId,
      kind: "externally_resolved_awakeable",
    })
    await publishToStream(url, [pending])

    const program = Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* Projection
        // Observe the pending set via Projection.stream (snapshot first).
        const observed = yield* projection
          .stream(pendingDecisionsQuery)
          .pipe(Stream.take(1), Stream.runCollect)
        const observedArrays = Chunk.toReadonlyArray(observed).map((a) => [...a])
        expect(observedArrays[0]).toEqual([completionId])

        // Wait on the terminal decision; resolve it after starting the wait.
        const fiber = yield* Effect.fork(
          projection.until(decisionTerminalQuery(completionId), isResolved, {
            timeout: Duration.seconds(5),
          }),
        )
        yield* Effect.sleep(Duration.millis(30))
        const stream = new DurableStream({ url, contentType: "application/json" })
        const resolved = resolveCompletion(pending.value as CompletionValue, {
          result: { decision: "approved", actorId: "user-42" },
        })
        yield* Effect.tryPromise(() => stream.append(JSON.stringify(resolved)))
        return yield* fiber
      }),
    )

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(ProjectionLive({ streamUrl: url }))),
    )
    expect(result?.state).toBe("resolved")
    expect(result?.result).toEqual({ decision: "approved", actorId: "user-42" })
  })
})
