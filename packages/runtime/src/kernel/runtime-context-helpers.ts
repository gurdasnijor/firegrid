import {
  ContextNotLocal,
  type HostSessionRow,
} from "@firegrid/protocol/launch"
import { Clock, Effect } from "effect"
import {
  RuntimeContextRead,
  type RuntimeContextReadService,
} from "@firegrid/runtime/control-plane"
import {
  readRuntimeContext,
} from "@firegrid/runtime/workflows"

export {
  readRuntimeContext,
  runtimeContextWorkflowExecutionId,
} from "@firegrid/runtime/workflows"

// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.5
export const runtimeExecutionClock = Clock.make()

const readRuntimeContextWithHostSession = (
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
