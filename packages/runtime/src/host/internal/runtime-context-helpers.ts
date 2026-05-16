import {
  ContextNotLocal,
  type HostSessionRow,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { Clock, Effect, Option } from "effect"
import {
  RuntimeContextRead,
  type RuntimeContextReadService,
} from "../../authorities/index.ts"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
} from "../../runtime-errors.ts"
import type { RuntimeContextError } from "../../runtime-errors.ts"

// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.5
export const runtimeContextWorkflowExecutionId = (contextId: string) =>
  `runtime-context:${contextId}`

// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.5
export const runtimeExecutionClock = Clock.make()

// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.5
export const readRuntimeContext = (
  contextId: string,
): Effect.Effect<RuntimeContext, RuntimeContextError, RuntimeContextRead> =>
  Effect.gen(function* () {
    const contextRead = yield* RuntimeContextRead
    const maybeContext = yield* contextRead.readContext(contextId).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.contexts.get",
        "failed to read runtime context row",
        contextId,
      ),
    )
    return yield* Option.match(maybeContext, {
      onNone: () =>
        Effect.fail(asRuntimeContextError(
          "runtime-control-plane.contexts.get",
          `runtime context not found: ${contextId}`,
          contextId,
        )),
      onSome: row => Effect.succeed(row),
    })
  })

export const readRuntimeContextWithHostSession = (
  contextRead: RuntimeContextReadService,
  contextId: string,
) =>
  readRuntimeContext(contextId).pipe(
    Effect.provideService(RuntimeContextRead, contextRead),
  )

// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.4
export const requireLocalRuntimeContextWithHostSession = (
  contextRead: RuntimeContextReadService,
  hostSession: HostSessionRow,
  contextId: string,
) =>
  readRuntimeContextWithHostSession(contextRead, contextId).pipe(
    Effect.flatMap(context =>
      context.host.hostId !== hostSession.hostId
        ? Effect.fail(new ContextNotLocal({
          contextId,
          hostId: context.host.hostId,
          currentHostId: hostSession.hostId,
        }))
        : Effect.succeed(context)),
  )
