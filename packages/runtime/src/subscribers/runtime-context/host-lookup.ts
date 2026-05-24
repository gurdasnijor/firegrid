// Per the tf-z8wq target-tree amendment (see
// `docs/architecture/2026-05-22-runtime-physical-target-tree.md` §"Kernel
// Retirement"): `requireLocalRuntimeContextWithHostSession` is a
// `RuntimeContextRead`-coupled lookup that asserts host-locality before
// returning the resolved `RuntimeContext`. The Shape C runtime-context
// subscriber folder is the natural home for `RuntimeContextRead`-coupled
// helpers; host-sdk consumes it through the narrow public subpath
// `@firegrid/runtime/subscribers/runtime-context/host-lookup` rather than
// the retired `@firegrid/runtime/kernel` barrel.
//
// `readRuntimeContext` was previously re-exported from the retired kernel /
// workflow-engine barrels. The lookup is inlined here because the behavior is
// just `RuntimeContextRead.readContext` + a typed not-found mapping; there is
// no remaining `workflow-engine/` helper to import from.

import {
  ContextNotLocal,
  type HostSessionRow,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { Effect, Option } from "effect"
import {
  type RuntimeContextReadService,
} from "../../tables/runtime-control-plane.ts"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "../../runtime-errors.ts"

const readRuntimeContextWithHostSession = (
  contextRead: RuntimeContextReadService,
  contextId: string,
): Effect.Effect<RuntimeContext, RuntimeContextError> =>
  contextRead.readContext(contextId).pipe(
    mapRuntimeContextError(
      "runtime-control-plane.contexts.get",
      "failed to read runtime context row",
      contextId,
    ),
    Effect.flatMap(maybeContext =>
      Option.match(maybeContext, {
        onNone: () =>
          Effect.fail(asRuntimeContextError(
            "runtime-control-plane.contexts.get",
            `runtime context not found: ${contextId}`,
            contextId,
          )),
        onSome: context => Effect.succeed(context),
      })),
  )

// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.4
export const requireLocalRuntimeContextWithHostSession = (
  contextRead: RuntimeContextReadService,
  hostSession: HostSessionRow,
  contextId: string,
): Effect.Effect<RuntimeContext, RuntimeContextError | ContextNotLocal> =>
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
