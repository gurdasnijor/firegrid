# 003: Runtime Events To Permission Workflow

Date: 2026-05-08

Status: planned

Substrate:

- source data plane: retained `RuntimeJournalEventSchema` rows from tracer 001;
- projection output: scenario/product-owned permission State Protocol rows;
- durable wait: `@effect/workflow` on
  `@firegrid/runtime/Workflows.layerDurableStreams`;
- resolver primitive: `DurableDeferred` token resolution through the workflow
  engine.

This tracer starts after
[002: Runtime Events To Session State](./002-runtime-events-to-session-state.md).
Tracer 002 proved a retained runtime-output journal can be projected into a
session-shaped State Protocol stream. Tracer 003 uses the same source journal
for a different downstream consumer: a durable human-in-the-loop decision.

## Goal

Prove the smallest permission path from:

```txt
raw runtime-output data-plane event
```

to:

```txt
permission request projection + suspended workflow + durable decision result
```

This tracer proves that permission handling is a downstream consumer over the
data-plane journal, not a special case inside runtime launch, runtime context
control-plane state, or session materialization.

## Spec Anchors

- `firegrid-durable-launch-runtime-operator.STREAM_TRUTH_BOUNDARY.2`: runtime
  output producers append raw Durable Streams journal facts, not State Protocol
  changes.
- `firegrid-durable-launch-runtime-operator.STREAM_TRUTH_BOUNDARY.3`: downstream
  session, permission, trace, and product projections consume data-plane facts
  and may emit State Protocol changes to their own projection streams.
- `firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.1`: stdout runtime
  events are durably appended before downstream consumers observe provider
  content.
- `firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.5`: late consumers can
  read retained runtime-output events after the process exits.
- `firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.6`: runtime-output
  ordering uses the documented per-attempt sequence, not wall-clock time.
- `firegrid-durable-launch-runtime-operator.PRODUCT_NEUTRALITY.1`: Firegrid
  launch APIs do not define product permission semantics.
- `durable-records-and-projections.RECORDS.3`: stream position or a documented
  cursor is authoritative for replay order.
- `durable-records-and-projections.PROJECTIONS.1`: projections are rebuildable
  views derived from accepted durable records.
- `durable-records-and-projections.PROJECTIONS.6`: custom projections are
  materializer folds over durable records.
- `workflow-engine-durable-state.ENGINE.1`: workflow engine rows are persisted
  in Durable Streams State.
- `workflow-engine-durable-state.VALIDATION.2`: a `DurableDeferred` token can
  resolve a suspended workflow.

## Plane Boundary

```txt
runtime-output stream
  raw data-plane journal facts
  RuntimeJournalEventSchema
  no permission semantics

permission-state stream
  State Protocol projection rows
  scenario/product-owned permission request + decision view

permission-workflow stream
  @effect/workflow engine state
  execution/activity/deferred rows
```

The source stream remains raw. The permission projection stream is derived. The
workflow stream is engine-owned coordination state. These three roles must not
collapse into one service or one schema.

Firegrid still does not gain native `Permission`, `ToolCall`, `Prompt`, or
provider-specific row families. The permission rows in this tracer are
scenario/product-owned projection rows used to prove the pattern.

## Ground Truth APIs

The retained source rows are already defined under
`@firegrid/protocol/launch`:

```ts
import {
  compareRuntimeOutputOrder,
  isAfterRuntimeOutputCursor,
  RuntimeJournalEventSchema,
  type RuntimeEvent,
  type RuntimeOutputCursor,
} from "@firegrid/protocol/launch"
```

Runtime stdout rows are shaped as raw journal envelopes:

```ts
type RuntimeOutputStdoutJournalEvent = {
  readonly type: "firegrid.runtime.output.stdout"
  readonly id: string
  readonly at: string
  readonly event: RuntimeEvent
}

type RuntimeEvent = {
  readonly eventId: string
  readonly contextId: string
  readonly activityAttempt: number
  readonly sequence: number
  readonly source: "stdout"
  readonly format: "jsonl"
  readonly receivedAt: string
  readonly raw: string
}
```

Tracer 002 already exposes a retained source reader that can be reused:

```ts
import { readRuntimeJournal } from "@firegrid/runtime/data-plane/materialization"

const journal = yield* readRuntimeJournal({
  streamUrl: sourceRuntimeOutputStreamUrl,
  contextId,
})

const rows = journal.events
  .flatMap((event) =>
    event.type === "firegrid.runtime.output.stdout" ? [event.event] : []
  )
  .filter((row) => isAfterRuntimeOutputCursor(row, since))
  .sort(compareRuntimeOutputOrder)
```

The workflow engine is already exposed from `@firegrid/runtime/Workflows`:

```ts
import { layerDurableStreams } from "@firegrid/runtime/Workflows"
import { DurableDeferred, Workflow } from "@effect/workflow"
import { Effect, Layer, Schema } from "effect"
```

The existing DurableDeferred shape, proven by the workflow engine tests, is:

```ts
const Approval = DurableDeferred.make("approval", {
  success: Schema.Literal("approved", "denied"),
})

const ApprovalWorkflow = Workflow.make({
  name: "tracer-003-permission-decision",
  payload: Schema.Struct({
    permissionRequestId: Schema.String,
  }),
  success: Schema.Literal("approved", "denied"),
  idempotencyKey: ({ permissionRequestId }) => permissionRequestId,
})

const ApprovalWorkflowLayer = ApprovalWorkflow.toLayer(() =>
  Effect.gen(function* () {
    const token = yield* DurableDeferred.token(Approval)
    yield* writePermissionPending({ token })
    return yield* DurableDeferred.await(Approval)
  }),
)

const resolveApproval = (token: DurableDeferred.Token) =>
  DurableDeferred.succeed(Approval, {
    token,
    value: "approved" as const,
  })
```

The tracer should provide `ApprovalWorkflowLayer` with:

```ts
const LayerLive = ApprovalWorkflowLayer.pipe(
  Layer.provide(layerDurableStreams({ streamUrl: permissionWorkflowStreamUrl })),
)
```

## Permission Detection Contract

Detection is a pure fold over `RuntimeEvent`. It must not read live process
state, query the runtime control plane, or mutate projection state.

```ts
type PermissionDetectorFailure = {
  readonly sourceRuntimeEventId: string
  readonly reason: string
  readonly cause?: unknown
}

type PermissionRequestDraft = {
  readonly permissionRequestId: string
  readonly contextId: string
  readonly sourceRuntimeEventId: string
  readonly activityAttempt: number
  readonly sequence: number
  readonly requestedAt: string
  readonly summary: string
  readonly payload: unknown
}

type PermissionDetection =
  | { readonly _tag: "none" }
  | {
    readonly _tag: "request"
    readonly request: PermissionRequestDraft
  }
  | {
    readonly _tag: "failure"
    readonly failure: PermissionDetectorFailure
  }

type RuntimePermissionDetector = {
  readonly name: string
  readonly version: string
  readonly detect: (row: RuntimeEvent) => PermissionDetection
}
```

The first detector should be intentionally tiny. It can recognize one example
JSONL shape and ignore everything else:

```json
{"type":"permission_request","permissionId":"perm_1","summary":"Run deploy?","payload":{"command":"pnpm deploy"}}
```

That detector is a tracer fixture, not a Firegrid provider taxonomy. ACP,
Claude Code, Flamecast, or product-owned adapters can add their own detectors
later without changing the source journal or the workflow engine.

## Permission Projection

Tracer 003 needs a small State Protocol projection for permission UI and
resolver tests. Keep it scenario/product-owned; do not add permission rows to
runtime control-plane state.

Suggested v0 schema:

```ts
type PermissionRequestProjection = {
  readonly permissionRequestId: string
  readonly contextId: string
  readonly sourceRuntimeEventId: string
  readonly detectorName: string
  readonly detectorVersion: string
  readonly status: "pending" | "approved" | "denied"
  readonly summary: string
  readonly payload: unknown
  readonly deferredToken?: string
  readonly requestedAt: string
  readonly decidedAt?: string
}

type PermissionDecisionProjection = {
  readonly decisionId: string
  readonly permissionRequestId: string
  readonly contextId: string
  readonly decision: "approved" | "denied"
  readonly decidedAt: string
  readonly reason?: string
}
```

The projection stream should use State Protocol because clients need keyed,
queryable state: "which permission requests are pending for this context?" and
"what decision was recorded for this request?"

The source runtime-output stream must remain raw Durable Streams journal
events. Do not write `permissionStateSchema.*.upsert(...)` to the
runtime-output stream.

## Workflow Shape

The workflow is keyed by the detected permission request identity. Re-running
the retained detector over the same source row must execute the same workflow
execution, not create a second wait.

```ts
const PermissionDecision = DurableDeferred.make("permission-decision", {
  success: Schema.Struct({
    decision: Schema.Literal("approved", "denied"),
    reason: Schema.optional(Schema.String),
  }),
})

const PermissionDecisionWorkflow = Workflow.make({
  name: "tracer-003-permission-decision",
  payload: Schema.Struct({
    permissionRequestId: Schema.String,
    contextId: Schema.String,
    sourceRuntimeEventId: Schema.String,
  }),
  success: Schema.Struct({
    decision: Schema.Literal("approved", "denied"),
    reason: Schema.optional(Schema.String),
  }),
  idempotencyKey: ({ permissionRequestId }) => permissionRequestId,
})

const PermissionDecisionWorkflowLayer = PermissionDecisionWorkflow.toLayer(
  Effect.fn("PermissionDecisionWorkflow")(function* (input) {
    const token = yield* DurableDeferred.token(PermissionDecision)

    yield* permissionProjection.upsertPending({
      ...input,
      deferredToken: token,
    })

    const result = yield* DurableDeferred.await(PermissionDecision)

    yield* permissionProjection.upsertResolved({
      ...input,
      ...result,
    })

    yield* permissionDecisionJournal.append({
      ...input,
      ...result,
    })

    return result
  }),
)
```

`permissionProjection` and `permissionDecisionJournal` in the sketch above are
scenario/product-owned services. They should be thin wrappers over their own
projection or journal streams, not additions to runtime context control-plane
state.

The final `permissionDecisionJournal.append(...)` is the durable fact a later
stdin/session-delivery tracer can consume. Tracer 003 does not deliver the
decision to a live process.

## Runner Shape

The retained runner is analogous to tracer 002, but its output is workflow
execution plus permission projection rows instead of session projection rows:

```ts
type PermissionWorkflowSummary = {
  readonly rowsRead: number
  readonly requestsDetected: number
  readonly workflowsStarted: number
  readonly rowsIgnored: number
  readonly rowsFailed: number
  readonly failures: ReadonlyArray<PermissionDetectorFailure>
}

type RunPermissionWorkflowOptions = {
  readonly sourceRuntimeOutputStreamUrl: string
  readonly permissionWorkflowStreamUrl: string
  readonly permissionStateStreamUrl: string
  readonly contextId: string
  readonly detector: RuntimePermissionDetector
  readonly since?: RuntimeOutputCursor
}

const runPermissionWorkflow = Effect.fn("runPermissionWorkflow")(
  function* (options: RunPermissionWorkflowOptions) {
    const journal = yield* readRuntimeJournal({
      streamUrl: options.sourceRuntimeOutputStreamUrl,
      contextId: options.contextId,
    })

    const rows = journal.events
      .flatMap((event) =>
        event.type === "firegrid.runtime.output.stdout" ? [event.event] : []
      )
      .filter((row) => isAfterRuntimeOutputCursor(row, options.since))
      .sort(compareRuntimeOutputOrder)

    for (const row of rows) {
      const detected = options.detector.detect(row)
      if (detected._tag !== "request") continue

      yield* PermissionDecisionWorkflow.execute({
        permissionRequestId: detected.request.permissionRequestId,
        contextId: detected.request.contextId,
        sourceRuntimeEventId: detected.request.sourceRuntimeEventId,
      }, { discard: true })
    }
  },
)
```

This sketch shows the intended boundary, not final production code. The
implementation can use `Effect.reduce` rather than `for...of`, should return
`PermissionWorkflowSummary`, and should provide the workflow layer with
`layerDurableStreams({ streamUrl: permissionWorkflowStreamUrl })`.

## Minimum Path

1. Read retained `RuntimeJournalEventSchema` rows using `readRuntimeJournal`.
2. Select stdout `RuntimeEvent` rows for one `contextId`.
3. Order by `compareRuntimeOutputOrder` and filter by optional
   `RuntimeOutputCursor`.
4. Detect one permission-request-shaped example JSONL row with a pure
   `RuntimePermissionDetector`.
5. Execute `PermissionDecisionWorkflow` with
   `idempotencyKey: ({ permissionRequestId }) => permissionRequestId`.
6. Write a pending permission State Protocol row that includes the
   `DurableDeferred` token.
7. Suspend on `DurableDeferred.await`.
8. Resolve the token from a separate approval action with
   `DurableDeferred.succeed`.
9. Resume the workflow and write a resolved permission State Protocol row plus
   a durable decision journal row for a later delivery tracer.

## Acceptance

1. Given a runtime-output stream with one permission JSONL row and one unrelated
   stdout row, the runner detects exactly one permission request.
2. The workflow writes a pending permission row and then suspends without
   completing until the deferred token is resolved.
3. Resolving the deferred token through the workflow engine resumes the
   workflow and writes an approved or denied decision row.
4. Re-running the detector over retained source rows with the same detector
   version and permission request id does not create duplicate logical
   permission requests or duplicate workflow waits.
5. The runtime context workflow, runtime control-plane service, and runtime
   output writer do not parse permission payloads or import permission
   projection schemas.
6. The tracer does not deliver the decision to stdin or a provider transport;
   it only leaves a durable decision fact for the next tracer.

## Non-Goals

- No stdin delivery back into the running process.
- No provider-specific ACP, Claude Code, Codex, Cursor, Devin, or Flamecast
  permission taxonomy.
- No browser UI.
- No Firegrid-native permission package surface.
- No HTTP webhook or callback surface.
- No live subscriber loop or cursor persistence; cursor ownership remains with
  the caller for this tracer.
- No changes to tracer 001 runtime context control-plane state.
- No changes to tracer 002 session materialization.

## Invariants

1. **Raw source authority.** Permission requests are derived from durable
   runtime-output data-plane facts, not live callbacks or process handles.
2. **Projection boundary.** Permission State Protocol rows are written only to
   the permission projection stream, never to the runtime-output source stream.
3. **Workflow wait authority.** A pending projection row is observable state,
   but the durable wait authority is the workflow engine's deferred state.
4. **Idempotent request identity.** The permission workflow execution id is
   derived from the detected permission request id, so retained replays target
   the same workflow.
5. **No launch coupling.** Runtime launch and runtime context control-plane
   code do not know which runtime-output rows require human approval.
6. **Delivery is later.** A resolved permission decision is a durable fact for a
   future delivery tracer; it is not proof that a live process consumed the
   decision.

## Suggested File Placement

Keep permission-specific code out of runtime context and runtime output writer
modules. For the tracer implementation, prefer scenario-owned code first:

```txt
scenarios/firegrid/src/tracer-003/
  detector.ts
  permission-state.ts
  permission-workflow.ts
  runner.ts
```

If a shared Firegrid helper becomes justified later, it should be generic over
"runtime-output row -> workflow/deferred consumer" and should not export
permission-native vocabulary from `@firegrid/runtime`.

