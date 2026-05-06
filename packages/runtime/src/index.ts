// @firegrid/runtime — public root surface.
//
// firegrid-architecture-boundary.VOCABULARY.1
// firegrid-architecture-boundary.SURFACE_AREA.1
// firegrid-architecture-boundary.SURFACE_AREA.2
// firegrid-architecture-boundary.DEPENDENCY_GRAPH.2
// firegrid-package-migration.PACKAGE_NAMES.3
// firegrid-package-migration.RUNTIME_RENAME.1
// firegrid-package-migration.RUNTIME_RENAME.2
// firegrid-package-migration.RUNTIME_RENAME.3
// firegrid-package-migration.RUNTIME_RENAME.5
// firegrid-runtime-process.RUNTIME_PACKAGE.1
// firegrid-runtime-process.RUNTIME_PACKAGE.2
// firegrid-runtime-process.RUNTIME_PACKAGE.3
// firegrid-runtime-process.RUNTIME_PACKAGE.4
// firegrid-runtime-process.CONFIG_SURFACE.1
// firegrid-runtime-process.CONFIG_SURFACE.2
//
// Tiny public surface:
//   FiregridRuntimeBoot.attached                 -> single Layer
//                                                   constructor
//   FiregridRuntime, RuntimeContext              -> Tags
//   Firegrid.subscribers.{timer, scheduledWork}  -> runtime helper
//                                                   Layers
//
// There is no public FiregridRuntimeLive factory, no
// FiregridRuntimeBootPlan / AttachedRuntimePlan / EmbeddedDevRuntimePlan
// type, no boot-plan-from-env helper, and no withHost. Runtime
// process configuration belongs at the binary process edge
// (bin/firegrid.ts).
//
// The runtime package does NOT depend on the app-facing client
// package: `runtime → client` is an architecture defect.

export {
  FiregridRuntimeBoot,
  type AttachedRuntimeOptions,
} from "./boot.ts"

export { Firegrid } from "./runtime-api.ts"

export {
  RuntimeContext,
  type RuntimeContextService,
} from "./context.ts"

export {
  FiregridRuntime,
  type BootMode,
  type FiregridRuntimeService,
  type FiregridRuntimeStreamIdentity,
} from "./service.ts"
