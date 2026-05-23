import {
  ContextNotLocal,
  type HostSessionRow,
} from "@firegrid/protocol/launch"
import { Effect } from "effect"
import {
  RuntimeContextRead,
  type RuntimeContextReadService,
} from "@firegrid/runtime/control-plane"
import {
  readRuntimeContext,
} from "@firegrid/runtime/workflows"

// `readRuntimeContext`, `runtimeContextWorkflowExecutionId`, and
// `runtimeExecutionClock` had zero kernel-barrel consumers and were
// removed from `kernel/index.ts` in the body+kernel deletion wave
// (rev 3, per OLA #726 reviewer directive). Callers that need the first
// two go through `@firegrid/runtime/workflows`. `runtimeExecutionClock`
// (the host-execution Clock) had zero consumers anywhere and was
// deleted outright. The remaining surface here is the single host-session
// context-resolution helper consumed by
// `host-sdk/src/host/agent-tool-host-live.ts` — retirement bead tf-z8wq.

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
