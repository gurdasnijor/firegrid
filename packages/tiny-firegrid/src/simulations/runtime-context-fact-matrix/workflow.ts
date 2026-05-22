import type {
  FiregridHost,
} from "@firegrid/host-sdk"
import {
  Effect,
  Layer,
  Option,
} from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import {
  FactMatrixTable,
  factMatrixTableOptions,
  permissionKey,
  toolKey,
  type ContextStateRow,
  type FactRow,
  type RawOutputRow,
  type ResolutionRow,
} from "./resources.ts"

// A sparse fact to route to a context's subscriber. `contextId` is the routing
// key (C1): the runtime point-appends it under `${contextId}/${seq}` and then
// invokes ONLY that context's per-key handler.
interface IncomingFact {
  readonly contextId: string
  readonly seq: number
  readonly kind: FactRow["kind"]
  readonly opens?: "tool" | "permission"
  readonly toolUseId?: string
  readonly permissionRequestId?: string
  readonly body?: string
}

interface FactMatrixRuntime {
  // Route a sparse fact to the per-key subscriber. Appends the fact, then
  // drains that context's handler. Other contexts are untouched.
  readonly routeFact: (fact: IncomingFact) => Effect.Effect<ContextStateRow, unknown>
  // Append a dense raw TextChunk output row. UI/telemetry only — does NOT
  // invoke any subscriber. Proves noise rows cannot reach handler work.
  readonly appendRawOutput: (
    contextId: string,
    seq: number,
    text: string,
  ) => Effect.Effect<void, unknown>
  // Replay boundary for a context: reload from durable state and drain again.
  // Nothing in-memory survives — the only state is the durable row.
  readonly replayBoundary: (
    contextId: string,
    reason: string,
  ) => Effect.Effect<ContextStateRow, unknown>
  readonly durableRows: Effect.Effect<{
    readonly contexts: ReadonlyArray<ContextStateRow>
    readonly facts: ReadonlyArray<FactRow>
    readonly rawOutput: ReadonlyArray<RawOutputRow>
    readonly resolutions: ReadonlyArray<ResolutionRow>
  }, unknown>
}

const runtimeLatch = (() => {
  let resolveRuntime: (runtime: FactMatrixRuntime) => void = () => undefined
  const promise = new Promise<FactMatrixRuntime>((resolve) => {
    resolveRuntime = resolve
  })
  return { promise, resolve: resolveRuntime }
})()

export const factMatrixRuntime = runtimeLatch.promise

const now = (): string => new Date().toISOString()

const factKeyFor = (contextId: string, seq: number) => `${contextId}/${seq}`
const rawKeyFor = (contextId: string, seq: number) => `${contextId}/${seq}`

const without = (ids: ReadonlyArray<string>, id: string) =>
  ids.filter(existing => existing !== id)

const withId = (ids: ReadonlyArray<string>, id: string) =>
  (ids.includes(id) ? ids : [...ids, id])

const initialContextState = (contextId: string): ContextStateRow => ({
  contextId,
  status: "open",
  lastFactSeq: 0,
  pendingToolWaits: [],
  pendingPermissionWaits: [],
  earlyToolResults: [],
  earlyPermissionResponses: [],
  resolvedToolWaits: [],
  resolvedPermissionWaits: [],
  factHandlerInvocations: 0,
  denseOutputReads: 0,
  factReadCount: 0,
  reloadCount: 0,
  terminalCount: 0,
  updatedAt: now(),
})

// Reload subscriber state from the durable table. Every processing entry starts
// here; there is NO in-memory state threaded across replays.
const reloadContextState = (
  table: FactMatrixTable["Type"],
  contextId: string,
) =>
  table.contexts.get(contextId).pipe(
    Effect.map(Option.getOrElse(() => initialContextState(contextId))),
    Effect.map((state): ContextStateRow => ({
      ...state,
      reloadCount: state.reloadCount + 1,
    })),
    Effect.withSpan("firegrid.tiny_fact_matrix.reload", {
      kind: "internal",
      attributes: {
        "firegrid.tiny_fact_matrix.context_id": contextId,
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.3",
      },
    }),
  )

// Idempotent durable proof that a wait resolved, keyed by its correlation key.
const recordResolution = (
  table: FactMatrixTable["Type"],
  resolution: ResolutionRow,
) =>
  table.resolutions.insertOrGet(resolution).pipe(
    Effect.tap(result =>
      result._tag === "Inserted"
        ? Effect.annotateCurrentSpan({
          "firegrid.tiny_fact_matrix.resolution.key": resolution.resolutionKey,
          "firegrid.tiny_fact_matrix.resolution.matched_order":
            resolution.matchedOrder,
          "firegrid.tiny_fact_matrix.resolution.rendezvous_seq":
            resolution.rendezvousSeq,
        })
        : Effect.void,
    ),
    Effect.withSpan("firegrid.tiny_fact_matrix.wait_resolved", {
      kind: "producer",
      attributes: {
        "firegrid.tiny_fact_matrix.wait_kind": resolution.waitKind,
        "firegrid.tiny_fact_matrix.correlation_id": resolution.correlationId,
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.2",
      },
    }),
  )

// The reducer: (state, fact) -> newState. Pure routing by stable identity. No
// scan of the dense raw output table; no DurableDeferred; correlation strictly
// by domain id.
const applyFact = (
  table: FactMatrixTable["Type"],
  state: ContextStateRow,
  fact: FactRow,
): Effect.Effect<ContextStateRow, unknown> =>
  Effect.gen(function*() {
    switch (fact.kind) {
      case "input": {
        return { ...state, status: "working" as const }
      }
      case "output_transition": {
        if (fact.opens === "tool" && fact.toolUseId !== undefined) {
          const key = toolKey(fact.contextId, fact.toolUseId)
          // resolve_first: the tool result arrived (and was stashed) before
          // this opening transition. Match by id now.
          if (state.earlyToolResults.includes(key)) {
            yield* recordResolution(table, {
              resolutionKey: key,
              contextId: fact.contextId,
              waitKind: "tool",
              correlationId: fact.toolUseId,
              matchedOrder: "resolve_first",
              rendezvousSeq: fact.seq, // opening transition completes the match
              at: now(),
            })
            return {
              ...state,
              earlyToolResults: without(state.earlyToolResults, key),
              resolvedToolWaits: withId(state.resolvedToolWaits, key),
            }
          }
          return { ...state, pendingToolWaits: withId(state.pendingToolWaits, key) }
        }
        if (fact.opens === "permission" && fact.permissionRequestId !== undefined) {
          const key = permissionKey(fact.permissionRequestId)
          if (state.earlyPermissionResponses.includes(key)) {
            yield* recordResolution(table, {
              resolutionKey: key,
              contextId: fact.contextId,
              waitKind: "permission",
              correlationId: fact.permissionRequestId,
              matchedOrder: "resolve_first",
              rendezvousSeq: fact.seq,
              at: now(),
            })
            return {
              ...state,
              earlyPermissionResponses: without(state.earlyPermissionResponses, key),
              resolvedPermissionWaits: withId(state.resolvedPermissionWaits, key),
            }
          }
          return {
            ...state,
            pendingPermissionWaits: withId(state.pendingPermissionWaits, key),
          }
        }
        // A structural transition that opens no wait (e.g. turn marker).
        return state
      }
      case "tool_result": {
        if (fact.toolUseId === undefined) return state
        const key = toolKey(fact.contextId, fact.toolUseId)
        // open_first: the ToolUse transition is already pending. Match by id,
        // independent of how many other waits opened between.
        if (state.pendingToolWaits.includes(key)) {
          yield* recordResolution(table, {
            resolutionKey: key,
            contextId: fact.contextId,
            waitKind: "tool",
            correlationId: fact.toolUseId,
            matchedOrder: "open_first",
            rendezvousSeq: fact.seq,
            at: now(),
          })
          return {
            ...state,
            pendingToolWaits: without(state.pendingToolWaits, key),
            resolvedToolWaits: withId(state.resolvedToolWaits, key),
          }
        }
        // resolution arrived first — stash durably for the later transition.
        return { ...state, earlyToolResults: withId(state.earlyToolResults, key) }
      }
      case "permission_response": {
        if (fact.permissionRequestId === undefined) return state
        const key = permissionKey(fact.permissionRequestId)
        if (state.pendingPermissionWaits.includes(key)) {
          yield* recordResolution(table, {
            resolutionKey: key,
            contextId: fact.contextId,
            waitKind: "permission",
            correlationId: fact.permissionRequestId,
            matchedOrder: "open_first",
            rendezvousSeq: fact.seq,
            at: now(),
          })
          return {
            ...state,
            pendingPermissionWaits: without(state.pendingPermissionWaits, key),
            resolvedPermissionWaits: withId(state.resolvedPermissionWaits, key),
          }
        }
        return {
          ...state,
          earlyPermissionResponses: withId(state.earlyPermissionResponses, key),
        }
      }
      case "terminal": {
        // first-valid-terminal-wins: only the first terminal sets the result.
        // (Duplicate terminal facts dedupe at fact identity before they reach
        // here, so this guard is the second line of defense.)
        if (state.status === "complete") {
          return { ...state, terminalCount: state.terminalCount + 1 }
        }
        return {
          ...state,
          status: "complete" as const,
          terminalResult: fact.body,
          terminalCount: state.terminalCount + 1,
        }
      }
    }
  }).pipe(
    Effect.tap(next =>
      Effect.annotateCurrentSpan({
        "firegrid.tiny_fact_matrix.fact.kind": fact.kind,
        "firegrid.tiny_fact_matrix.fact.seq": fact.seq,
        "firegrid.tiny_fact_matrix.pending_tools": next.pendingToolWaits.length,
        "firegrid.tiny_fact_matrix.pending_permissions":
          next.pendingPermissionWaits.length,
      })),
    Effect.withSpan("firegrid.tiny_fact_matrix.handler.apply_fact", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": "RuntimeContextFactMatrixHandler",
        "firegrid.tiny_fact_matrix.context_id": fact.contextId,
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.3",
      },
    }),
  )

// Point-read the next sparse fact by sequence (no scan). This is the cursor:
// it reads `lastFactSeq + 1` by primary key and never re-walks <= lastFactSeq.
const nextFactForSequence = (
  table: FactMatrixTable["Type"],
  contextId: string,
  seq: number,
) =>
  table.facts.get(factKeyFor(contextId, seq)).pipe(Effect.map(Option.getOrUndefined))

// Drain contiguous pending sparse facts for ONE context. The handler is invoked
// once per sparse fact — never for raw output rows (which live in a table this
// function does not touch).
const drainFacts = (
  table: FactMatrixTable["Type"],
  state: ContextStateRow,
) =>
  Effect.gen(function*() {
    let current = state
    while (true) {
      const seq = current.lastFactSeq + 1
      const next = yield* nextFactForSequence(table, current.contextId, seq)
      const hit = next !== undefined
      current = { ...current, factReadCount: current.factReadCount + 1 }
      if (!hit) break
      const transitioned = yield* applyFact(table, current, next)
      current = {
        ...transitioned,
        lastFactSeq: next.seq,
        factHandlerInvocations: transitioned.factHandlerInvocations + 1,
      }
    }
    return current
  })

// One processing pass for a context: reload, drain by point cursor, persist.
const processContext = (
  table: FactMatrixTable["Type"],
  contextId: string,
) =>
  Effect.gen(function*() {
    const reloaded = yield* reloadContextState(table, contextId)
    const drained = yield* drainFacts(table, reloaded)
    const persisted: ContextStateRow = { ...drained, updatedAt: now() }
    yield* table.contexts.upsert(persisted)
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_fact_matrix.context_id": contextId,
      "firegrid.tiny_fact_matrix.last_fact_seq": persisted.lastFactSeq,
      "firegrid.tiny_fact_matrix.fact_handler_invocations":
        persisted.factHandlerInvocations,
      "firegrid.tiny_fact_matrix.dense_output_reads": persisted.denseOutputReads,
      "firegrid.tiny_fact_matrix.reload_count": persisted.reloadCount,
      "firegrid.tiny_fact_matrix.status": persisted.status,
    })
    return persisted
  }).pipe(
    Effect.withSpan("firegrid.tiny_fact_matrix.process_context", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": "RuntimeContextFactMatrixSubscriber",
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.3",
      },
    }),
  )

// Append a sparse fact to the log, point-addressed by identity. insertOrGet
// converges a duplicate (same factKey) without producing a second handler pass.
const appendFact = (
  table: FactMatrixTable["Type"],
  fact: IncomingFact,
) =>
  table.facts.insertOrGet({
    factKey: factKeyFor(fact.contextId, fact.seq),
    contextId: fact.contextId,
    seq: fact.seq,
    kind: fact.kind,
    ...(fact.opens === undefined ? {} : { opens: fact.opens }),
    ...(fact.toolUseId === undefined ? {} : { toolUseId: fact.toolUseId }),
    ...(fact.permissionRequestId === undefined
      ? {}
      : { permissionRequestId: fact.permissionRequestId }),
    ...(fact.body === undefined ? {} : { body: fact.body }),
    appendedAt: now(),
  }).pipe(
    Effect.tap(result =>
      Effect.annotateCurrentSpan({
        "firegrid.tiny_fact_matrix.fact.insert_result": result._tag,
        "firegrid.tiny_fact_matrix.fact.kind": fact.kind,
        "firegrid.tiny_fact_matrix.context_id": fact.contextId,
      })),
    Effect.withSpan("firegrid.tiny_fact_matrix.fact_append", {
      kind: "producer",
      attributes: {
        "firegrid.tiny_fact_matrix.fact.seq": fact.seq,
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0_TARGET_REFERENCE.3",
      },
    }),
  )

const appendRawOutput = (
  table: FactMatrixTable["Type"],
  contextId: string,
  seq: number,
  text: string,
) =>
  table.rawOutput.insertOrGet({
    rawKey: rawKeyFor(contextId, seq),
    contextId,
    seq,
    text,
    appendedAt: now(),
  }).pipe(
    Effect.asVoid,
    Effect.withSpan("firegrid.tiny_fact_matrix.raw_output_append", {
      kind: "producer",
      attributes: {
        "firegrid.tiny_fact_matrix.context_id": contextId,
        "firegrid.tiny_fact_matrix.raw.seq": seq,
        // Deliberately NOT a fact: this append does not invoke any subscriber.
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0_TARGET_REFERENCE.3",
      },
    }),
  )

const runtimeFor = (
  table: FactMatrixTable["Type"],
): FactMatrixRuntime => ({
  routeFact: fact =>
    appendFact(table, fact).pipe(
      Effect.zipRight(processContext(table, fact.contextId)),
    ),
  appendRawOutput: (contextId, seq, text) =>
    appendRawOutput(table, contextId, seq, text),
  replayBoundary: (contextId, reason) =>
    processContext(table, contextId).pipe(
      Effect.tap(() =>
        Effect.annotateCurrentSpan({
          "firegrid.tiny_fact_matrix.replay_reason": reason,
        })),
      Effect.withSpan("firegrid.tiny_fact_matrix.replay_boundary", {
        kind: "internal",
        attributes: {
          "firegrid.tiny_fact_matrix.context_id": contextId,
          "firegrid-workflow-driven-runtime.ACID":
            "PHASE_0B_OUTPUT_RESULT_RETURN.3",
        },
      }),
    ),
  durableRows: Effect.gen(function*() {
    const contexts = yield* table.contexts.query(coll =>
      coll.toArray.sort((left, right) =>
        left.contextId.localeCompare(right.contextId)),
    )
    const facts = yield* table.facts.query(coll =>
      coll.toArray.sort((left, right) =>
        left.contextId.localeCompare(right.contextId) || left.seq - right.seq),
    )
    const rawOutput = yield* table.rawOutput.query(coll =>
      coll.toArray.sort((left, right) =>
        left.contextId.localeCompare(right.contextId) || left.seq - right.seq),
    )
    const resolutions = yield* table.resolutions.query(coll =>
      coll.toArray.sort((left, right) =>
        left.resolutionKey.localeCompare(right.resolutionKey)),
    )
    return { contexts, facts, rawOutput, resolutions }
  }),
})

export const runtimeContextFactMatrixHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  const tableLayer = FactMatrixTable.layer(factMatrixTableOptions(env))
  const workflowLayer = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* FactMatrixTable
      runtimeLatch.resolve(runtimeFor(table))
    }),
  )
  return workflowLayer.pipe(
    Layer.provide(tableLayer),
  ) as Layer.Layer<FiregridHost, unknown, never>
}
