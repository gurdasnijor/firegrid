// Thin subprocess launcher for the runtime-owned `firegrid:host` daemon.
// All host composition (FiregridLocalHostLive + optional MCP listener)
// lives in `packages/runtime/src/bin/host.ts`. This launcher only
// forwards argv, env, stdio, exit code, and signal.
//
// Per Shape C cutover rule "CLI must not import @firegrid/runtime or
// @effect/workflow": the launcher never imports runtime code into its
// own process. The runtime bin runs in a child node process under
// `tsx`; the CLI package therefore needs only the `tsx` dep.

import { fileURLToPath } from "node:url"
import { launchRuntimeBin } from "./launcher.ts"

const runtimeBin = fileURLToPath(
  new URL("../../../runtime/src/bin/host.ts", import.meta.url),
)

// Exported for the legacy `bin/index.ts` import shape (`runFiregridHost`).
export const runFiregridHost = (): void => {
  launchRuntimeBin(runtimeBin)
}
