import { Context } from "effect"
import type { FiregridRuntimeStreamIdentity } from "./service.ts"

// firegrid-architecture-boundary.VOCABULARY.1
// firegrid-package-migration.RUNTIME_RENAME.3
// firegrid-runtime-process.RUNTIME_PACKAGE.2
//
// RuntimeContext is the narrow Tag the Firegrid runtime injects into
// its Layer composition at launch time. It carries only what runtime
// helper Layers need to bind to the substrate stream — streamUrl,
// contentType, processId, and the resolved streamIdentity — and
// nothing about boot plans, auth/header transport, or future
// diagnostic state.
//
// CurrentWorkContext (per-message execution context provided while
// an operation handler is running) is a separate, message-scoped
// concept that lives elsewhere in the runtime / substrate stack.

export interface RuntimeContextService {
  readonly streamUrl: string
  readonly contentType: string
  readonly processId: string
  readonly streamIdentity: FiregridRuntimeStreamIdentity
}

export class RuntimeContext extends Context.Tag(
  "firegrid/RuntimeContext",
)<RuntimeContext, RuntimeContextService>() {}
