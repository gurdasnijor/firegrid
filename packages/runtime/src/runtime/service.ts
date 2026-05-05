import { Context } from "effect"

// firegrid-architecture-boundary.VOCABULARY.1
// firegrid-package-migration.RUNTIME_RENAME.1
// firegrid-runtime-process.RUNTIME_PACKAGE.2
//
// FiregridRuntime is the launchable runtime capability. Resolved
// boot identity only — bootMode, processId, streamIdentity. The
// boot plan itself is intentionally NOT reified on this Tag;
// runtime process configuration lives at the binary process edge.

export type BootMode = "embedded-dev" | "attached"

export interface FiregridRuntimeStreamIdentity {
  readonly streamUrl: string
  readonly streamName?: string
  readonly host?: string
  readonly port?: number
}

export interface FiregridRuntimeService {
  readonly processId: string
  readonly bootMode: BootMode
  readonly streamIdentity: FiregridRuntimeStreamIdentity
}

export class FiregridRuntime extends Context.Tag(
  "firegrid/FiregridRuntime",
)<FiregridRuntime, FiregridRuntimeService>() {}
