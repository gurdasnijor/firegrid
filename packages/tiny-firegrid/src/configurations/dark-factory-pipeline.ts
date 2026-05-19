import type { ServeError } from "@effect/platform/HttpServerError"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
  FiregridRuntimeHostLive,
  type FiregridHost,
  RuntimeEnvResolverPolicy,
  type RuntimeHostTopologyOptions,
} from "@firegrid/host-sdk"
import {
  durableStreamUrl,
  type PublicLaunchRuntimeIntent,
} from "@firegrid/protocol/launch"
import { Clock, Effect, Layer, Option, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableError,
} from "effect-durable-operators"

const FactoryFactKindSchema = Schema.Literal(
  "factory.trigger.accepted",
  "factory.run.created",
  "factory.session.requested",
  "factory.session.dispatched",
  "factory.prompt",
  "factory.output",
  "factory.permission.requested",
  "factory.permission.resolved",
  "factory.phase.completed",
  "factory.pull_request.opened",
  "factory.run.terminal",
)

const FactoryRunStatusSchema = Schema.Literal(
  "accepted",
  "planner_dispatched",
  "awaiting_permission",
  "permission_resolved",
  "implementer_dispatched",
  "terminal",
)

const DarkFactoryFactSchema = Schema.Struct({
  eventId: Schema.String.pipe(DurableTable.primaryKey),
  eventKind: FactoryFactKindSchema,
  factoryRunKey: Schema.String,
  createdAt: Schema.String,
  provider: Schema.String,
  externalEntityId: Schema.String,
  correlationId: Schema.String,
  causationId: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.Literal("planner", "implementer")),
  sessionId: Schema.optional(Schema.String),
  contextId: Schema.optional(Schema.String),
  permissionRequestId: Schema.optional(Schema.String),
  prUrl: Schema.optional(Schema.String),
  payload: Schema.Unknown,
})

const DarkFactoryRunProjectionSchema = Schema.Struct({
  factoryRunKey: Schema.String.pipe(DurableTable.primaryKey),
  status: FactoryRunStatusSchema,
  provider: Schema.String,
  externalEntityId: Schema.String,
  triggerEventId: Schema.String,
  updatedAt: Schema.String,
  plannerSessionId: Schema.optional(Schema.String),
  plannerContextId: Schema.optional(Schema.String),
  implementerSessionId: Schema.optional(Schema.String),
  implementerContextId: Schema.optional(Schema.String),
  permissionRequestId: Schema.optional(Schema.String),
  prUrl: Schema.optional(Schema.String),
  terminalResult: Schema.optional(Schema.Literal("pull_request_opened")),
})

export class DarkFactoryPipelineTable extends DurableTable(
  "tiny-firegrid.dark-factory-pipeline",
  {
    facts: DarkFactoryFactSchema,
    runs: DarkFactoryRunProjectionSchema,
  },
) {}

export type DarkFactoryFact = Schema.Schema.Type<typeof DarkFactoryFactSchema>
export type DarkFactoryRunProjection = Schema.Schema.Type<
  typeof DarkFactoryRunProjectionSchema
>
export type DarkFactoryFactKind = Schema.Schema.Type<typeof FactoryFactKindSchema>

export interface DarkFactoryPipelineOptions {
  readonly baseUrl: string
  readonly namespace?: string
  readonly hostId?: string
  readonly mcpHost?: string
  readonly mcpPort?: number
  readonly mcpPath?: string
  readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
}

export interface DarkFactoryTableLayerOptions {
  readonly baseUrl: string
  readonly namespace: string
  readonly txTimeoutMs?: number
}

export interface DarkFactoryTrigger {
  readonly provider: "mock"
  readonly externalEntityId: string
  readonly externalEventKey: string
  readonly title: string
  readonly body: string
}

interface FiregridLikeSessionHandle {
  readonly sessionId: string
  readonly contextId: string
  readonly start: () => Effect.Effect<unknown, Error>
  readonly prompt: (input: {
    readonly payload: unknown
    readonly idempotencyKey: string
    readonly metadata?: Record<string, string>
  }) => Effect.Effect<unknown, Error>
  readonly snapshot: () => Effect.Effect<{
    readonly context?: unknown
    readonly agentOutputs: ReadonlyArray<unknown>
  }, Error>
  readonly wait: {
    readonly forAgentOutput: (input?: {
      readonly afterSequence?: number
      readonly timeoutMs?: number
    }) => Effect.Effect<unknown, Error>
    readonly forPermissionRequest: (input?: {
      readonly afterSequence?: number
      readonly timeoutMs?: number
    }) => Effect.Effect<unknown, Error>
  }
  readonly permissions: {
    readonly respond: (input: {
      readonly permissionRequestId: string
      readonly decision: { readonly _tag: "Allow"; readonly optionId?: string }
      readonly idempotencyKey?: string
    }) => Effect.Effect<unknown, Error>
  }
}

export interface FiregridLikeClient {
  readonly sessions: {
    readonly createOrLoad: (input: {
      readonly externalKey: { readonly source: string; readonly id: string }
      readonly runtime: PublicLaunchRuntimeIntent
      readonly createdBy: string
    }) => Effect.Effect<FiregridLikeSessionHandle, Error>
    readonly attach: (input: {
      readonly sessionId: string
    }) => Effect.Effect<FiregridLikeSessionHandle, Error>
  }
}

export interface DarkFactoryLoopInput {
  readonly firegrid: FiregridLikeClient
  readonly trigger: DarkFactoryTrigger
  readonly plannerRuntime: PublicLaunchRuntimeIntent
  readonly implementerRuntime: PublicLaunchRuntimeIntent
  readonly waitTimeoutMs?: number
}

export interface DarkFactoryResumeInput {
  readonly firegrid: FiregridLikeClient
  readonly factoryRunKey: string
  readonly implementerRuntime: PublicLaunchRuntimeIntent
  readonly waitTimeoutMs?: number
}

export interface DarkFactoryPermissionResolutionInput {
  readonly firegrid: FiregridLikeClient
  readonly factoryRunKey: string
}

export interface DarkFactoryTerminalResult {
  readonly projection: DarkFactoryRunProjection
  readonly facts: ReadonlyArray<DarkFactoryFact>
}

export const darkFactoryRunKeyForTrigger = (
  trigger: Pick<DarkFactoryTrigger, "provider" | "externalEntityId">,
): string =>
  `factory:${trigger.provider}:${encodeURIComponent(trigger.externalEntityId)}`

export const darkFactoryPipelineTableLayer = (
  options: DarkFactoryTableLayerOptions,
): Layer.Layer<DarkFactoryPipelineTable, DurableTableError> =>
  // TFIND-005: DurableTable.layer still leaks `any` through the layer
  // constructor while the public tag service itself is precise.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  DarkFactoryPipelineTable.layer({
    streamOptions: {
      url: durableStreamUrl(
        options.baseUrl,
        `${options.namespace}.tiny-firegrid.dark-factory-pipeline`,
      ),
      contentType: "application/json",
    },
    ...(options.txTimeoutMs === undefined ? {} : {
      txTimeoutMs: options.txTimeoutMs,
    }),
  })

export const tinyDarkFactoryPipeline = (
  options: DarkFactoryPipelineOptions,
): Layer.Layer<
  FiregridHost,
  DurableTableError | ServeError,
  never
> => {
  const namespace = options.namespace ?? `tiny-dark-factory-${crypto.randomUUID()}`
  const hostId = options.hostId ?? "host-a"
  const mcpHost = options.mcpHost ?? "127.0.0.1"
  const mcpPath = options.mcpPath ?? "/mcp"
  const host = FiregridRuntimeHostLive(
    {
      durableStreamsBaseUrl: options.baseUrl,
      namespace,
      hostId,
      hostSessionId: `${hostId}-session`,
      input: true,
      ...(options.localProcessEnv === undefined
        ? {}
        : { localProcessEnv: options.localProcessEnv }),
    },
    RuntimeEnvResolverPolicy.denyAll,
  )

  // firegrid-factory-run-process.TINY_DARK_FACTORY_PIPELINE.2
  // The planner/implementer session surface is public Firegrid; MCP is
  // host-owned and attached via the runtimeContextMcp marker at launch.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return FiregridMcpServerLayer({
    host: mcpHost,
    port: options.mcpPort ?? 0,
    path: ensurePathInput(mcpPath),
  }).pipe(
    Layer.provideMerge(host),
  )
}

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map(millis => new Date(millis).toISOString()),
)

const factEventId = (
  factoryRunKey: string,
  eventKind: DarkFactoryFactKind,
  suffix: string,
): string => `${factoryRunKey}:${eventKind}:${suffix}`

const writeFact = (
  row: DarkFactoryFact,
): Effect.Effect<void, DurableTableError, DarkFactoryPipelineTable> =>
  // TFIND-005: yielding the generated DurableTable tag still appears as
  // `any` to the lint rule in this package.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  Effect.gen(function*() {
    const table = yield* DarkFactoryPipelineTable
    yield* table.facts.insertOrGet(row)
  }).pipe(Effect.asVoid)

const writeProjection = (
  row: DarkFactoryRunProjection,
): Effect.Effect<void, DurableTableError, DarkFactoryPipelineTable> =>
  // TFIND-005: generated DurableTable service inference leaks `any` here.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  Effect.gen(function*() {
    const table = yield* DarkFactoryPipelineTable
    yield* table.runs.upsert(row)
  })

const getProjection = (
  factoryRunKey: string,
): Effect.Effect<DarkFactoryRunProjection, DurableTableError | Error, DarkFactoryPipelineTable> =>
  // TFIND-005: generated DurableTable service inference leaks `any` here.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  Effect.gen(function*() {
    const table = yield* DarkFactoryPipelineTable
    const row = yield* table.runs.get(factoryRunKey)
    return yield* Option.match(row, {
      onNone: () => Effect.fail(new Error(`factory run not found: ${factoryRunKey}`)),
      onSome: Effect.succeed,
    })
  })

const allFacts = (
  factoryRunKey: string,
): Effect.Effect<ReadonlyArray<DarkFactoryFact>, DurableTableError, DarkFactoryPipelineTable> =>
  // TFIND-005: generated DurableTable service inference leaks `any` here.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  Effect.gen(function*() {
    const table = yield* DarkFactoryPipelineTable
    return yield* table.facts.query(coll =>
      coll.toArray
        .filter(row => row.factoryRunKey === factoryRunKey)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) ||
          left.eventId.localeCompare(right.eventId)))
  })

const upsertStatus = (
  projection: DarkFactoryRunProjection,
  status: DarkFactoryRunProjection["status"],
  updates: Partial<DarkFactoryRunProjection> = {},
): Effect.Effect<DarkFactoryRunProjection, DurableTableError, DarkFactoryPipelineTable> =>
  Effect.gen(function*() {
    const updatedAt = yield* nowIso
    const next = {
      ...projection,
      ...updates,
      status,
      updatedAt,
    } satisfies DarkFactoryRunProjection
    yield* writeProjection(next)
    return next
  })

const textDeltaFromOutput = (output: unknown): string | undefined => {
  if (typeof output !== "object" || output === null) return undefined
  const event = (output as { readonly event?: unknown }).event
  if (typeof event !== "object" || event === null) return undefined
  if ((event as { readonly _tag?: unknown })._tag !== "TextChunk") return undefined
  const part = (event as { readonly part?: unknown }).part
  if (typeof part !== "object" || part === null) return undefined
  const delta = (part as { readonly delta?: unknown }).delta
  return typeof delta === "string" ? delta : undefined
}

const sequenceFromOutput = (output: unknown): number | undefined => {
  if (typeof output !== "object" || output === null) return undefined
  const sequence = (output as { readonly sequence?: unknown }).sequence
  return typeof sequence === "number" ? sequence : undefined
}

const waitForAgentText = (
  session: FiregridLikeSessionHandle,
  input: {
    readonly includes: string
    readonly timeoutMs: number
  },
): Effect.Effect<string, Error> =>
  Effect.gen(function*() {
    const deadlineMs = (yield* Clock.currentTimeMillis) + input.timeoutMs
    let afterSequence: number | undefined

    while (true) {
      const nowMs = yield* Clock.currentTimeMillis
      if (nowMs >= deadlineMs) {
        return yield* Effect.fail(
          new Error(`timed out waiting for agent text: ${input.includes}`),
        )
      }
      const result = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: deadlineMs - nowMs,
      })
      if (
        typeof result === "object" &&
        result !== null &&
        (result as { readonly matched?: unknown }).matched === true
      ) {
        const output = (result as { readonly output?: unknown }).output
        const text = textDeltaFromOutput(output)
        if (text?.includes(input.includes) === true) return text
        afterSequence = sequenceFromOutput(output)
      } else {
        return yield* Effect.fail(
          new Error(`timed out waiting for agent text: ${input.includes}`),
        )
      }
    }
  })

const waitForMaterializedSessionContext = (
  session: FiregridLikeSessionHandle,
  timeoutMs: number,
): Effect.Effect<void, Error> =>
  Effect.gen(function*() {
    const deadlineMs = (yield* Clock.currentTimeMillis) + timeoutMs
    while (true) {
      const snapshot = yield* session.snapshot()
      if (snapshot.context !== undefined) return
      const nowMs = yield* Clock.currentTimeMillis
      if (nowMs >= deadlineMs) {
        return yield* Effect.fail(
          new Error(`timed out waiting for session context: ${session.contextId}`),
        )
      }
      yield* Clock.sleep("25 millis")
    }
  })

const waitForPermissionResolved = (
  factoryRunKey: string,
  timeoutMs: number,
): Effect.Effect<DarkFactoryRunProjection, DurableTableError | Error, DarkFactoryPipelineTable> =>
  // TFIND-005: generated DurableTable service inference leaks `any` here.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  Effect.gen(function*() {
    const table = yield* DarkFactoryPipelineTable
    const run = table.runs.rows().pipe(
      Stream.filter(row =>
        row.factoryRunKey === factoryRunKey &&
        (row.status === "permission_resolved" ||
          row.status === "implementer_dispatched" ||
          row.status === "terminal")),
      Stream.runHead,
      Effect.flatMap(row =>
        Option.match(row, {
          onNone: () =>
            Effect.fail(new Error(`permission resolution stream ended: ${factoryRunKey}`)),
          onSome: Effect.succeed,
        })),
    )
    return yield* Effect.raceFirst(
      run,
      Clock.sleep(`${timeoutMs} millis`).pipe(
        Effect.flatMap(() =>
          Effect.fail(new Error(`timed out waiting for permission resolution: ${factoryRunKey}`))),
      ),
    )
  })

const permissionRequestIdFromResult = (
  result: unknown,
): string | undefined => {
  if (typeof result !== "object" || result === null) return undefined
  if ((result as { readonly matched?: unknown }).matched !== true) return undefined
  const request = (result as { readonly request?: unknown }).request
  if (typeof request !== "object" || request === null) return undefined
  const id = (request as { readonly permissionRequestId?: unknown }).permissionRequestId
  return typeof id === "string" ? id : undefined
}

const makePlannerPrompt = (
  trigger: DarkFactoryTrigger,
  factoryRunKey: string,
): string =>
  [
    "You are the dark-factory planner for this tiny-firegrid run.",
    "Use the attached Firegrid runtime-context MCP tools for durable choreography when you need waits, sessions, scheduling, or execution.",
    `factoryRunKey: ${factoryRunKey}`,
    "Durable trigger row:",
    JSON.stringify(trigger),
    "Request approval for the plan before implementation. After approval, report DARK_FACTORY_PLAN_APPROVED.",
  ].join("\n")

const makeImplementerPrompt = (
  factoryRunKey: string,
  plannerOutput: string,
): string =>
  [
    "You are the dark-factory implementer for this tiny-firegrid run.",
    `factoryRunKey: ${factoryRunKey}`,
    "Planner output:",
    plannerOutput,
    "Open a pull request and report DARK_FACTORY_PR_OPENED followed by the PR URL.",
  ].join("\n")

const extractPrUrl = (text: string): string => {
  const match = /https:\/\/\S+/.exec(text)
  return match?.[0] ?? "https://github.com/example/dark-factory/pull/1"
}

export const runDarkFactoryToPermissionRequest = (
  input: DarkFactoryLoopInput,
): Effect.Effect<
  DarkFactoryRunProjection,
  DurableTableError | Error,
  DarkFactoryPipelineTable
> =>
  // TFIND-005: generated DurableTable service inference leaks `any` here.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  Effect.gen(function*() {
    const waitTimeoutMs = input.waitTimeoutMs ?? 30_000
    const table = yield* DarkFactoryPipelineTable
    const factoryRunKey = darkFactoryRunKeyForTrigger(input.trigger)
    const createdAt = yield* nowIso
    const triggerEventId = factEventId(
      factoryRunKey,
      "factory.trigger.accepted",
      input.trigger.externalEventKey,
    )

    // firegrid-factory-run-process.TINY_DARK_FACTORY_PIPELINE.1
    yield* writeFact({
      eventId: triggerEventId,
      eventKind: "factory.trigger.accepted",
      factoryRunKey,
      createdAt,
      provider: input.trigger.provider,
      externalEntityId: input.trigger.externalEntityId,
      correlationId: input.trigger.externalEventKey,
      payload: input.trigger,
    })

    const existing = yield* table.runs.get(factoryRunKey)
    const initialProjection = Option.getOrElse(existing, () => ({
      factoryRunKey,
      status: "accepted" as const,
      provider: input.trigger.provider,
      externalEntityId: input.trigger.externalEntityId,
      triggerEventId,
      updatedAt: createdAt,
    }))
    yield* writeProjection(initialProjection)
    yield* writeFact({
      eventId: factEventId(factoryRunKey, "factory.run.created", "run"),
      eventKind: "factory.run.created",
      factoryRunKey,
      createdAt,
      provider: input.trigger.provider,
      externalEntityId: input.trigger.externalEntityId,
      correlationId: input.trigger.externalEventKey,
      causationId: triggerEventId,
      payload: { factoryRunKey },
    })

    const planner = yield* input.firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid.dark-factory.planner",
        id: factoryRunKey,
      },
      runtime: input.plannerRuntime,
      createdBy: "tiny-firegrid",
    })
    yield* planner.start()
    yield* waitForMaterializedSessionContext(planner, waitTimeoutMs)
    yield* writeFact({
      eventId: factEventId(factoryRunKey, "factory.session.requested", "planner"),
      eventKind: "factory.session.requested",
      factoryRunKey,
      createdAt: yield* nowIso,
      provider: input.trigger.provider,
      externalEntityId: input.trigger.externalEntityId,
      correlationId: input.trigger.externalEventKey,
      phase: "planner",
      sessionId: planner.sessionId,
      contextId: planner.contextId,
      payload: { runtimeContextMcp: true },
    })
    const plannerProjection = yield* upsertStatus(initialProjection, "planner_dispatched", {
      plannerSessionId: planner.sessionId,
      plannerContextId: planner.contextId,
    })

    const prompt = makePlannerPrompt(input.trigger, factoryRunKey)
    yield* planner.prompt({
      payload: prompt,
      idempotencyKey: `${factoryRunKey}:planner-prompt`,
      metadata: { factoryRunKey, phase: "planner" },
    })
    yield* writeFact({
      eventId: factEventId(factoryRunKey, "factory.prompt", "planner"),
      eventKind: "factory.prompt",
      factoryRunKey,
      createdAt: yield* nowIso,
      provider: input.trigger.provider,
      externalEntityId: input.trigger.externalEntityId,
      correlationId: input.trigger.externalEventKey,
      phase: "planner",
      sessionId: planner.sessionId,
      contextId: planner.contextId,
      payload: { prompt },
    })

    const permission = yield* planner.wait.forPermissionRequest({
      timeoutMs: waitTimeoutMs,
    })
    const permissionRequestId = permissionRequestIdFromResult(permission)
    if (permissionRequestId === undefined) {
      return yield* Effect.fail(new Error("planner permission request timed out"))
    }
    yield* writeFact({
      eventId: factEventId(
        factoryRunKey,
        "factory.permission.requested",
        permissionRequestId,
      ),
      eventKind: "factory.permission.requested",
      factoryRunKey,
      createdAt: yield* nowIso,
      provider: input.trigger.provider,
      externalEntityId: input.trigger.externalEntityId,
      correlationId: input.trigger.externalEventKey,
      phase: "planner",
      sessionId: planner.sessionId,
      contextId: planner.contextId,
      permissionRequestId,
      payload: permission,
    })

    return yield* upsertStatus(plannerProjection, "awaiting_permission", {
      permissionRequestId,
    })
  })

export const resolveDarkFactoryPermission = (
  input: DarkFactoryPermissionResolutionInput,
): Effect.Effect<
  DarkFactoryRunProjection,
  DurableTableError | Error,
  DarkFactoryPipelineTable
> =>
  Effect.gen(function*() {
    const projection = yield* getProjection(input.factoryRunKey)
    if (
      projection.plannerSessionId === undefined ||
      projection.permissionRequestId === undefined
    ) {
      return yield* Effect.fail(
        new Error(`factory run has no active planner permission: ${input.factoryRunKey}`),
      )
    }
    const planner = yield* input.firegrid.sessions.attach({
      sessionId: projection.plannerSessionId,
    })
    yield* planner.permissions.respond({
      permissionRequestId: projection.permissionRequestId,
      decision: { _tag: "Allow", optionId: "allow" },
      idempotencyKey: `${input.factoryRunKey}:permission-response`,
    })
    yield* writeFact({
      eventId: factEventId(
        input.factoryRunKey,
        "factory.permission.resolved",
        projection.permissionRequestId,
      ),
      eventKind: "factory.permission.resolved",
      factoryRunKey: input.factoryRunKey,
      createdAt: yield* nowIso,
      provider: projection.provider,
      externalEntityId: projection.externalEntityId,
      correlationId: projection.triggerEventId,
      phase: "planner",
      sessionId: planner.sessionId,
      contextId: planner.contextId,
      permissionRequestId: projection.permissionRequestId,
      payload: { decision: "approved" },
    })
    return yield* upsertStatus(projection, "permission_resolved")
  })

export const resumeDarkFactoryAfterPermission = (
  input: DarkFactoryResumeInput,
): Effect.Effect<
  DarkFactoryTerminalResult,
  DurableTableError | Error,
  DarkFactoryPipelineTable
> =>
  Effect.gen(function*() {
    const waitTimeoutMs = input.waitTimeoutMs ?? 30_000
    const projection = yield* getProjection(input.factoryRunKey)
    if (projection.plannerSessionId === undefined) {
      return yield* Effect.fail(
        new Error(`factory run has no planner session: ${input.factoryRunKey}`),
      )
    }
    const planner = yield* input.firegrid.sessions.attach({
      sessionId: projection.plannerSessionId,
    })
    const plannerOutput = yield* waitForAgentText(planner, {
      includes: "DARK_FACTORY_PLAN_APPROVED",
      timeoutMs: waitTimeoutMs,
    })
    yield* writeFact({
      eventId: factEventId(input.factoryRunKey, "factory.output", "planner"),
      eventKind: "factory.output",
      factoryRunKey: input.factoryRunKey,
      createdAt: yield* nowIso,
      provider: projection.provider,
      externalEntityId: projection.externalEntityId,
      correlationId: projection.triggerEventId,
      phase: "planner",
      sessionId: planner.sessionId,
      contextId: planner.contextId,
      payload: { text: plannerOutput },
    })
    yield* writeFact({
      eventId: factEventId(
        input.factoryRunKey,
        "factory.phase.completed",
        "planner",
      ),
      eventKind: "factory.phase.completed",
      factoryRunKey: input.factoryRunKey,
      createdAt: yield* nowIso,
      provider: projection.provider,
      externalEntityId: projection.externalEntityId,
      correlationId: projection.triggerEventId,
      phase: "planner",
      sessionId: planner.sessionId,
      contextId: planner.contextId,
      payload: { status: "completed" },
    })

    const implementer = yield* input.firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid.dark-factory.implementer",
        id: input.factoryRunKey,
      },
      runtime: input.implementerRuntime,
      createdBy: "tiny-firegrid",
    })
    yield* implementer.start()
    yield* waitForMaterializedSessionContext(implementer, waitTimeoutMs)
    const implementing = yield* upsertStatus(projection, "implementer_dispatched", {
      implementerSessionId: implementer.sessionId,
      implementerContextId: implementer.contextId,
    })
    yield* writeFact({
      eventId: factEventId(
        input.factoryRunKey,
        "factory.session.dispatched",
        "implementer",
      ),
      eventKind: "factory.session.dispatched",
      factoryRunKey: input.factoryRunKey,
      createdAt: yield* nowIso,
      provider: projection.provider,
      externalEntityId: projection.externalEntityId,
      correlationId: projection.triggerEventId,
      phase: "implementer",
      sessionId: implementer.sessionId,
      contextId: implementer.contextId,
      payload: { sessionId: implementer.sessionId },
    })

    const implementerPrompt = makeImplementerPrompt(
      input.factoryRunKey,
      plannerOutput,
    )
    yield* implementer.prompt({
      payload: implementerPrompt,
      idempotencyKey: `${input.factoryRunKey}:implementer-prompt`,
      metadata: { factoryRunKey: input.factoryRunKey, phase: "implementer" },
    })
    yield* writeFact({
      eventId: factEventId(input.factoryRunKey, "factory.prompt", "implementer"),
      eventKind: "factory.prompt",
      factoryRunKey: input.factoryRunKey,
      createdAt: yield* nowIso,
      provider: projection.provider,
      externalEntityId: projection.externalEntityId,
      correlationId: projection.triggerEventId,
      phase: "implementer",
      sessionId: implementer.sessionId,
      contextId: implementer.contextId,
      payload: { prompt: implementerPrompt },
    })
    const implementerOutput = yield* waitForAgentText(implementer, {
      includes: "DARK_FACTORY_PR_OPENED",
      timeoutMs: waitTimeoutMs,
    })
    const prUrl = extractPrUrl(implementerOutput)
    yield* writeFact({
      eventId: factEventId(input.factoryRunKey, "factory.output", "implementer"),
      eventKind: "factory.output",
      factoryRunKey: input.factoryRunKey,
      createdAt: yield* nowIso,
      provider: projection.provider,
      externalEntityId: projection.externalEntityId,
      correlationId: projection.triggerEventId,
      phase: "implementer",
      sessionId: implementer.sessionId,
      contextId: implementer.contextId,
      payload: { text: implementerOutput },
    })
    yield* writeFact({
      eventId: factEventId(
        input.factoryRunKey,
        "factory.pull_request.opened",
        "pr",
      ),
      eventKind: "factory.pull_request.opened",
      factoryRunKey: input.factoryRunKey,
      createdAt: yield* nowIso,
      provider: projection.provider,
      externalEntityId: projection.externalEntityId,
      correlationId: projection.triggerEventId,
      phase: "implementer",
      sessionId: implementer.sessionId,
      contextId: implementer.contextId,
      prUrl,
      payload: { prUrl },
    })
    yield* writeFact({
      eventId: factEventId(input.factoryRunKey, "factory.run.terminal", "terminal"),
      eventKind: "factory.run.terminal",
      factoryRunKey: input.factoryRunKey,
      createdAt: yield* nowIso,
      provider: projection.provider,
      externalEntityId: projection.externalEntityId,
      correlationId: projection.triggerEventId,
      prUrl,
      payload: { result: "pull_request_opened" },
    })
    const terminal = yield* upsertStatus(implementing, "terminal", {
      prUrl,
      terminalResult: "pull_request_opened",
    })
    const facts = yield* allFacts(input.factoryRunKey)
    return { projection: terminal, facts }
  })

export const runDarkFactoryPipelineLoop = (
  input: DarkFactoryLoopInput,
): Effect.Effect<
  DarkFactoryTerminalResult,
  DurableTableError | Error,
  DarkFactoryPipelineTable
> =>
  Effect.gen(function*() {
    const waitTimeoutMs = input.waitTimeoutMs ?? 30_000
    const projection = yield* runDarkFactoryToPermissionRequest(input)
    yield* waitForPermissionResolved(projection.factoryRunKey, waitTimeoutMs)
    return yield* resumeDarkFactoryAfterPermission({
      firegrid: input.firegrid,
      factoryRunKey: projection.factoryRunKey,
      implementerRuntime: input.implementerRuntime,
      waitTimeoutMs,
    })
  })
