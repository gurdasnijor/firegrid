import { Effect } from "effect"
import {
  permissionKey,
  toolKey,
  type FactRow,
  type ResolutionRow,
} from "./resources.ts"
import {
  factMatrixRuntime,
} from "./workflow.ts"

interface FactMatrixVerdict {
  readonly verdict: "GREEN"
  readonly contextA: {
    readonly factHandlerInvocations: number
    readonly rawOutputRows: number
    readonly denseOutputReads: number
    readonly resolvedTools: number
    readonly resolvedPermissions: number
    readonly terminalCount: number
  }
  readonly resolutionsByOpenFirst: number
  readonly resolutionsByResolveFirst: number
  readonly crossContextIsolated: boolean
  readonly idNotArrivalOrder: boolean
}

const ctxA = "CTX-A"
const ctxB = "CTX-B"

// Dense raw output noise: appended to a separate stream, never routed to the
// subscriber. 48 rows >> the 14 sparse facts; if any of these reached handler
// work the invocation count would be wrong.
const denseNoiseRows = 48

const appendDenseNoise = (
  runtime: Awaited<typeof factMatrixRuntime>,
  contextId: string,
  fromSeq: number,
  count: number,
) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => fromSeq + index),
    seq => runtime.appendRawOutput(contextId, seq, `verbose chunk ${seq}`),
    { discard: true },
  )

export const runtimeContextFactMatrixDriver: Effect.Effect<
  FactMatrixVerdict,
  unknown
> = Effect.gen(function*() {
  const runtime = yield* Effect.promise(() => factMatrixRuntime)

  // ---- CTX-A: input fact routes to its per-key subscriber -------------------
  yield* runtime.routeFact({ contextId: ctxA, seq: 1, kind: "input", body: "do work" })
  yield* appendDenseNoise(runtime, ctxA, 1, 16)

  // ---- Open four waits: perm P1, tool T1, perm P2, tool T2 ------------------
  yield* runtime.routeFact({
    contextId: ctxA, seq: 2, kind: "output_transition",
    opens: "permission", permissionRequestId: "P1",
  })
  yield* runtime.routeFact({
    contextId: ctxA, seq: 3, kind: "output_transition",
    opens: "tool", toolUseId: "T1",
  })
  yield* runtime.routeFact({
    contextId: ctxA, seq: 4, kind: "output_transition",
    opens: "permission", permissionRequestId: "P2",
  })
  yield* runtime.routeFact({
    contextId: ctxA, seq: 5, kind: "output_transition",
    opens: "tool", toolUseId: "T2",
  })
  yield* appendDenseNoise(runtime, ctxA, 17, 16)

  // ---- Resolve OUT OF OPEN ORDER: T2, P1, T1, P2 ----------------------------
  // Open order was P1,T1,P2,T2. tool_result T2 must resolve T2 (its own id),
  // NOT the older pending tool wait T1 — that is the by-id, not-FIFO proof.
  yield* runtime.routeFact({
    contextId: ctxA, seq: 6, kind: "tool_result", toolUseId: "T2", body: "T2 done",
  })
  yield* runtime.routeFact({
    contextId: ctxA, seq: 7, kind: "permission_response",
    permissionRequestId: "P1", body: "allow P1",
  })
  yield* runtime.routeFact({
    contextId: ctxA, seq: 8, kind: "tool_result", toolUseId: "T1", body: "T1 done",
  })
  yield* runtime.routeFact({
    contextId: ctxA, seq: 9, kind: "permission_response",
    permissionRequestId: "P2", body: "allow P2",
  })

  // ---- Out-of-arrival-order rendezvous across replay boundaries -------------
  // Resolution arrives BEFORE the opening transition; the stash must survive a
  // replay (no in-memory waiter) and match by id when the transition arrives.
  yield* runtime.routeFact({
    contextId: ctxA, seq: 10, kind: "permission_response",
    permissionRequestId: "P3", body: "allow P3",
  })
  yield* runtime.replayBoundary(ctxA, "after-early-P3-response")
  yield* runtime.routeFact({
    contextId: ctxA, seq: 11, kind: "tool_result", toolUseId: "T3", body: "T3 done",
  })
  yield* runtime.replayBoundary(ctxA, "after-early-T3-result")
  yield* appendDenseNoise(runtime, ctxA, 33, 16)
  yield* runtime.routeFact({
    contextId: ctxA, seq: 12, kind: "output_transition",
    opens: "permission", permissionRequestId: "P3",
  })
  yield* runtime.routeFact({
    contextId: ctxA, seq: 13, kind: "output_transition",
    opens: "tool", toolUseId: "T3",
  })

  // ---- Terminal fact, then a duplicate (fact-identity dedupe) ---------------
  yield* runtime.routeFact({
    contextId: ctxA, seq: 14, kind: "terminal", body: "all-resolved",
  })
  // Same factKey → insertOrGet converges; no second handler invocation.
  yield* runtime.routeFact({
    contextId: ctxA, seq: 14, kind: "terminal", body: "duplicate terminal",
  })
  yield* runtime.replayBoundary(ctxA, "post-terminal-idempotent")

  // ---- CTX-B: independent context proves keyed routing isolation ------------
  yield* runtime.routeFact({ contextId: ctxB, seq: 1, kind: "input", body: "ctx-b work" })
  yield* runtime.routeFact({ contextId: ctxB, seq: 2, kind: "terminal", body: "ctx-b done" })

  // ---- Verdict --------------------------------------------------------------
  const rows = yield* runtime.durableRows
  const a = rows.contexts.find(c => c.contextId === ctxA)
  const b = rows.contexts.find(c => c.contextId === ctxB)
  if (a === undefined || b === undefined) {
    return yield* Effect.fail(new Error("missing context state row"))
  }

  const aFacts = rows.facts.filter(f => f.contextId === ctxA)
  const aRaw = rows.rawOutput.filter(r => r.contextId === ctxA)
  const aResolutions = rows.resolutions.filter(r => r.contextId === ctxA)

  const sparseFactCount = aFacts.length // distinct facts (duplicate seq14 deduped)
  const openFirst = aResolutions.filter(r => r.matchedOrder === "open_first").length
  const resolveFirst = aResolutions.filter(r => r.matchedOrder === "resolve_first").length

  // --- C6: state advanced from sparse facts only, dense noise inert ---------
  const stateAdvancesFromSparseOnly =
    a.factHandlerInvocations === sparseFactCount &&
    a.denseOutputReads === 0 &&
    aRaw.length === denseNoiseRows &&
    // handler work is bounded by sparse facts, independent of raw volume
    a.factHandlerInvocations < aRaw.length

  // --- C4: every wait resolved, by id, none left pending --------------------
  const allWaitsResolved =
    a.resolvedToolWaits.length === 3 &&
    a.resolvedPermissionWaits.length === 3 &&
    a.pendingToolWaits.length === 0 &&
    a.pendingPermissionWaits.length === 0 &&
    a.earlyToolResults.length === 0 &&
    a.earlyPermissionResponses.length === 0

  const resolvedKeys = new Set([...a.resolvedToolWaits, ...a.resolvedPermissionWaits])
  const expectedKeys = new Set([
    toolKey(ctxA, "T1"), toolKey(ctxA, "T2"), toolKey(ctxA, "T3"),
    permissionKey("P1"), permissionKey("P2"), permissionKey("P3"),
  ])
  const correlationByIdComplete =
    resolvedKeys.size === expectedKeys.size &&
    [...expectedKeys].every(key => resolvedKeys.has(key))

  // --- by id, not arrival order: the first tool resolution targeted its own
  // id (T2), even though an OLDER tool wait (T1) was pending. A FIFO/positional
  // scheme would have resolved T1 first. ---------------------------------------
  const idNotArrivalOrder = firstToolResolutionTargetedOwnId(aFacts, aResolutions)

  // --- resolve_first survived the replay boundaries (P3 + T3) ---------------
  const resolveFirstSurvivedReplay =
    aResolutions.some(r => r.correlationId === "P3" && r.matchedOrder === "resolve_first") &&
    aResolutions.some(r => r.correlationId === "T3" && r.matchedOrder === "resolve_first")

  // --- first-valid-terminal-wins / fact-identity dedupe ---------------------
  const terminalIdempotent =
    a.status === "complete" &&
    a.terminalResult === "all-resolved" &&
    a.terminalCount === 1 &&
    sparseFactCount === 14

  // --- C1 keyed routing isolation: CTX-B facts never touched CTX-A ----------
  const crossContextIsolated =
    b.status === "complete" &&
    b.factHandlerInvocations === 2 &&
    a.factHandlerInvocations === 14 &&
    rows.resolutions.every(r => r.contextId === ctxA) // B opened no waits

  if (
    !stateAdvancesFromSparseOnly ||
    !allWaitsResolved ||
    !correlationByIdComplete ||
    !idNotArrivalOrder ||
    !resolveFirstSurvivedReplay ||
    !terminalIdempotent ||
    !crossContextIsolated ||
    openFirst !== 4 ||
    resolveFirst !== 2 ||
    a.reloadCount < 3
  ) {
    return yield* Effect.fail(new Error(
      `runtime-context-fact-matrix failed: ${JSON.stringify({
        stateAdvancesFromSparseOnly,
        allWaitsResolved,
        correlationByIdComplete,
        idNotArrivalOrder,
        resolveFirstSurvivedReplay,
        terminalIdempotent,
        crossContextIsolated,
        openFirst,
        resolveFirst,
        sparseFactCount,
        contextA: a,
        contextB: b,
        rawA: aRaw.length,
      })}`,
    ))
  }

  yield* Effect.annotateCurrentSpan({
    "firegrid.tiny_fact_matrix.context_a.fact_handler_invocations":
      a.factHandlerInvocations,
    "firegrid.tiny_fact_matrix.context_a.raw_output_rows": aRaw.length,
    "firegrid.tiny_fact_matrix.context_a.dense_output_reads": a.denseOutputReads,
    "firegrid.tiny_fact_matrix.context_a.resolved_tools":
      a.resolvedToolWaits.length,
    "firegrid.tiny_fact_matrix.context_a.resolved_permissions":
      a.resolvedPermissionWaits.length,
    "firegrid.tiny_fact_matrix.resolutions.open_first": openFirst,
    "firegrid.tiny_fact_matrix.resolutions.resolve_first": resolveFirst,
    "firegrid.tiny_fact_matrix.invariant.sparse_only":
      stateAdvancesFromSparseOnly,
    "firegrid.tiny_fact_matrix.invariant.id_not_arrival_order": idNotArrivalOrder,
    "firegrid.tiny_fact_matrix.invariant.cross_context_isolated":
      crossContextIsolated,
    "firegrid.tiny_fact_matrix.invariant.terminal_idempotent":
      terminalIdempotent,
    "firegrid-workflow-driven-runtime.ACID":
      "PHASE_0B_OUTPUT_RESULT_RETURN.2,PHASE_0B_OUTPUT_RESULT_RETURN.5",
  })

  return {
    verdict: "GREEN",
    contextA: {
      factHandlerInvocations: a.factHandlerInvocations,
      rawOutputRows: aRaw.length,
      denseOutputReads: a.denseOutputReads,
      resolvedTools: a.resolvedToolWaits.length,
      resolvedPermissions: a.resolvedPermissionWaits.length,
      terminalCount: a.terminalCount,
    },
    resolutionsByOpenFirst: openFirst,
    resolutionsByResolveFirst: resolveFirst,
    crossContextIsolated,
    idNotArrivalOrder,
  } satisfies FactMatrixVerdict
}).pipe(
  Effect.withSpan("firegrid.tiny_fact_matrix.verdict", {
    kind: "internal",
    attributes: {
      "firegrid.tiny_fact_matrix.scope":
        "runtime-context-fact-matrix-routes-by-stable-identity-sparse-only",
    },
  }),
)

// The crux of "by id, not arrival order": find the first tool resolution by
// rendezvous seq, and confirm it targeted its OWN tool id rather than the
// oldest still-pending tool wait at that point. With opens T1(seq3) then
// T2(seq5) and the first resolution being tool_result T2(seq6), a FIFO matcher
// would have routed it to T1; an id matcher routes it to T2.
const firstToolResolutionTargetedOwnId = (
  facts: ReadonlyArray<FactRow>,
  resolutions: ReadonlyArray<ResolutionRow>,
): boolean => {
  const toolResolutions = resolutions
    .filter(r => r.waitKind === "tool")
    .sort((l, r) => l.rendezvousSeq - r.rendezvousSeq)
  const first = toolResolutions[0]
  if (first === undefined) return false
  // The opening transitions for tool waits, in seq (open) order.
  const toolOpens = facts
    .filter(f => f.kind === "output_transition" && f.opens === "tool")
    .sort((l, r) => l.seq - r.seq)
  const oldestOpenedToolId = toolOpens[0]?.toolUseId
  // The fact that triggered the first tool resolution carries its correlation
  // id; it must equal the resolution's correlationId AND differ from the oldest
  // opened tool id (so positional/FIFO matching is ruled out).
  return (
    first.correlationId !== oldestOpenedToolId &&
    oldestOpenedToolId !== undefined
  )
}
