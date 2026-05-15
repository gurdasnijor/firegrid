import {
  RuntimeControlPlaneTable,
  RuntimeEventSchema,
  RuntimeLogLineSchema,
  RuntimeOutputTable,
  RuntimeRunEventSchema,
  RuntimeConfigSchema,
  durableStreamUrl,
  normalizeRuntimeIntent,
  type RuntimeConfig,
  type RuntimeEvent,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  RuntimeIngressInputRowSchema,
} from "@firegrid/protocol/runtime-ingress"
import {
  FiregridLocalHostLive,
  RuntimeObservationSourceNames,
  appendRuntimeIngress,
  insertLocalRuntimeContext,
  localProcessSpawnEnvFromHostEnv,
  startRuntime,
  type RuntimeHostTopologyOptions,
} from "@firegrid/runtime/runtime-host"
import {
  SourceCollections,
  sourceCollectionHandle,
} from "@firegrid/runtime/durable-tools"
import type { RuntimeEnvResolverPolicy } from "@firegrid/runtime/providers/sandboxes"
import {
  AgentOutputEventSchema,
  PermissionDecisionSchema,
  PermissionOptionSchema,
  type AgentOutputEvent,
} from "@firegrid/runtime/agent-io"
import { Clock, Duration, Effect, Either, Layer, Match, Option, Schema, Stream } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import {
  FactoryRunKeyStringSchema,
  factoryRunIdentityFor,
  permissionResolutionIdentityFor,
} from "./identity.ts"
import { buildPlannerPrompt } from "./prompts.ts"
import {
  DarkFactoryTable,
  DarkFactoryFactSchema,
  DarkFactoryRunSchema,
  DarkFactoryTriggerSchema,
  darkFactoryFactsSourceName,
  darkFactoryTableLayerOptions,
  type DarkFactoryFact,
  type DarkFactoryRun,
  type DarkFactoryRunStatus,
  type DarkFactoryTrigger,
} from "./tables.ts"

interface DarkFactoryHostConfig {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly headers?: DurableTableHeaders
  readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
}

export const AcceptFactoryTriggerOptionsSchema = Schema.Struct({
  trigger: DarkFactoryTriggerSchema,
  planner: RuntimeConfigSchema,
  providerCapabilities: Schema.optional(Schema.Array(Schema.String)),
})
export type AcceptFactoryTriggerOptions = Schema.Schema.Type<
  typeof AcceptFactoryTriggerOptionsSchema
>

export const AcceptFactoryTriggerResultSchema = Schema.Struct({
  fact: DarkFactoryFactSchema,
  factInserted: Schema.Boolean,
  run: DarkFactoryRunSchema,
  runInserted: Schema.Boolean,
  initialInputId: Schema.optional(Schema.String),
})
export type AcceptFactoryTriggerResult = Schema.Schema.Type<
  typeof AcceptFactoryTriggerResultSchema
>

export const FactoryPermissionRequestSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
  options: Schema.Array(PermissionOptionSchema),
  event: AgentOutputEventSchema,
})
export type FactoryPermissionRequest = Schema.Schema.Type<
  typeof FactoryPermissionRequestSchema
>

const FactoryPermissionObservationSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  _tag: Schema.Literal("PermissionRequest"),
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
  event: AgentOutputEventSchema,
})
type FactoryPermissionObservation = Schema.Schema.Type<
  typeof FactoryPermissionObservationSchema
>

export const FactoryRunStatusViewSchema = Schema.Struct({
  run: DarkFactoryRunSchema,
  facts: Schema.Array(DarkFactoryFactSchema),
  runtimeRuns: Schema.Array(RuntimeRunEventSchema),
  runtimeEvents: Schema.Array(RuntimeEventSchema),
  runtimeLogs: Schema.Array(RuntimeLogLineSchema),
  ingressInputs: Schema.Array(RuntimeIngressInputRowSchema),
  permissions: Schema.Array(FactoryPermissionRequestSchema),
})
export type FactoryRunStatusView = Schema.Schema.Type<
  typeof FactoryRunStatusViewSchema
>

export const PermissionResponseInputSchema = Schema.Struct({
  factoryRunKey: FactoryRunKeyStringSchema,
  contextId: Schema.String,
  permissionRequestId: Schema.String,
  decision: PermissionDecisionSchema,
  correlationId: Schema.optional(Schema.String),
})
export type PermissionResponseInput = Schema.Schema.Type<
  typeof PermissionResponseInputSchema
>

export const PermissionResponseResultSchema = Schema.Struct({
  fact: DarkFactoryFactSchema,
  input: RuntimeIngressInputRowSchema,
})
export type PermissionResponseResult = Schema.Schema.Type<
  typeof PermissionResponseResultSchema
>

export const FactoryPermissionWaitOptionsSchema = Schema.Struct({
  factoryRunKey: FactoryRunKeyStringSchema,
  afterSequence: Schema.optional(Schema.Number),
  timeoutMs: Schema.Number,
})
export type FactoryPermissionWaitOptions = Schema.Schema.Type<
  typeof FactoryPermissionWaitOptionsSchema
>

export const FactoryNextAgentOutputWaitOptionsSchema = Schema.Struct({
  factoryRunKey: FactoryRunKeyStringSchema,
  afterSequence: Schema.Number,
  timeoutMs: Schema.Number,
})
export type FactoryNextAgentOutputWaitOptions = Schema.Schema.Type<
  typeof FactoryNextAgentOutputWaitOptionsSchema
>

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

export const darkFactoryStreamUrl = (input: {
  readonly baseUrl: string
  readonly namespace: string
}): string =>
  durableStreamUrl(input.baseUrl, `${input.namespace}.darkFactory`)

export const DarkFactorySourcesLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const sources = yield* SourceCollections
    const table = yield* DarkFactoryTable
    yield* sources.register(
      sourceCollectionHandle(darkFactoryFactsSourceName, table.facts),
    )
  }),
)

export const DarkFactoryHostLive = (
  config: DarkFactoryHostConfig,
  envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>,
) => {
  const appTable = DarkFactoryTable.layer(darkFactoryTableLayerOptions({
    streamUrl: darkFactoryStreamUrl({
      baseUrl: config.durableStreamsBaseUrl,
      namespace: config.namespace,
    }),
    ...(config.headers === undefined ? {} : { headers: config.headers }),
  }))
  const host = FiregridLocalHostLive({
    durableStreamsBaseUrl: config.durableStreamsBaseUrl,
    namespace: config.namespace,
    input: true,
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    ...(config.localProcessEnv === undefined
      ? {}
      : { localProcessEnv: config.localProcessEnv }),
  }, envPolicy)
  return DarkFactorySourcesLive.pipe(
    Layer.provideMerge(appTable),
    Layer.provideMerge(host),
  )
}

export const localProcessEnvFromRecord = localProcessSpawnEnvFromHostEnv

const plannerIntent = (config: RuntimeConfig) =>
  normalizeRuntimeIntent({
    provider: "local-process",
    config,
  })

const acceptedFactFrom = (input: {
  readonly trigger: DarkFactoryTrigger
  readonly factoryRunKey: string
  readonly contextId: string
  readonly createdAt: string
}): DarkFactoryFact => ({
  factKey: [input.trigger.source, input.trigger.externalEventKey],
  source: input.trigger.source,
  externalEventKey: input.trigger.externalEventKey,
  externalEntityKey: input.trigger.externalEntityKey,
  eventType: input.trigger.eventType,
  factoryRunKey: input.factoryRunKey,
  contextId: input.contextId,
  ...(input.trigger.correlationId === undefined
    ? {}
    : { correlationId: input.trigger.correlationId }),
  createdAt: input.createdAt,
  payload: input.trigger.payload ?? input.trigger,
})

const runFrom = (input: {
  readonly trigger: DarkFactoryTrigger
  readonly factoryRunKey: string
  readonly subscriberId: string
  readonly contextId: string
  readonly createdAt: string
}): DarkFactoryRun => ({
  factoryRunKey: input.factoryRunKey,
  subscriberId: input.subscriberId,
  source: input.trigger.source,
  externalEntityKey: input.trigger.externalEntityKey,
  plannerContextId: input.contextId,
  acceptedFactKey: [input.trigger.source, input.trigger.externalEventKey],
  status: "accepted",
  createdAt: input.createdAt,
  updatedAt: input.createdAt,
  ...(input.trigger.correlationId === undefined
    ? {}
    : { correlationId: input.trigger.correlationId }),
  ...(input.trigger.repoHint === undefined ? {} : { repoHint: input.trigger.repoHint }),
  ...(input.trigger.linear?.issueId === undefined
    ? {}
    : { linearIssueId: input.trigger.linear.issueId }),
  ...(input.trigger.linear?.identifier === undefined
    ? {}
    : { linearIdentifier: input.trigger.linear.identifier }),
  ...(input.trigger.linear?.url === undefined
    ? {}
    : { linearUrl: input.trigger.linear.url }),
})

const upsertRunStatus = (
  run: DarkFactoryRun,
  status: DarkFactoryRunStatus,
  extra: Partial<Pick<
    DarkFactoryRun,
    "lastPermissionRequestId" | "lastRuntimeSequence"
  >> = {},
) =>
  Effect.gen(function* () {
    const table = yield* DarkFactoryTable
    const updatedAt = yield* nowIso
    const updated = {
      ...run,
      ...extra,
      status,
      updatedAt,
    }
    yield* table.runs.upsert(updated)
    return updated
  })

const appendInitialPlannerPrompt = (
  input: {
    readonly run: DarkFactoryRun
    readonly trigger: DarkFactoryTrigger
    readonly providerCapabilities: ReadonlyArray<string>
  },
) => {
  const inputId = `dark-factory:planner:${input.run.factoryRunKey}:initial`
  return appendRuntimeIngress({
    contextId: input.run.plannerContextId,
    inputId,
    kind: "message",
    authoredBy: "client",
    payload: buildPlannerPrompt(input),
    idempotencyKey: inputId,
    metadata: {
      factoryRunKey: input.run.factoryRunKey,
      source: input.run.source,
      subscriberId: input.run.subscriberId,
    },
  }).pipe(Effect.as(inputId))
}

export const acceptFactoryTrigger = (
  options: AcceptFactoryTriggerOptions,
): Effect.Effect<AcceptFactoryTriggerResult, unknown, unknown> =>
  Effect.gen(function* () {
    const decodedOptions = yield* Schema.decodeUnknown(AcceptFactoryTriggerOptionsSchema)(
      options,
    )
    const trigger = decodedOptions.trigger
    const planner = decodedOptions.planner
    const table = yield* DarkFactoryTable
    const createdAt = yield* nowIso
    const identity = factoryRunIdentityFor(trigger)
    const fact = acceptedFactFrom({
      trigger,
      factoryRunKey: identity.factoryRunKey,
      contextId: identity.plannerContextId,
      createdAt,
    })
    const factResult = yield* table.facts.insertOrGet(fact)
    const acceptedFact = Match.value(factResult).pipe(
      Match.tag("Inserted", () => fact),
      Match.tag("Found", ({ row }) => row),
      Match.exhaustive,
    )
    const initialRun = runFrom({
      trigger,
      factoryRunKey: identity.factoryRunKey,
      subscriberId: identity.subscriberId,
      contextId: identity.plannerContextId,
      createdAt,
    })
    const runResult = yield* table.runs.insertOrGet(initialRun)
    const run = Match.value(runResult).pipe(
      Match.tag("Inserted", () => initialRun),
      Match.tag("Found", ({ row }) => row),
      Match.exhaustive,
    )
    if (runResult._tag === "Found") {
      return {
        fact: acceptedFact,
        factInserted: factResult._tag === "Inserted",
        run,
        runInserted: false,
      }
    }

    // firegrid-dark-factory-app.PLATFORM_PRIMITIVES.1
    // firegrid-dark-factory-app.AUTONOMOUS_RUN.1
    yield* insertLocalRuntimeContext(plannerIntent(planner), {
      contextId: run.plannerContextId,
      createdBy: `dark-factory:${run.factoryRunKey}`,
    })
    const initialInputId = yield* appendInitialPlannerPrompt({
      run,
      trigger,
      providerCapabilities: decodedOptions.providerCapabilities ?? [],
    })
    return {
      fact: acceptedFact,
      factInserted: factResult._tag === "Inserted",
      run,
      runInserted: true,
      initialInputId,
    }
  })

export const startFactoryPlanner = (
  run: DarkFactoryRun,
) =>
  Effect.gen(function* () {
    yield* upsertRunStatus(run, "planner_started")
    return yield* startRuntime({ contextId: run.plannerContextId })
  })

export const acceptAndStartFactoryTrigger = (
  options: AcceptFactoryTriggerOptions,
): Effect.Effect<AcceptFactoryTriggerResult, unknown, unknown> =>
  Effect.gen(function* () {
    const accepted = yield* acceptFactoryTrigger(options)
    if (accepted.runInserted) {
      yield* startFactoryPlanner(accepted.run).pipe(
        Effect.catchAll(() => upsertRunStatus(accepted.run, "failed")),
        Effect.fork,
      )
    }
    return accepted
  })

const decodeAgentOutputWrapper = (
  row: RuntimeEvent,
): AgentOutputEvent | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const record = parsed as { readonly type?: unknown; readonly event?: unknown }
  if (record.type !== "firegrid.agent-output") return undefined
  const decoded = Schema.decodeUnknownEither(AgentOutputEventSchema)(record.event)
  return Either.isRight(decoded) ? decoded.right : undefined
}

const permissionFromRow = (
  row: RuntimeEvent,
): FactoryPermissionRequest | undefined => {
  const event = decodeAgentOutputWrapper(row)
  if (event?._tag !== "PermissionRequest") return undefined
  return {
    contextId: row.contextId,
    activityAttempt: row.activityAttempt,
    sequence: row.sequence,
    permissionRequestId: event.permissionRequestId,
    toolUseId: event.toolUseId,
    options: event.options,
    event,
  }
}

const permissionFromObservation = (
  row: unknown,
): Option.Option<FactoryPermissionRequest> => {
  const decoded = Schema.decodeUnknownEither(FactoryPermissionObservationSchema)(row)
  if (Either.isLeft(decoded)) return Option.none()
  const observation: FactoryPermissionObservation = decoded.right
  if (observation.event._tag !== "PermissionRequest") return Option.none()
  return Option.some({
    contextId: observation.contextId,
    activityAttempt: observation.activityAttempt,
    sequence: observation.sequence,
    permissionRequestId: observation.permissionRequestId,
    toolUseId: observation.toolUseId,
    options: observation.event.options,
    event: observation.event,
  })
}

const sortRuntimeEvents = <Row extends { readonly sequence: number }>(
  rows: ReadonlyArray<Row>,
): ReadonlyArray<Row> =>
  [...rows].sort((left, right) => left.sequence - right.sequence)

export const readFactoryRunStatus = (
  factoryRunKey: string,
): Effect.Effect<FactoryRunStatusView, unknown, unknown> =>
  Effect.gen(function* () {
    const table = yield* DarkFactoryTable
    const runOption = yield* table.runs.get(factoryRunKey)
    const run = yield* Option.match(runOption, {
      onNone: () =>
        Effect.fail(new Error(`factory run not found: ${factoryRunKey}`)),
      onSome: Effect.succeed,
    })
    const facts = yield* table.facts.query(coll =>
      coll.toArray
        .filter(row =>
          row.factoryRunKey === factoryRunKey ||
          row.externalEntityKey === run.externalEntityKey)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)))
    const control = yield* RuntimeControlPlaneTable
    const runtimeRuns = yield* control.runs.query(coll =>
      coll.toArray
        .filter(row => row.contextId === run.plannerContextId)
        .sort((left, right) => left.activityAttempt - right.activityAttempt))
    const output = yield* RuntimeOutputTable
    const runtimeEvents = sortRuntimeEvents(yield* output.events.query(coll =>
      coll.toArray.filter(row => row.contextId === run.plannerContextId)))
    const runtimeLogs = sortRuntimeEvents(yield* output.logs.query(coll =>
      coll.toArray.filter(row => row.contextId === run.plannerContextId)))
    const ingress = yield* RuntimeIngressTable
    const ingressInputs = yield* ingress.inputs.query(coll =>
      coll.toArray
        .filter(row => row.contextId === run.plannerContextId)
        .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0)))
    const permissions = runtimeEvents.flatMap(row => {
      const permission = permissionFromRow(row)
      return permission === undefined ? [] : [permission]
    })
    return {
      run,
      facts,
      runtimeRuns,
      runtimeEvents,
      runtimeLogs,
      ingressInputs,
      permissions,
    }
  })

export const respondToFactoryPermission = (
  input: PermissionResponseInput,
): Effect.Effect<PermissionResponseResult, unknown, unknown> =>
  Effect.gen(function* () {
    const decodedInput = yield* Schema.decodeUnknown(PermissionResponseInputSchema)(
      input,
    )
    const decision = decodedInput.decision
    const table = yield* DarkFactoryTable
    const createdAt = yield* nowIso
    const identity = permissionResolutionIdentityFor(decodedInput)
    const fact: DarkFactoryFact = {
      factKey: identity.factKey,
      source: "darkFactory.permission",
      externalEventKey: identity.externalEventKey,
      externalEntityKey: decodedInput.factoryRunKey,
      eventType: "permission.resolved",
      factoryRunKey: decodedInput.factoryRunKey,
      contextId: decodedInput.contextId,
      ...(decodedInput.correlationId === undefined
        ? {}
        : { correlationId: decodedInput.correlationId }),
      createdAt,
      payload: {
        permissionRequestId: decodedInput.permissionRequestId,
        decision,
      },
    }
    yield* table.facts.insertOrGet(fact)
    const ingress = yield* appendRuntimeIngress({
      contextId: decodedInput.contextId,
      inputId: identity.inputId,
      kind: "control",
      authoredBy: "client",
      payload: {
        _tag: "PermissionResponse",
        permissionRequestId: decodedInput.permissionRequestId,
        decision,
      },
      idempotencyKey: identity.inputId,
      metadata: {
        factoryRunKey: decodedInput.factoryRunKey,
        permissionRequestId: decodedInput.permissionRequestId,
      },
    })
    const runOption = yield* table.runs.get(decodedInput.factoryRunKey)
    yield* Option.match(runOption, {
      onNone: () => Effect.void,
      onSome: run =>
        upsertRunStatus(run, "resumed", {
          lastPermissionRequestId: decodedInput.permissionRequestId,
        }).pipe(Effect.asVoid),
    })
    return {
      fact,
      input: ingress,
    }
  })

export const waitForPermissionRequest = (
  input: FactoryPermissionWaitOptions,
): Effect.Effect<FactoryPermissionRequest, unknown, unknown> =>
  Effect.gen(function* () {
    const decodedInput = yield* Schema.decodeUnknown(FactoryPermissionWaitOptionsSchema)(
      input,
    )
    const afterSequence = decodedInput.afterSequence ?? -1
    const table = yield* DarkFactoryTable
    const runOption = yield* table.runs.get(decodedInput.factoryRunKey)
    const run = yield* Option.match(runOption, {
      onNone: () =>
        Effect.fail(new Error(`factory run not found: ${decodedInput.factoryRunKey}`)),
      onSome: Effect.succeed,
    })
    const sources = yield* SourceCollections
    const handle = yield* sources.awaitHandle(
      RuntimeObservationSourceNames.agentOutputEvents,
    )
    const firstMatch = handle.subscribe().pipe(
      Stream.filterMap(row =>
        Option.filter(permissionFromObservation(row), permission =>
          permission.contextId === run.plannerContextId &&
          permission.sequence > afterSequence)),
      Stream.runHead,
    )
    const awaited = Effect.raceFirst(
      firstMatch,
      Clock.sleep(Duration.millis(decodedInput.timeoutMs)).pipe(
        Effect.as(Option.none<FactoryPermissionRequest>()),
      ),
    )
    const result = yield* awaited
    return yield* Option.match(result, {
      onNone: () =>
        Effect.fail(new Error(`timed out waiting for permission on ${decodedInput.factoryRunKey}`)),
      onSome: Effect.succeed,
    })
  })

export const waitForNextAgentOutput = (
  input: FactoryNextAgentOutputWaitOptions,
): Effect.Effect<RuntimeEvent, unknown, unknown> =>
  Effect.gen(function* () {
    const decodedInput = yield* Schema.decodeUnknown(FactoryNextAgentOutputWaitOptionsSchema)(
      input,
    )
    const loop = (
      remainingMs: number,
    ): Effect.Effect<RuntimeEvent, unknown, unknown> =>
      Effect.gen(function* () {
        const status = yield* readFactoryRunStatus(decodedInput.factoryRunKey)
        const found = status.runtimeEvents.find(row =>
          row.sequence > decodedInput.afterSequence)
        if (found !== undefined) return found
        if (remainingMs <= 0) {
          return yield* Effect.fail(
            new Error(`timed out waiting for next output on ${decodedInput.factoryRunKey}`),
          )
        }
        yield* Effect.sleep("500 millis")
        return yield* loop(remainingMs - 500)
      })
    return yield* loop(decodedInput.timeoutMs)
  })

export { RuntimeObservationSourceNames }
