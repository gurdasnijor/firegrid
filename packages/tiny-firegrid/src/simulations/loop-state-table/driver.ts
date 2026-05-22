import { Effect } from "effect"
import {
  loopStateRuntime,
} from "./workflow.ts"

interface LoopStateVerdict {
  readonly verdict: "GREEN"
  readonly distinctOutputs: number
  readonly outputHitCount: number
  readonly outputReadCount: number
  readonly reloadCount: number
  readonly permissionMatches: number
  readonly amplification: number
}

const isStrictlyIncreasingFrom1 = (
  sequences: ReadonlyArray<number>,
): boolean =>
  sequences.every((sequence, index) => sequence === index + 1)

export const loopStateTableDriver: Effect.Effect<LoopStateVerdict, unknown> =
  Effect.gen(function*() {
    const runtime = yield* Effect.promise(() => loopStateRuntime)

    // --- perm-A: request_first, with a replay between request and response ---
    yield* runtime.emitOutput({ sequence: 1, kind: "text", body: "verbose chunk 1" })
    yield* runtime.emitOutput({ sequence: 2, kind: "text", body: "verbose chunk 2" })
    yield* runtime.emitOutput({
      sequence: 3,
      kind: "permission_request",
      permissionRequestId: "perm-A",
      body: "allow tool perm-A?",
    })
    // Replay BEFORE the matching response arrives. A skip cursor resumes at
    // lastOutputSequence=3 and never re-walks 1..3 — yet pendingPermissionRequests
    // must still carry perm-A (durable state, not re-walked).
    yield* runtime.replayBoundary("after-perm-A-request")
    yield* runtime.sendInput({
      sequence: 1,
      kind: "permission_response",
      permissionRequestId: "perm-A",
      body: "approve perm-A",
    })

    // --- perm-B: response_first, with a replay between response and request ---
    yield* runtime.sendInput({
      sequence: 2,
      kind: "permission_response",
      permissionRequestId: "perm-B",
      body: "approve perm-B",
    })
    // Replay BEFORE the request output arrives. pendingPermissionResponses must
    // carry perm-B across the reload.
    yield* runtime.replayBoundary("after-perm-B-response")
    yield* runtime.emitOutput({
      sequence: 4,
      kind: "permission_request",
      permissionRequestId: "perm-B",
      body: "allow tool perm-B?",
    })
    yield* runtime.emitOutput({ sequence: 5, kind: "turn_complete", body: "done" })

    // Idempotent re-reload: nothing should change, no double-send.
    yield* runtime.replayBoundary("post-turn-complete")

    const durableRows = yield* runtime.durableRows
    const state = durableRows.loopState
    const distinctOutputs = durableRows.outputs.length
    const permissionMatches = durableRows.sentActions.length
    const amplification = distinctOutputs === 0
      ? 0
      : state.outputHitCount / distinctOutputs

    const matchById = new Map(
      durableRows.sentActions.map(action =>
        [action.permissionRequestId, action.matchedOrder] as const),
    )

    const noReWalk =
      isStrictlyIncreasingFrom1(state.consumedOutputSequences) &&
      state.consumedOutputSequences.length === distinctOutputs

    const permissionMatchingHeld =
      permissionMatches === 2 &&
      matchById.get("perm-A") === "request_first" &&
      matchById.get("perm-B") === "response_first" &&
      state.pendingPermissionRequests.length === 0 &&
      state.pendingPermissionResponses.length === 0

    const observationBounded =
      state.outputHitCount === distinctOutputs &&
      amplification === 1

    if (
      distinctOutputs !== 5 ||
      !observationBounded ||
      !noReWalk ||
      !permissionMatchingHeld ||
      state.reloadCount < 3
    ) {
      return yield* Effect.fail(new Error(
        `loop-state-table derisk failed: ${JSON.stringify({
          distinctOutputs,
          outputHitCount: state.outputHitCount,
          outputReadCount: state.outputReadCount,
          reloadCount: state.reloadCount,
          consumedOutputSequences: state.consumedOutputSequences,
          permissionMatches,
          matches: Object.fromEntries(matchById),
          pendingRequests: state.pendingPermissionRequests,
          pendingResponses: state.pendingPermissionResponses,
          observationBounded,
          noReWalk,
          permissionMatchingHeld,
        })}`,
      ))
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_loop_state.distinct_outputs": distinctOutputs,
      "firegrid.tiny_loop_state.output_hit_count": state.outputHitCount,
      "firegrid.tiny_loop_state.output_read_count": state.outputReadCount,
      "firegrid.tiny_loop_state.reload_count": state.reloadCount,
      "firegrid.tiny_loop_state.amplification": amplification,
      "firegrid.tiny_loop_state.permission_matches": permissionMatches,
      "firegrid.tiny_loop_state.no_rewalk": noReWalk,
      "firegrid.tiny_loop_state.permission_matching_held": permissionMatchingHeld,
      "firegrid-workflow-driven-runtime.ACID":
        "PHASE_0B_OUTPUT_RESULT_RETURN.2,PHASE_0B_OUTPUT_RESULT_RETURN.5",
    })

    return {
      verdict: "GREEN",
      distinctOutputs,
      outputHitCount: state.outputHitCount,
      outputReadCount: state.outputReadCount,
      reloadCount: state.reloadCount,
      permissionMatches,
      amplification,
    } satisfies LoopStateVerdict
  }).pipe(
    Effect.withSpan("firegrid.tiny_loop_state.verdict", {
      kind: "internal",
      attributes: {
        "firegrid.tiny_loop_state.scope":
          "durable-loop-state-skip-cursor-permission-rendezvous",
      },
    }),
  )
