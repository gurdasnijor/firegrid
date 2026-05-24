// runtime-context-session-workflow — Shape D proof for the per-
// (contextId, attempt) RuntimeContextSession lifecycle.
//
// The production diagnosis (Zed `AcpStdioEdgeTurnOutputError reason=agent_silent`
// repro'd on `firegrid run --prompt --agent claude-acp`) surfaced two
// interlocking races on the existing Shape C path:
//
//   1. RuntimeContextInputFacts.forContext() is a live tail
//      (`DurableTable.rows({includeInitialState: true})`). It emits each row
//      ONCE per subscription. The Shape C subscriber's `handle()` returns
//      silently when `runs.started` has not yet been written, and the row is
//      never re-delivered. Production callers (`bin/run.ts:executeRun` for
//      `--prompt`; Zed ACP edge) append the input intent BEFORE the start
//      workflow writes `runs.started` ⇒ initial input is lost.
//
//   2. `RuntimeContextWorkflowSessionAdapter.startOrAttach` reads the sessions
//      `Ref<Map>`, checks for the key, then writes — a TOCTOU. The control-
//      side-effect's `start` and the subscriber's `send → getOrStart → startOrAttach`
//      race concurrently. Live repro spawned 2 `claude-agent-acp` PIDs for one
//      context.
//
// Both races are symptoms of missing per-(contextId, activityAttempt) exclusive
// lifecycle ownership. Per `docs/cannon/architecture/runtime-design-constraints.md`
// §SDD Gate that's textbook Shape D:
//   - exclusive ownership of a per-key resource (one agent process per attempt),
//   - cross-execution handoff (start → many sends → terminate),
//   - restart-safe live side effect (re-binding the agent process across
//     subscriber re-materializations).
//
// `@effect/workflow` provides both fixes natively:
//   - per-execution-id atomic admission via `idempotencyKey` (kills race 2);
//   - `Workflow.suspend` + a kernel-owned write+arm (kwa) pattern on the input
//     fact table makes input intents durable wakeups, not live-tail-once rows
//     (kills race 1).
//
// This sim is the gate ahead of production: build a minimal but real
// per-(contextId, attempt) Workflow.make + Activity-memoized spawn + table-wait
// loop, drive three named probes, and report verdict before the production
// `RuntimeContextSessionWorkflow` lane lands.
//
// Probes (asserted in `./driver.ts`):
//   A. early-input-then-start
//      Append an input row BEFORE executing the workflow. Body must:
//        - spawn ONCE (Activity-memoized),
//        - consume the pre-existing input on its first loop pass.
//   B. concurrent-execute-no-dual-spawn
//      Two concurrent `Workflow.execute(payload)` with the SAME payload (=
//      same idempotencyKey). Must collapse to ONE execution and ONE spawn.
//   C. post-start-input-in-order
//      Execute first; body suspends with no input. Then kernel write+arm
//      delivers three inputs in order. Body must consume them in append
//      order, each via a single Activity send, with spawn STILL == 1.
//
// Boundaries:
//   - Real `DurableStreamsWorkflowEngine` over `effect-durable-operators`
//     DurableTable, identical to production primitives.
//   - "Session adapter" is an in-memory recording stand-in (a Ref<{spawnCount,
//     sends: Array}>) bound by `Layer.scoped`. It mirrors the contract of the
//     production codec adapter: `spawn` is called once per attempt; `send`
//     accepts one command at a time.
//   - No new runner, queue, or substrate. The pattern is `Workflow.make` +
//     `Activity.make` + a kwa-style "write+arm" controller — same primitives
//     as `kernel-owned-write-arm` / `input-suspend-crash-recovery`.

import {
  Activity,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
  type WorkflowEngineTableService,
} from "@firegrid/runtime/workflow-engine"
import {
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect"
import { DurableTable } from "effect-durable-operators"

const now = (): string => new Date().toISOString()

// ── Recording session adapter (the test stand-in for the production codec) ──
//
// The production codec adapter spawns one agent process per (contextId,
// attempt) on its first `startOrAttach`, then accepts `send` commands. The
// proof's stand-in records every spawn + send invocation so we can assert:
//   - spawn count == 1 per attempt (kills race 2 if the workflow's
//     Activity-memoization holds),
//   - send order == input append order,
//   - the FIRST send carries the EARLIEST appended input (probe A),
//   - no send fires before its corresponding input is consumed (probe C).

interface RecordingSession {
  readonly key: string
  readonly spawnedAt: string
}

interface RecordingSend {
  readonly key: string
  readonly inputId: string
  readonly value: string
  readonly sentAt: string
}

export interface RecordingState {
  readonly spawns: ReadonlyArray<RecordingSession>
  readonly sends: ReadonlyArray<RecordingSend>
}

export class RecordingSessionAdapter extends Context.Tag(
  "firegrid.rcsw.RecordingSessionAdapter",
)<RecordingSessionAdapter, Ref.Ref<RecordingState>>() {}

export const recordingSessionAdapterLayer: Layer.Layer<RecordingSessionAdapter> =
  Layer.effect(
    RecordingSessionAdapter,
    Ref.make<RecordingState>({ spawns: [], sends: [] }),
  )

const sessionKeyFor = (
  contextId: string,
  activityAttempt: number,
): string => `${contextId}:${activityAttempt}`

// Activity body: the codec spawn surface (single process per attempt).
const spawnActivity = (key: string) =>
  Effect.gen(function*() {
    const ref = yield* RecordingSessionAdapter
    yield* Ref.update(ref, (state) => ({
      ...state,
      spawns: [...state.spawns, { key, spawnedAt: now() }],
    }))
  }).pipe(
    Effect.withSpan("firegrid.rcsw.session.spawn", {
      kind: "internal",
      attributes: { "firegrid.rcsw.session.key": key },
    }),
  )

// Activity body: the codec send surface (one command per call).
const sendActivity = (
  key: string,
  input: { readonly inputId: string; readonly value: string },
) =>
  Effect.gen(function*() {
    const ref = yield* RecordingSessionAdapter
    yield* Ref.update(ref, (state) => ({
      ...state,
      sends: [...state.sends, {
        key,
        inputId: input.inputId,
        value: input.value,
        sentAt: now(),
      }],
    }))
  }).pipe(
    Effect.withSpan("firegrid.rcsw.session.send", {
      kind: "internal",
      attributes: {
        "firegrid.rcsw.session.key": key,
        "firegrid.rcsw.input.id": input.inputId,
      },
    }),
  )

// ── Workflow-owned input table (point-keyed by (contextId, attempt, sequence)) ──
//
// Mirrors the production `RuntimeControlPlaneTable.inputIntents` shape but
// uses a sequence-keyed primary key so the body can point-`get` the next
// input by cursor (no live-tail). The kernel write+arm controller appends
// rows here; the body advances a `cursor` field on its state row.

const RcswInputRowSchema = Schema.Struct({
  inputKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  inputId: Schema.String,
  value: Schema.String,
}).annotations({
  identifier: "firegrid.rcsw.inputRow",
  title: "rcsw workflow-owned input row",
})

class RcswInputTable extends DurableTable("rcsw.input", {
  inputs: RcswInputRowSchema,
}) {}

const inputKeyFor = (
  contextId: string,
  activityAttempt: number,
  sequence: number,
): string => `${contextId}:${activityAttempt}:${sequence}`

// ── Kernel-owned write+arm controller (mirrors kwa contract) ─────────────────

const RcswWriteArmFactSchema = Schema.Struct({
  factKey: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  inputId: Schema.String,
  value: Schema.String,
  status: Schema.Literal("pending", "satisfied"),
}).annotations({
  identifier: "firegrid.rcsw.writeArmFact",
  title: "rcsw kernel-owned write+arm fact",
})

class RcswKernelTable extends DurableTable("rcsw.kernel", {
  facts: RcswWriteArmFactSchema,
}) {}

const factKeyFor = (
  executionId: string,
  sequence: number,
): string => `${executionId}|${sequence}`

// ── Workflow ─────────────────────────────────────────────────────────────────

export interface RcswPayload {
  readonly contextId: string
  readonly activityAttempt: number
  readonly expectedInputs: number
}

const RcswPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  expectedInputs: Schema.Number,
})

const RcswSuccessSchema = Schema.Struct({
  key: Schema.String,
  inputsConsumed: Schema.Number,
})

// Per-(contextId, activityAttempt) workflow. The `idempotencyKey` IS the
// atomic admission gate the production race needs: concurrent
// `Workflow.execute({contextId, activityAttempt, expectedInputs})` with the
// SAME payload collapse to one execution. Engine + activity memoization
// guarantee spawn-once even across retry / reconstruction.
export const RuntimeContextSessionWorkflow = Workflow.make({
  name: "rcsw-runtime-context-session-workflow",
  payload: RcswPayloadSchema,
  success: RcswSuccessSchema,
  idempotencyKey: (p) => sessionKeyFor(p.contextId, p.activityAttempt),
})

// Per-payload workflow body. The spawn Activity name is stable per attempt
// (executionId encodes the payload via idempotencyKey); the send Activity
// name is sequence-stamped so each input becomes its own memoized activity.
// Both Activity.make calls are constructed inside the body — that's how
// `wait-for-workflow` does it (cf. `tiny-firegrid/src/simulations/inv2-
// waitforworkflow/wait-for-workflow.ts:91`).
const sessionBodyFor = (payload: RcswPayload) =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const key = sessionKeyFor(payload.contextId, payload.activityAttempt)
    const inputs = yield* RcswInputTable

    // Spawn once per attempt. Activity memoization makes this idempotent
    // across retry/reconstruction — the engine writes the activity row on
    // first success and replays from it on every subsequent body
    // materialization.
    yield* Activity.make({
      name: `rcsw.session.spawn/${key}`,
      success: Schema.Void,
      execute: spawnActivity(key),
    })

    // Cursor-based input consumption. On miss → Workflow.suspend (no
    // DurableDeferred mailbox). The kernel write+arm controller (below)
    // re-arms via Workflow.resume.
    let consumed = 0
    let cursor = 0
    while (consumed < payload.expectedInputs) {
      const inputKey = inputKeyFor(payload.contextId, payload.activityAttempt, cursor)
      const row = yield* inputs.inputs.get(inputKey).pipe(Effect.orDie)
      if (Option.isNone(row)) {
        yield* Effect.annotateCurrentSpan({
          "firegrid.rcsw.body.decision": "suspend",
          "firegrid.rcsw.cursor": cursor,
        })
        yield* Workflow.suspend(instance)
        // Workflow.suspend returns never; the next line satisfies typing
        // but is unreachable. After resume the engine re-runs the body
        // from the start; activity memoization replays the already-
        // completed spawn + sends; the cursor re-derives from the
        // consumed count above.
        return yield* Effect.never
      }
      const input = row.value
      yield* Activity.make({
        name: `rcsw.session.send/${key}/${input.sequence}`,
        success: Schema.Void,
        execute: sendActivity(key, { inputId: input.inputId, value: input.value }),
      })
      consumed += 1
      cursor += 1
    }

    return { key, inputsConsumed: consumed }
  }).pipe(
    Effect.withSpan("firegrid.rcsw.body", {
      kind: "consumer",
      attributes: {
        "firegrid.rcsw.context_id": payload.contextId,
        "firegrid.rcsw.activity_attempt": payload.activityAttempt,
      },
    }),
    Effect.orDie,
  )

// ── Kernel write+arm controller (mirrors kwa shape) ─────────────────────────

export interface KernelServices {
  readonly engineTable: WorkflowEngineTableService
  readonly inputTable: RcswInputTable["Type"]
  readonly factTable: RcswKernelTable["Type"]
}

// Record-and-write (no arm yet) — models a crash between write and arm.
const kernelRecordAndWrite = (
  services: KernelServices,
  executionId: string,
  payload: RcswPayload,
  input: { readonly sequence: number; readonly inputId: string; readonly value: string },
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    yield* services.factTable.facts.insertOrGet({
      factKey: factKeyFor(executionId, input.sequence),
      executionId,
      contextId: payload.contextId,
      activityAttempt: payload.activityAttempt,
      sequence: input.sequence,
      inputId: input.inputId,
      value: input.value,
      status: "pending",
    })
    yield* services.inputTable.inputs.insertOrGet({
      inputKey: inputKeyFor(payload.contextId, payload.activityAttempt, input.sequence),
      contextId: payload.contextId,
      activityAttempt: payload.activityAttempt,
      sequence: input.sequence,
      inputId: input.inputId,
      value: input.value,
    })
  }).pipe(
    Effect.asVoid,
    Effect.withSpan("firegrid.rcsw.kernel.record_and_write", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.execution_id": executionId,
        "firegrid.rcsw.input.sequence": input.sequence,
      },
    }),
  )

const kernelArm = (
  executionId: string,
): Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine> =>
  RuntimeContextSessionWorkflow.resume(executionId).pipe(
    Effect.withSpan("firegrid.rcsw.kernel.arm", {
      kind: "internal",
      attributes: { "firegrid.workflow.execution_id": executionId },
    }),
  )

// Full write+arm step.
export const kernelWriteArm = (
  services: KernelServices,
  executionId: string,
  payload: RcswPayload,
  input: { readonly sequence: number; readonly inputId: string; readonly value: string },
): Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    yield* kernelRecordAndWrite(services, executionId, payload, input)
    yield* kernelArm(executionId)
  })

// ── Generation harness ──────────────────────────────────────────────────────

export interface GenerationUrls {
  readonly engineStreamUrl: string
  readonly inputStreamUrl: string
  readonly kernelStreamUrl: string
}

const inputTableLayerFor = (url: string) =>
  RcswInputTable.layer({
    streamOptions: { url, contentType: "application/json" },
    txTimeoutMs: 2_000,
  })

const kernelTableLayerFor = (url: string) =>
  RcswKernelTable.layer({
    streamOptions: { url, contentType: "application/json" },
    txTimeoutMs: 2_000,
  })

const engineLayerFor = (url: string) =>
  DurableStreamsWorkflowEngine.layer({ streamUrl: url })

export const runRcswGeneration = <A>(
  urls: GenerationUrls,
  recording: Layer.Layer<RecordingSessionAdapter>,
  program: (services: KernelServices) => Effect.Effect<A, unknown, WorkflowEngine.WorkflowEngine | RecordingSessionAdapter>,
): Effect.Effect<A, unknown> => {
  const inputLayer = inputTableLayerFor(urls.inputStreamUrl)
  const kernelLayer = kernelTableLayerFor(urls.kernelStreamUrl)
  const workflowLayer = RuntimeContextSessionWorkflow.toLayer((payload) =>
    sessionBodyFor(payload),
  ).pipe(
    Layer.provide(inputLayer),
  )
  const generationLayer = Layer.mergeAll(
    workflowLayer,
    inputLayer,
    kernelLayer,
  ).pipe(
    Layer.provideMerge(engineLayerFor(urls.engineStreamUrl)),
    Layer.provideMerge(recording),
  )
  return Effect.scoped(
    Effect.gen(function*() {
      const engineTable = yield* WorkflowEngineTable
      const inputTable = yield* RcswInputTable
      const factTable = yield* RcswKernelTable
      return yield* program({ engineTable, inputTable, factTable })
    }).pipe(
      Effect.provide(generationLayer),
    ),
  )
}
