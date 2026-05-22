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
  LoopStateTable,
  loopStateId,
  loopStateTableOptions,
  type LoopInputRow,
  type LoopOutputRow,
  type LoopStateRow,
} from "./resources.ts"

interface LoopStateRuntime {
  // Agent emits an output row (text / permission_request / turn_complete), then
  // the workflow drains.
  readonly emitOutput: (
    output: Pick<LoopOutputRow, "sequence" | "kind" | "permissionRequestId" | "body">,
  ) => Effect.Effect<LoopStateRow, unknown>
  // Client sends an input row (prompt / permission_response), then the workflow
  // drains.
  readonly sendInput: (
    input: Pick<LoopInputRow, "sequence" | "kind" | "permissionRequestId" | "body">,
  ) => Effect.Effect<LoopStateRow, unknown>
  // A replay boundary: reconstruct loop state from the table and drain again.
  // Nothing in-memory survives across this — the only state is the durable row.
  readonly replayBoundary: (reason: string) => Effect.Effect<LoopStateRow, unknown>
  readonly durableRows: Effect.Effect<{
    readonly loopState: LoopStateRow
    readonly inputs: ReadonlyArray<LoopInputRow>
    readonly outputs: ReadonlyArray<LoopOutputRow>
    readonly sentActions: ReadonlyArray<{
      readonly permissionRequestId: string
      readonly matchedOrder: "request_first" | "response_first"
    }>
  }, unknown>
}

const runtimeLatch = (() => {
  let resolveRuntime: (runtime: LoopStateRuntime) => void = () => undefined
  const promise = new Promise<LoopStateRuntime>((resolve) => {
    resolveRuntime = resolve
  })
  return { promise, resolve: resolveRuntime }
})()

export const loopStateRuntime = runtimeLatch.promise

const sessionId = loopStateId

const now = (): string => new Date().toISOString()

const inputKeyFor = (sequence: number) => `${sessionId}/${sequence}`
const outputKeyFor = (sequence: number) => `${sessionId}/${sequence}`
const actionKeyFor = (permissionRequestId: string) =>
  `${sessionId}/${permissionRequestId}`

const initialLoopState = (): LoopStateRow => ({
  loopStateId,
  sessionId,
  lastInputSequence: 0,
  lastOutputSequence: 0,
  pendingPermissionRequests: [],
  pendingPermissionResponses: [],
  processedInputCount: 0,
  processedOutputCount: 0,
  reloadCount: 0,
  outputReadCount: 0,
  outputHitCount: 0,
  consumedOutputSequences: [],
  updatedAt: now(),
})

// Reload loop state from the durable table. This is the crux: every processing
// entry reconstructs state from the table row — there is NO in-memory state
// threaded across replays and reset to `initial` (the runtime-context.ts
// pattern that forces the output re-walk).
const reloadLoopState = (
  table: LoopStateTable["Type"],
) =>
  table.loopState.get(loopStateId).pipe(
    Effect.map(Option.getOrElse(initialLoopState)),
    Effect.map((state): LoopStateRow => ({
      ...state,
      reloadCount: state.reloadCount + 1,
    })),
    Effect.withSpan("firegrid.tiny_loop_state.reload", {
      kind: "internal",
      attributes: {
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.3",
      },
    }),
  )

const without = (
  ids: ReadonlyArray<string>,
  id: string,
) => ids.filter(existing => existing !== id)

const withId = (
  ids: ReadonlyArray<string>,
  id: string,
) => (ids.includes(id) ? ids : [...ids, id])

// Record (idempotently) that a permission rendezvous matched and the response
// was sent to the agent.
const recordPermissionSent = (
  table: LoopStateTable["Type"],
  permissionRequestId: string,
  matchedOrder: "request_first" | "response_first",
) =>
  table.sentActions.insertOrGet({
    actionKey: actionKeyFor(permissionRequestId),
    sessionId,
    permissionRequestId,
    matchedOrder,
    at: now(),
  }).pipe(
    Effect.tap(result =>
      result._tag === "Inserted"
        ? Effect.annotateCurrentSpan({
          "firegrid.tiny_loop_state.permission.matched_order": matchedOrder,
        })
        : Effect.void,
    ),
    Effect.withSpan("firegrid.tiny_loop_state.permission.match", {
      kind: "producer",
      attributes: {
        "firegrid.tiny_loop_state.permission.request_id": permissionRequestId,
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.2",
      },
    }),
  )

// Output transition. permission_request rendezvous: if its response already
// arrived (durably stashed), match now (response_first); else record the
// pending request durably so a later response — even across a replay that
// SKIPS this output — still matches.
const applyOutputTransition = (
  table: LoopStateTable["Type"],
  state: LoopStateRow,
  output: LoopOutputRow,
) =>
  Effect.gen(function*() {
    if (output.kind !== "permission_request" || output.permissionRequestId === undefined) {
      return state
    }
    const requestId = output.permissionRequestId
    if (state.pendingPermissionResponses.includes(requestId)) {
      yield* recordPermissionSent(table, requestId, "response_first")
      return {
        ...state,
        pendingPermissionResponses: without(state.pendingPermissionResponses, requestId),
      }
    }
    return {
      ...state,
      pendingPermissionRequests: withId(state.pendingPermissionRequests, requestId),
    }
  })

// Input transition. permission_response rendezvous, mirror image.
const applyInputTransition = (
  table: LoopStateTable["Type"],
  state: LoopStateRow,
  input: LoopInputRow,
) =>
  Effect.gen(function*() {
    if (input.kind !== "permission_response" || input.permissionRequestId === undefined) {
      return state
    }
    const requestId = input.permissionRequestId
    if (state.pendingPermissionRequests.includes(requestId)) {
      yield* recordPermissionSent(table, requestId, "request_first")
      return {
        ...state,
        pendingPermissionRequests: without(state.pendingPermissionRequests, requestId),
      }
    }
    return {
      ...state,
      pendingPermissionResponses: withId(state.pendingPermissionResponses, requestId),
    }
  })

// Point-read the next input by sequence (no scan).
const nextInputForSequence = (
  table: LoopStateTable["Type"],
  sequence: number,
) =>
  table.inputs.get(inputKeyFor(sequence)).pipe(Effect.map(Option.getOrUndefined))

// Point-read the next output by sequence (no scan). This is the SKIP cursor:
// it reads `lastOutputSequence + 1` and never touches <= lastOutputSequence, so
// a replay does not re-walk output history.
const nextOutputForSequence = (
  table: LoopStateTable["Type"],
  sequence: number,
) =>
  table.outputs.get(outputKeyFor(sequence)).pipe(Effect.map(Option.getOrUndefined))

const drainInputs = (
  table: LoopStateTable["Type"],
  state: LoopStateRow,
) =>
  Effect.gen(function*() {
    let current = state
    while (true) {
      const next = yield* nextInputForSequence(table, current.lastInputSequence + 1)
      if (next === undefined) break
      const transitioned = yield* applyInputTransition(table, current, next)
      current = {
        ...transitioned,
        lastInputSequence: next.sequence,
        processedInputCount: transitioned.processedInputCount + 1,
      }
    }
    return current
  })

const drainOutputs = (
  table: LoopStateTable["Type"],
  state: LoopStateRow,
) =>
  Effect.gen(function*() {
    let current = state
    while (true) {
      const sequence = current.lastOutputSequence + 1
      const next = yield* nextOutputForSequence(table, sequence)
      const hit = next !== undefined
      yield* Effect.annotateCurrentSpan({
        "firegrid.tiny_loop_state.output.read_sequence": sequence,
        "firegrid.tiny_loop_state.output.read_hit": hit,
      })
      current = {
        ...current,
        outputReadCount: current.outputReadCount + 1,
      }
      if (!hit) break
      const transitioned = yield* applyOutputTransition(table, current, next)
      current = {
        ...transitioned,
        lastOutputSequence: next.sequence,
        processedOutputCount: transitioned.processedOutputCount + 1,
        outputHitCount: transitioned.outputHitCount + 1,
        consumedOutputSequences: [
          ...transitioned.consumedOutputSequences,
          next.sequence,
        ],
      }
    }
    return current
  }).pipe(
    Effect.withSpan("firegrid.tiny_loop_state.output.skip_cursor_drain", {
      kind: "internal",
      attributes: {
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.5",
      },
    }),
  )

// One processing pass: reload from table, drain inputs and outputs with point
// cursors, persist the row. Faithful to the SDD_TARGET "replay reconstructs
// progress from table state" model.
const processPending = (
  table: LoopStateTable["Type"],
) =>
  Effect.gen(function*() {
    const reloaded = yield* reloadLoopState(table)
    const afterInputs = yield* drainInputs(table, reloaded)
    const afterOutputs = yield* drainOutputs(table, afterInputs)
    const persisted: LoopStateRow = { ...afterOutputs, updatedAt: now() }
    yield* table.loopState.upsert(persisted)
    yield* Effect.annotateCurrentSpan({
      "firegrid.tiny_loop_state.last_input_sequence": persisted.lastInputSequence,
      "firegrid.tiny_loop_state.last_output_sequence": persisted.lastOutputSequence,
      "firegrid.tiny_loop_state.pending_requests":
        persisted.pendingPermissionRequests.length,
      "firegrid.tiny_loop_state.pending_responses":
        persisted.pendingPermissionResponses.length,
      "firegrid.tiny_loop_state.reload_count": persisted.reloadCount,
      "firegrid.tiny_loop_state.output_hit_count": persisted.outputHitCount,
    })
    return persisted
  }).pipe(
    Effect.withSpan("firegrid.tiny_loop_state.process_pending", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": "TinyLoopStateWorkflow",
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.3",
      },
    }),
  )

const appendOutput = (
  table: LoopStateTable["Type"],
  output: Pick<LoopOutputRow, "sequence" | "kind" | "permissionRequestId" | "body">,
) =>
  table.outputs.insertOrGet({
    outputKey: outputKeyFor(output.sequence),
    sessionId,
    sequence: output.sequence,
    kind: output.kind,
    ...(output.permissionRequestId === undefined
      ? {}
      : { permissionRequestId: output.permissionRequestId }),
    body: output.body,
    appendedAt: now(),
  }).pipe(
    Effect.withSpan("firegrid.tiny_loop_state.output_append", {
      kind: "producer",
      attributes: {
        "firegrid.tiny_loop_state.output.sequence": output.sequence,
        "firegrid.tiny_loop_state.output.kind": output.kind,
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0B_OUTPUT_RESULT_RETURN.1",
      },
    }),
  )

const appendInput = (
  table: LoopStateTable["Type"],
  input: Pick<LoopInputRow, "sequence" | "kind" | "permissionRequestId" | "body">,
) =>
  table.inputs.insertOrGet({
    inputKey: inputKeyFor(input.sequence),
    sessionId,
    sequence: input.sequence,
    kind: input.kind,
    ...(input.permissionRequestId === undefined
      ? {}
      : { permissionRequestId: input.permissionRequestId }),
    body: input.body,
    acceptedAt: now(),
  }).pipe(
    Effect.withSpan("firegrid.tiny_loop_state.input_append", {
      kind: "producer",
      attributes: {
        "firegrid.tiny_loop_state.input.sequence": input.sequence,
        "firegrid.tiny_loop_state.input.kind": input.kind,
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0_TARGET_REFERENCE.3",
      },
    }),
  )

const runtimeFor = (
  table: LoopStateTable["Type"],
): LoopStateRuntime => ({
  emitOutput: output =>
    appendOutput(table, output).pipe(Effect.zipRight(processPending(table))),
  sendInput: input =>
    appendInput(table, input).pipe(Effect.zipRight(processPending(table))),
  replayBoundary: reason =>
    processPending(table).pipe(
      Effect.tap(() =>
        Effect.annotateCurrentSpan({
          "firegrid.tiny_loop_state.replay_reason": reason,
        })),
      Effect.withSpan("firegrid.tiny_loop_state.replay_boundary", {
        kind: "internal",
        attributes: {
          "firegrid-workflow-driven-runtime.ACID":
            "PHASE_0B_OUTPUT_RESULT_RETURN.3",
        },
      }),
    ),
  durableRows: Effect.gen(function*() {
    const loopState = yield* table.loopState.get(loopStateId).pipe(
      Effect.map(Option.getOrElse(initialLoopState)),
    )
    const inputs = yield* table.inputs.query(coll =>
      coll.toArray.sort((left, right) => left.sequence - right.sequence),
    )
    const outputs = yield* table.outputs.query(coll =>
      coll.toArray.sort((left, right) => left.sequence - right.sequence),
    )
    const sentActions = yield* table.sentActions.query(coll =>
      coll.toArray.map(row => ({
        permissionRequestId: row.permissionRequestId,
        matchedOrder: row.matchedOrder,
      })),
    )
    return { loopState, inputs, outputs, sentActions }
  }),
})

export const loopStateTableHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  const tableLayer = LoopStateTable.layer(loopStateTableOptions(env))
  const workflowLayer = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* LoopStateTable
      runtimeLatch.resolve(runtimeFor(table))
    }),
  )
  return workflowLayer.pipe(
    Layer.provide(tableLayer),
  ) as Layer.Layer<FiregridHost, unknown, never>
}
