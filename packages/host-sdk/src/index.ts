/**
 * `@firegrid/host-sdk` — the public Firegrid host surface.
 *
 * The single composition root is `firegridHost` / `runFiregridHost`: pass
 * options as data and it composes the runtime + MCP ingress + backend Live
 * internally. The entry itself lives at `@firegrid/runtime/unified` (the runtime
 * bins compose through it, and `host-sdk → runtime` already exists, so an entry
 * in host-sdk would be a cycle; the host-sdk barrel may only re-export from
 * `runtime/unified`). This re-exports it as the public surface.
 */

export {
  firegridHost,
  runFiregridHost,
  type FiregridHostEntryOptions as FiregridHostOptions,
  type FiregridIngressOptions,
} from "@firegrid/runtime/unified"
