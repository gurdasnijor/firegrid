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
// `readRuntimeContext` was previously re-exported from the kernel barrel
// (sourced from `workflow-engine/workflows/runtime-context-run.ts`).
// To avoid a new subscribers/ → workflow-engine/ carve-out for a helper
// that is just `RuntimeContextRead.readContext` + a not-found mapping,
// the lookup is inlined here. The other consumer of the workflows-source
// helper (`@firegrid/runtime/workflows`) keeps the original export; this
// is a deliberate duplication of ~10 lines to keep the import-direction
// guard tight (subscribers/ → workflow-engine/ legacy tree imports are
// each bead-owned in `.dependency-cruiser.cjs`; adding a new edge for a
// trivial helper is not in scope of this slice).

import {
  ContextNotLocal,
  type HostSessionRow,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { Effect, Option } from "effect"
import {
  type RuntimeContextReadService,
} from "@firegrid/runtime/control-plane"
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
