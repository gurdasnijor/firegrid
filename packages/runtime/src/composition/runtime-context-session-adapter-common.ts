import type { RuntimeContext } from "@firegrid/protocol/launch"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "../runtime-errors.ts"
import type {
  AgentByteStream,
  RuntimeEnvResolverPolicy,
  SandboxProvider,
  SandboxProviderError,
} from "../producers/sandbox/index.ts"
import {
  commandForContext,
  SandboxProvider as SandboxProviderTag,
  SandboxStdinEmissionClaim,
} from "../producers/sandbox/index.ts"
import { Effect, Layer, Ref, type Context, type Scope } from "effect"
import { PerContextRuntimeOutputWriter } from "../tables/per-context-output.ts"
import type { FiregridRuntimeContextMcpBaseUrl } from "./runtime-context-mcp-base-url.ts"
import {
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
  type RuntimeContextSessionCommandAccepted,
  type RuntimeContextSessionStartedEvidence,
  type RuntimeContextWorkflowSessionService,
} from "../subscribers/runtime-context-session/handler.ts"

type RuntimeContextSessionOwnerKind = "raw" | "codec"

export interface RuntimeContextSessionRecord {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly ownerSessionId: string
}

export type RuntimeContextSessionAdapterRequirements =
  | PerContextRuntimeOutputWriter
  | RuntimeEnvResolverPolicy
  | SandboxProvider
  | SandboxStdinEmissionClaim
  // TFIND-048: host-scoped late-bind of the runtime-context MCP base
  // URL, captured alongside the other host-execution services so the
  // codec start path can resolve the concrete contextId-scoped URL.
  | FiregridRuntimeContextMcpBaseUrl
  | Scope.Scope

const mapSandboxProviderError = (
  contextId: string,
) =>
  Effect.mapError((cause: SandboxProviderError) =>
    asRuntimeContextError(
      `sandbox.${cause.op}`,
      cause.message,
      contextId,
      cause,
    ))

export const openRuntimeContextByteStream = (
  context: RuntimeContext,
): Effect.Effect<AgentByteStream, RuntimeContextError, RuntimeEnvResolverPolicy | SandboxProvider | Scope.Scope> =>
  Effect.gen(function* () {
    const command = yield* commandForContext(context)
    const provider = yield* SandboxProviderTag
    const sandbox = yield* provider.getOrCreate({
      labels: {
        firegridRuntimeContextId: context.contextId,
      },
      ...(context.runtime.config.cwd === undefined ? {} : {
        workingDir: context.runtime.config.cwd,
      }),
      providerConfig: {
        contextId: context.contextId,
      },
    }).pipe(mapSandboxProviderError(context.contextId))
    return yield* provider.openBytePipe(sandbox, command).pipe(
      mapSandboxProviderError(context.contextId),
    )
  })

interface RuntimeContextSessionAdapterDeps<Session extends RuntimeContextSessionRecord> {
  readonly writer: PerContextRuntimeOutputWriter["Type"]
  readonly stdinClaim: SandboxStdinEmissionClaim["Type"]
  readonly captured: Context.Context<
    | RuntimeEnvResolverPolicy
    | SandboxProvider
    | SandboxStdinEmissionClaim
    | FiregridRuntimeContextMcpBaseUrl
  >
  readonly scope: Scope.Scope
  readonly sessions: Ref.Ref<Map<string, Session>>
}

interface RuntimeContextSessionStart<Session extends RuntimeContextSessionRecord> {
  readonly session: Session
  readonly run: Effect.Effect<void>
}

const runtimeContextSessionKey = (
  context: RuntimeContext,
  activityAttempt: number,
) => `${context.contextId}:${activityAttempt}`

export const runtimeContextSessionOwnerSessionId = (
  ownerKind: RuntimeContextSessionOwnerKind,
  context: RuntimeContext,
  activityAttempt: number,
) => `${ownerKind}:${context.contextId}:${activityAttempt}`

const runtimeContextSessionStartedEvidence = (
  ownerKind: RuntimeContextSessionOwnerKind,
  context: RuntimeContext,
  activityAttempt: number,
): RuntimeContextSessionStartedEvidence => ({
  contextId: context.contextId,
  activityAttempt,
  ownerKind,
  ownerSessionId: runtimeContextSessionOwnerSessionId(ownerKind, context, activityAttempt),
  startCommandId: `start-${context.contextId}-${activityAttempt}`,
})

const runtimeContextSessionCommandAccepted = (
  session: RuntimeContextSessionRecord,
  command: RuntimeContextSessionCommand,
): RuntimeContextSessionCommandAccepted => ({
  contextId: session.context.contextId,
  activityAttempt: session.activityAttempt,
  commandId: command.commandId,
  ownerSessionId: session.ownerSessionId,
})

const removeRuntimeContextSession = <Session>(
  sessions: Ref.Ref<Map<string, Session>>,
  key: string,
) =>
  Ref.update(sessions, map => {
    const next = new Map(map)
    next.delete(key)
    return next
  })

const getRuntimeContextSessionOrFail = <Session>(options: {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly ownerKind: RuntimeContextSessionOwnerKind
  readonly sessions: Ref.Ref<Map<string, Session>>
  readonly startOrAttach: (
    context: RuntimeContext,
    activityAttempt: number,
  ) => Effect.Effect<RuntimeContextSessionStartedEvidence, RuntimeContextError>
}) =>
  Effect.gen(function*() {
    yield* options.startOrAttach(options.context, options.activityAttempt)
    const key = runtimeContextSessionKey(options.context, options.activityAttempt)
    const session = (yield* Ref.get(options.sessions)).get(key)
    if (session === undefined) {
      return yield* asRuntimeContextError(
        `runtime-context.${options.ownerKind}-session.attach`,
        `${options.ownerKind} runtime session did not attach`,
        options.context.contextId,
      )
    }
    return session
  })

export const makeRuntimeContextWorkflowSessionService = <Session extends RuntimeContextSessionRecord>(
  options: {
    readonly ownerKind: RuntimeContextSessionOwnerKind
    readonly sessions: Ref.Ref<Map<string, Session>>
    readonly scope: Scope.Scope
    readonly startSession: (
      context: RuntimeContext,
      activityAttempt: number,
      key: string,
    ) => Effect.Effect<RuntimeContextSessionStart<Session>, RuntimeContextError>
    readonly sendCommand: (
      context: RuntimeContext,
      session: Session,
      command: RuntimeContextSessionCommand,
    ) => Effect.Effect<void, RuntimeContextError>
  },
): RuntimeContextWorkflowSessionService => {
  const startOrAttach = (
    context: RuntimeContext,
    activityAttempt: number,
  ) =>
    Effect.gen(function*() {
      const key = runtimeContextSessionKey(context, activityAttempt)
      const current = yield* Ref.get(options.sessions)
      if (!current.has(key)) {
        const start = yield* options.startSession(context, activityAttempt, key)
        yield* Ref.update(options.sessions, map => new Map([...map, [key, start.session]]))
        yield* start.run.pipe(
          Effect.ensuring(removeRuntimeContextSession(options.sessions, key)),
          Effect.forkIn(options.scope),
        )
      }
      return runtimeContextSessionStartedEvidence(options.ownerKind, context, activityAttempt)
    })

  const getOrStart = (
    context: RuntimeContext,
    activityAttempt: number,
  ) =>
    getRuntimeContextSessionOrFail({
      context,
      activityAttempt,
      ownerKind: options.ownerKind,
      sessions: options.sessions,
      startOrAttach,
    })

  const send = (
    context: RuntimeContext,
    activityAttempt: number,
    command: RuntimeContextSessionCommand,
  ) =>
    Effect.gen(function*() {
      const session = yield* getOrStart(context, activityAttempt)
      yield* options.sendCommand(context, session, command)
      return runtimeContextSessionCommandAccepted(session, command)
    })

  // Wave D-A Shape (b): seam-level per-context teardown. Removes every
  // (contextId, *) session-record entry from the per-context registry.
  // Forked agent-stream fibers complete naturally when the agent's byte
  // stream ends (the `start.run` fiber forked at `forkIn(options.scope)`
  // above carries `Effect.ensuring(removeRuntimeContextSession(...))`, so
  // a session that fully exits has already cleared its registry entry —
  // this is the soft-deregister contract documented on
  // `RuntimeContextWorkflowSessionService.deregister`).
  //
  // The key shape is `${contextId}:${attempt}` per
  // `runtimeContextSessionKey` above; filtering by the `${contextId}:`
  // prefix matches every attempt for the context.
  const deregister = (contextId: string) =>
    Ref.update(options.sessions, (map) => {
      const prefix = `${contextId}:`
      return new Map(
        Array.from(map.entries()).filter(([key]) => !key.startsWith(prefix)),
      )
    })

  return { startOrAttach, send, deregister }
}

export const makeRuntimeContextSessionAdapterService = <Session extends RuntimeContextSessionRecord>(
  build: (
    deps: RuntimeContextSessionAdapterDeps<Session>,
  ) => RuntimeContextWorkflowSessionService,
): Effect.Effect<
  RuntimeContextWorkflowSessionService,
  never,
  RuntimeContextSessionAdapterRequirements
> =>
  Effect.gen(function*() {
    const writer = yield* PerContextRuntimeOutputWriter
    const stdinClaim = yield* SandboxStdinEmissionClaim
    const captured = yield* Effect.context<
      | RuntimeEnvResolverPolicy
      | SandboxProvider
      | SandboxStdinEmissionClaim
      | FiregridRuntimeContextMcpBaseUrl
    >()
    const scope = yield* Effect.scope
    const sessions = yield* Ref.make(new Map<string, Session>())
    return build({ writer, stdinClaim, captured, scope, sessions })
  })

export const scopedRuntimeContextWorkflowSessionLayer = <
  Requirements,
>(
  service: Effect.Effect<
    RuntimeContextWorkflowSessionService,
    never,
    Requirements
  >,
): Layer.Layer<
  RuntimeContextWorkflowSession,
  never,
  Exclude<Requirements, Scope.Scope>
> =>
  Layer.scoped(
    RuntimeContextWorkflowSession,
    service.pipe(
      Effect.map(value => RuntimeContextWorkflowSession.of(value)),
    ),
  )

const claimRuntimeContextSessionCommand = (options: {
  readonly context: RuntimeContext
  readonly command: RuntimeContextSessionCommand
  readonly byteLength: number
  readonly ownerKind: RuntimeContextSessionOwnerKind
  readonly stdinClaim: SandboxStdinEmissionClaim["Type"]
}) =>
  options.stdinClaim.claim({
    commandId: options.command.commandId,
    contextId: options.context.contextId,
    inputId: options.command.commandId,
    byteLength: options.byteLength,
  }).pipe(
    mapRuntimeContextError(
      `runtime-context.${options.ownerKind}-session.claim`,
      `failed to claim ${options.ownerKind} runtime input command`,
      options.context.contextId,
    ),
  )

export const makeRuntimeContextSessionCommandSender = <Session>(options: {
  readonly ownerKind: RuntimeContextSessionOwnerKind
  readonly stdinClaim: SandboxStdinEmissionClaim["Type"]
  readonly prepare: (
    context: RuntimeContext,
    session: Session,
    command: RuntimeContextSessionCommand,
  ) => Effect.Effect<{
    readonly byteLength: number
    readonly emit: Effect.Effect<void, RuntimeContextError>
  }, RuntimeContextError>
}) =>
(
  context: RuntimeContext,
  session: Session,
  command: RuntimeContextSessionCommand,
) =>
  Effect.gen(function*() {
    const prepared = yield* options.prepare(context, session, command)
    const claimed = yield* claimRuntimeContextSessionCommand({
      context,
      command,
      byteLength: prepared.byteLength,
      ownerKind: options.ownerKind,
      stdinClaim: options.stdinClaim,
    })
    if (claimed) {
      yield* prepared.emit
    }
  })
