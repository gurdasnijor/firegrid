import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  HostProgramGraph,
  HostPrograms,
  SubstrateHostBoot,
} from "../../index.ts"
import {
  createSubstrateStream,
  seedPendingProjectionMatch,
  startTestServer,
  stopTestServer,
  waitForCompletionState,
} from "./helpers.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

// launchable-substrate-host.HOST_PROCESS.4
// launchable-substrate-host.RUNTIME_COMPOSITION.2
// launchable-substrate-host.SCHEMA_OWNERSHIP.3
//
// A graph-driven projection-match subscriber uses a caller-owned
// evaluator function (whose closure carries any caller-owned event-
// plane definition shape it needs) to resolve a pending
// projection_match completion. Substrate's
// runProjectionMatchSubscriber remains the catch-up /
// terminalization primitive; substrate is not modified.
//
// The evaluator's closure is the schema-ownership boundary — the
// host substrate package never sees the caller-owned event-plane
// row schema. The trigger.description payload is opaque to substrate
// and only the evaluator interprets it.
describe("HostProgramGraph — projection-match subscriber via graph", () => {
  it("a caller-supplied evaluator resolves a pending projection_match completion through the graph runner", async () => {
    const streamUrl = await createSubstrateStream("graph-pm-match")
    const completionId = "c-pm-match"
    const description = { kind: "fake-permission", id: "tool-call-1" }
    await seedPendingProjectionMatch(streamUrl, completionId, description)

    // Caller-owned evaluator: looks at the trigger.description and
    // returns a synthetic match. In a real runtime this would
    // inspect the caller-owned event-plane projection (closed over
    // a caller-supplied EventPlane.define result).
    const evaluator = HostPrograms.projectionMatchSubscriber({
      evaluate: (_snapshot, trigger, _completion) =>
        Effect.succeed(
          (trigger.description as { kind?: string }).kind === "fake-permission"
            ? { kind: "match" as const, value: { granted: true } }
            : { kind: "no-match" as const },
        ),
    })

    const Graph = HostProgramGraph.define({
      name: "pm-match",
      layer: evaluator,
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const completion = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                completionId,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          expect(completion?.state).toBe("resolved")
          const r = completion?.result as
            | { matchedValue: { granted: boolean } }
            | undefined
          expect(r?.matchedValue.granted).toBe(true)
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              program: Graph,
            }),
          ),
        ),
      ),
    )
  })

  // launchable-substrate-host.HOST_PROCESS.4
  //
  // A no-match evaluator leaves the completion pending — the host
  // does not invent terminal authority and does not double-write
  // the row. Asserted by snapshotting after a non-trivial wait.
  it("a no-match evaluator leaves the projection_match completion pending", async () => {
    const streamUrl = await createSubstrateStream("graph-pm-nomatch")
    const completionId = "c-pm-nomatch"
    await seedPendingProjectionMatch(streamUrl, completionId, {
      kind: "never-matches",
    })

    const Graph = HostProgramGraph.define({
      name: "pm-nomatch",
      layer: HostPrograms.projectionMatchSubscriber({
        evaluate: () => Effect.succeed({ kind: "no-match" as const }),
      }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Wait long enough for the runner to scan multiple times.
          yield* Effect.sleep("400 millis")
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              program: Graph,
            }),
          ),
        ),
      ),
    )

    const finalState = await waitForCompletionState(
      streamUrl,
      completionId,
      (c) => c !== undefined,
      500,
    )
    expect(finalState?.state).toBe("pending")
  })

  // durable-subscribers.RESTART_SAFETY.1
  // launchable-substrate-host.HOST_PROCESS.4
  //
  // Graph-driven projection-match runners rebuild from durable state
  // on startup. A pending completion left unresolved by one host scope
  // is resolved by a later host scope with a matching evaluator.
  it("restarts from durable state and resolves a pending projection_match after a previous graph scope exits", async () => {
    const streamUrl = await createSubstrateStream("graph-pm-restart")
    const completionId = "c-pm-restart"
    await seedPendingProjectionMatch(streamUrl, completionId, {
      kind: "restart-permission",
    })

    const NoMatch = HostProgramGraph.define({
      name: "pm-restart-nomatch",
      layer: HostPrograms.projectionMatchSubscriber({
        evaluate: () => Effect.succeed({ kind: "no-match" as const }),
      }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.sleep("250 millis").pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              program: NoMatch,
            }),
          ),
        ),
      ),
    )

    const stillPending = await waitForCompletionState(
      streamUrl,
      completionId,
      (c) => c !== undefined,
      500,
    )
    expect(stillPending?.state).toBe("pending")

    const Match = HostProgramGraph.define({
      name: "pm-restart-match",
      layer: HostPrograms.projectionMatchSubscriber({
        evaluate: () =>
          Effect.succeed({
            kind: "match" as const,
            value: { restarted: true },
          }),
      }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const completion = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                completionId,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          expect(completion?.state).toBe("resolved")
          const r = completion?.result as
            | { matchedValue: { restarted: boolean } }
            | undefined
          expect(r?.matchedValue.restarted).toBe(true)
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              program: Match,
            }),
          ),
        ),
      ),
    )
  })
})
