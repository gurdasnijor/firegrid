import {
  RuntimeControlPlaneTable,
  RuntimeRunEventSchema,
  type RuntimeRunEventRow,
} from "@firegrid/protocol/launch"
import type {
  WorkflowActivityRow,
  WorkflowClockWakeupRow,
  WorkflowDeferredRow,
  WorkflowExecutionRow,
} from "@firegrid/runtime/workflow-engine"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import {
  ChannelRegistry,
  makeIngressChannel,
  makeChannelRegistry,
  makeChannelTarget,
  type ChannelRegistration,
} from "../../channel-registry.ts"
import {
  RuntimeContextCheckpointSource,
  type RuntimeContextWorkflowCheckpointHandle,
} from "../../runtime-context-workflow-runtime.ts"

export const SessionSelfLifecycleChannelTarget = makeChannelTarget("session.self.lifecycle")
export const SessionSelfCheckpointChannelTarget = makeChannelTarget("session.self.checkpoint")

export const SessionSelfLifecycleEventSchema = Schema.Struct({
  channel: Schema.Literal("session.self.lifecycle"),
  event: RuntimeRunEventSchema,
})
export type SessionSelfLifecycleEvent = Schema.Schema.Type<
  typeof SessionSelfLifecycleEventSchema
>

const SessionSelfCheckpointBaseSchema = {
  channel: Schema.Literal("session.self.checkpoint"),
  contextId: Schema.String,
  workflowName: Schema.String,
  executionId: Schema.String,
} as const

export const SessionSelfCheckpointEventSchema = Schema.Union(
  Schema.TaggedStruct("Execution", {
    ...SessionSelfCheckpointBaseSchema,
    suspended: Schema.Boolean,
    interrupted: Schema.Boolean,
    hasFinalResult: Schema.Boolean,
    hasCause: Schema.Boolean,
  }),
  Schema.TaggedStruct("Activity", {
    ...SessionSelfCheckpointBaseSchema,
    activityName: Schema.String,
    attempt: Schema.Number,
    hasResult: Schema.Boolean,
  }),
  Schema.TaggedStruct("Deferred", {
    ...SessionSelfCheckpointBaseSchema,
    deferredName: Schema.String,
    hasExit: Schema.Boolean,
  }),
  Schema.TaggedStruct("ClockWakeup", {
    ...SessionSelfCheckpointBaseSchema,
    clockName: Schema.String,
    deferredName: Schema.String,
    deadlineMs: Schema.Number,
    status: Schema.Literal("pending", "fired"),
  }),
)
export type SessionSelfCheckpointEvent = Schema.Schema.Type<
  typeof SessionSelfCheckpointEventSchema
>

const lifecycleEventFromRow = (
  row: RuntimeRunEventRow,
): SessionSelfLifecycleEvent => ({
  channel: "session.self.lifecycle",
  event: {
    runEventId: row.runEventId,
    contextId: row.contextId,
    activityAttempt: row.activityAttempt,
    status: row.status,
    at: row.at,
    provider: row.provider,
    ...(row.exitCode === undefined ? {} : { exitCode: row.exitCode }),
    ...(row.signal === undefined ? {} : { signal: row.signal }),
    ...(row.message === undefined ? {} : { message: row.message }),
  },
})

const executionCheckpoint = (
  contextId: string,
  row: WorkflowExecutionRow,
): SessionSelfCheckpointEvent => ({
  _tag: "Execution",
  channel: "session.self.checkpoint",
  contextId,
  workflowName: row.workflowName,
  executionId: row.executionId,
  suspended: row.suspended,
  interrupted: row.interrupted,
  hasFinalResult: row.finalResult !== undefined,
  hasCause: row.cause !== undefined,
})

const activityCheckpoint = (
  contextId: string,
  row: WorkflowActivityRow,
  workflowName: string,
): SessionSelfCheckpointEvent => ({
  _tag: "Activity",
  channel: "session.self.checkpoint",
  contextId,
  workflowName,
  executionId: row.executionId,
  activityName: row.activityName,
  attempt: row.attempt,
  hasResult: row.result !== undefined,
})

const deferredCheckpoint = (
  contextId: string,
  row: WorkflowDeferredRow,
): SessionSelfCheckpointEvent => ({
  _tag: "Deferred",
  channel: "session.self.checkpoint",
  contextId,
  workflowName: row.workflowName,
  executionId: row.executionId,
  deferredName: row.deferredName,
  hasExit: row.exit !== undefined,
})

const clockWakeupCheckpoint = (
  contextId: string,
  row: WorkflowClockWakeupRow,
): SessionSelfCheckpointEvent => ({
  _tag: "ClockWakeup",
  channel: "session.self.checkpoint",
  contextId,
  workflowName: row.workflowName,
  executionId: row.executionId,
  clockName: row.clockName,
  deferredName: row.deferredName,
  deadlineMs: row.deadlineMs,
  status: row.status,
})

const checkpointsForEngine = (
  handle: RuntimeContextWorkflowCheckpointHandle,
): Effect.Effect<ReadonlyArray<SessionSelfCheckpointEvent>, unknown> =>
  Effect.gen(function* () {
    const executionRows = yield* handle.table.executions.query(coll =>
      coll.toArray.filter(row => row.executionId === handle.executionId))
    const workflowNames = new Map(
      executionRows.map(row => [row.executionId, row.workflowName] as const),
    )
    const executions = executionRows.map(row =>
      executionCheckpoint(handle.context.contextId, row),
    )
    const [activities, deferreds, clockWakeups] = yield* Effect.all([
      handle.table.activities.query(coll =>
        coll.toArray
          .filter(row => row.executionId === handle.executionId)
          .map(row =>
            activityCheckpoint(
              handle.context.contextId,
              row,
              workflowNames.get(row.executionId) ?? "unknown",
            ),
          ),
      ),
      handle.table.deferreds.query(coll =>
        coll.toArray
          .filter(row => row.executionId === handle.executionId)
          .map(row => deferredCheckpoint(handle.context.contextId, row)),
      ),
      handle.table.clockWakeups.query(coll =>
        coll.toArray
          .filter(row => row.executionId === handle.executionId)
          .map(row => clockWakeupCheckpoint(handle.context.contextId, row)),
      ),
    ])
    return [
      ...executions,
      ...activities,
      ...deferreds,
      ...clockWakeups,
    ]
  })

const checkpointStreamForEngine = (
  handle: RuntimeContextWorkflowCheckpointHandle,
): Stream.Stream<SessionSelfCheckpointEvent, unknown, never> =>
  Stream.unwrap(
    checkpointsForEngine(handle).pipe(
      Effect.map(snapshot =>
        Stream.mergeAll([
          Stream.fromIterable(snapshot),
          handle.table.executions.rows().pipe(
            Stream.filter(row => row.executionId === handle.executionId),
            Stream.map(row => executionCheckpoint(handle.context.contextId, row)),
          ),
          handle.table.activities.rows().pipe(
            Stream.filter(row => row.executionId === handle.executionId),
            Stream.map(row =>
              activityCheckpoint(
                handle.context.contextId,
                row,
                snapshot.find(event =>
                  event._tag === "Execution" &&
                  event.executionId === row.executionId,
                )?.workflowName ?? "unknown",
              ),
            ),
          ),
          handle.table.deferreds.rows().pipe(
            Stream.filter(row => row.executionId === handle.executionId),
            Stream.map(row => deferredCheckpoint(handle.context.contextId, row)),
          ),
          handle.table.clockWakeups.rows().pipe(
            Stream.filter(row => row.executionId === handle.executionId),
            Stream.map(row => clockWakeupCheckpoint(handle.context.contextId, row)),
          ),
        ], { concurrency: "unbounded" }),
      ),
    ),
  )

const checkpointKey = (event: SessionSelfCheckpointEvent): string => {
  switch (event._tag) {
    case "Execution":
      return [
        event._tag,
        event.contextId,
        event.executionId,
        event.suspended,
        event.interrupted,
        event.hasFinalResult,
        event.hasCause,
      ].join(":")
    case "Activity":
      return [
        event._tag,
        event.contextId,
        event.executionId,
        event.activityName,
        event.attempt,
        event.hasResult,
      ].join(":")
    case "Deferred":
      return [
        event._tag,
        event.contextId,
        event.executionId,
        event.deferredName,
        event.hasExit,
      ].join(":")
    case "ClockWakeup":
      return [
        event._tag,
        event.contextId,
        event.executionId,
        event.clockName,
        event.deferredName,
        event.deadlineMs,
        event.status,
      ].join(":")
  }
}

const checkpointStream = (
  checkpoints: RuntimeContextCheckpointSource["Type"],
): Stream.Stream<SessionSelfCheckpointEvent, unknown, never> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const contextIds = yield* checkpoints.activeContextIds
      const streams = yield* Effect.forEach(contextIds, contextId =>
        checkpoints.get(contextId).pipe(
          Effect.map(Option.match({
            onNone: () => Stream.empty,
            onSome: checkpointStreamForEngine,
          })),
        ))
      return Stream.mergeAll(streams, { concurrency: "unbounded" })
    }),
  ).pipe(
    Stream.mapAccum(new Set<string>(), (seen, event) => {
      const key = checkpointKey(event)
      if (seen.has(key)) {
        return [seen, Option.none()]
      }
      const next = new Set(seen)
      next.add(key)
      return [next, Option.some(event)]
    }),
    Stream.filterMap(option => option),
    Stream.withSpan("firegrid.host.channel.session_self.checkpoint", {
      kind: "internal",
    }),
  )

export const makeSessionSelfChannels = (
  options: {
    readonly control: RuntimeControlPlaneTable["Type"]
    readonly checkpoints: RuntimeContextCheckpointSource["Type"]
  },
): ReadonlyArray<ChannelRegistration> => [
  // firegrid-agent-body-plan.SESSION_SELF.1
  makeIngressChannel({
    target: SessionSelfLifecycleChannelTarget,
    schema: SessionSelfLifecycleEventSchema,
    stream: options.control.runs.rows().pipe(
      Stream.map(lifecycleEventFromRow),
      Stream.withSpan("firegrid.host.channel.session_self.lifecycle", {
        kind: "internal",
      }),
    ),
  }),
  // firegrid-agent-body-plan.SESSION_SELF.2
  makeIngressChannel({
    target: SessionSelfCheckpointChannelTarget,
    schema: SessionSelfCheckpointEventSchema,
    stream: checkpointStream(options.checkpoints),
  }),
]

const appendDefaultChannels = (
  explicit: ReadonlyArray<ChannelRegistration>,
  defaults: ReadonlyArray<ChannelRegistration>,
): ReadonlyArray<ChannelRegistration> => {
  const explicitTargets = new Set(explicit.map(channel => channel.target))
  return [
    ...explicit,
    ...defaults.filter(channel => !explicitTargets.has(channel.target)),
  ]
}

const makeSessionSelfChannelRegistry = (
  registrations: ReadonlyArray<ChannelRegistration>,
): Effect.Effect<
  ChannelRegistry["Type"],
  never,
  RuntimeControlPlaneTable | RuntimeContextCheckpointSource
> =>
  Effect.context<RuntimeControlPlaneTable | RuntimeContextCheckpointSource>().pipe(
    Effect.map((context) => {
      const control = Context.get(context, RuntimeControlPlaneTable)
      const checkpoints = Context.get(context, RuntimeContextCheckpointSource)
      const defaults = makeSessionSelfChannels({ control, checkpoints })
      return makeChannelRegistry(appendDefaultChannels(registrations, defaults))
    }),
  )

export const SessionSelfChannelRegistryLive = (
  registrations: ReadonlyArray<ChannelRegistration> = [],
): Layer.Layer<
  ChannelRegistry,
  never,
  RuntimeControlPlaneTable | RuntimeContextCheckpointSource
> =>
  Layer.effect(
    ChannelRegistry,
    makeSessionSelfChannelRegistry(registrations),
  )
