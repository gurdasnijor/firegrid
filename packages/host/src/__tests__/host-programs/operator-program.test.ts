import {
  blockRun,
  rebuildProjection,
  resolveCompletion,
  startRun,
  type CompletionValue,
  type RunValue,
} from "@durable-agent-substrate/substrate"
import { Effect, Layer } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  HostProgramGraph,
  HostPrograms,
  SubstrateHostBoot,
} from "../../index.js"
import {
  appendEvent,
  createSubstrateStream,
  seedPendingTimer,
  startTestServer,
  stopTestServer,
  waitForRunState,
} from "./helpers.js"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

async function seedReadyRun(
  streamUrl: string,
  runId: string,
  completionId: string,
): Promise<void> {
  // 1. pending timer with past dueAtMs
  await seedPendingTimer(streamUrl, completionId, Date.now() - 1000)
  // 2. resolve the completion (manually, so ready-work is derivable
  //    without actually running the timer subscriber here).
  const snap = await rebuildProjection({ url: streamUrl })
  const pending = snap.completions.get(completionId) as CompletionValue
  await appendEvent(streamUrl, resolveCompletion(pending, { result: { ok: true } }))
  // 3. started run with attached input.
  await appendEvent(
    streamUrl,
    startRun({ runId, data: { kind: "operator-test" } }),
  )
  // 4. block the run on the resolved completion → ready-work entry.
  const snap2 = await rebuildProjection({ url: streamUrl })
  const startedRun = snap2.runs.get(runId) as RunValue
  await appendEvent(
    streamUrl,
    blockRun(startedRun, { blockedOnCompletionId: completionId }),
  )
}

// launchable-substrate-host.HOST_PROCESS.5
// launchable-substrate-host.AUTHORITY_BOUNDARY.3
//
// A graph-driven operator program claims a ready-work item, runs
// the supplied handler, and terminalizes the run through the
// existing substrate processReadyWorkItem semantics. Substrate's
// claim/operator authority remains the source of truth; the host
// does not write a shadow row family. The launchable-substrate-host
// authority-boundary "Durable Streams and Durable State remain the
// source of truth" property is supported indirectly by the durable
// fold inspection below but is not directly claimed in this slice
// (the operator helper relies on substrate authority — that is what
// gets claimed).
describe("HostProgramGraph — operator program via graph", () => {
  it("an operator helper claims and runs a ready-work item, terminalizing through substrate authority", async () => {
    const streamUrl = await createSubstrateStream("graph-operator")
    const runId = "r-graph-operator"
    const completionId = "c-graph-operator"
    await seedReadyRun(streamUrl, runId, completionId)

    let handlerInvocations = 0
    const Graph = HostProgramGraph.define({
      name: "operator",
      layer: HostPrograms.operator({
        name: "demo-operator",
        handler: (item) => {
          handlerInvocations += 1
          return Effect.succeed({ runId: item.runId, kind: "completed" })
        },
      }),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const run = yield* Effect.tryPromise({
            try: () =>
              waitForRunState(
                streamUrl,
                runId,
                (r) => r !== undefined && r.state !== "blocked",
                3000,
              ),
            catch: (cause) => cause,
          })
          // Run terminalizes through substrate authority — state
          // moves out of "blocked" once the operator's handler
          // succeeds and processReadyWorkItem appends the
          // run-completed terminal record.
          expect(run?.state).toBe("completed")
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

    expect(handlerInvocations).toBe(1)

    // Snapshot: durable fold has exactly one terminal state for the
    // run id — the launchable-substrate-host authority-boundary
    // "host is not a second authority for runs / completions /
    // claims / event-plane rows" property holds.
    const finalSnap = await rebuildProjection({ url: streamUrl })
    expect(finalSnap.runs.get(runId)?.state).toBe("completed")
  })

  // The `select` filter lets multiple operator helpers coexist by
  // partitioning ready work without all racing every item. With two
  // operator helpers, each filtered to a different run id, only the
  // matching helper's handler is invoked for a given run.
  it("operator select filter routes ready-work items to the matching helper only", async () => {
    const streamUrl = await createSubstrateStream("graph-operator-select")
    const runA = "r-select-a"
    const runB = "r-select-b"
    await seedReadyRun(streamUrl, runA, "c-select-a")
    await seedReadyRun(streamUrl, runB, "c-select-b")

    let handlerA = 0
    let handlerB = 0
    const FinalGraph = HostProgramGraph.define({
      name: "operator-select-final",
      layer: Layer.mergeAll(
        HostPrograms.operator({
          name: "operator-a",
          select: (item) => item.runId === runA,
          handler: () =>
            Effect.sync(() => {
              handlerA += 1
            }),
        }),
        HostPrograms.operator({
          name: "operator-b",
          select: (item) => item.runId === runB,
          handler: () =>
            Effect.sync(() => {
              handlerB += 1
            }),
        }),
      ),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () =>
              waitForRunState(
                streamUrl,
                runA,
                (r) => r !== undefined && r.state === "completed",
                3000,
              ),
            catch: (cause) => cause,
          })
          yield* Effect.tryPromise({
            try: () =>
              waitForRunState(
                streamUrl,
                runB,
                (r) => r !== undefined && r.state === "completed",
                3000,
              ),
            catch: (cause) => cause,
          })
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl,
              program: FinalGraph,
            }),
          ),
        ),
      ),
    )

    expect(handlerA).toBe(1)
    expect(handlerB).toBe(1)
  })
})
