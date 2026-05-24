// Thin subprocess launcher for the runtime-owned `firegrid:host` daemon.
// All host composition (FiregridLocalHostLive + optional MCP listener)
// lives in `packages/runtime/src/bin/host.ts`. This launcher only
// forwards argv, env, stdio, exit code, and signal.
//
// Per Shape C cutover rule "CLI must not import @firegrid/runtime or
// @effect/workflow": the launcher never imports runtime code into its
// own process. The runtime bin runs in a child node process under
// `tsx`; the CLI package therefore needs only the `tsx` dep.

import { spawn, type ChildProcess } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const tsxCli = require.resolve("tsx/cli")
const runtimeBin = fileURLToPath(
  new URL("../../../runtime/src/bin/host.ts", import.meta.url),
)

const forwardedSignals: ReadonlyArray<NodeJS.Signals> = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGQUIT",
]

const launchFiregridHost = (): ChildProcess => {
  const child = spawn(
    globalThis.process.execPath,
    [tsxCli, runtimeBin, ...globalThis.process.argv.slice(2)],
    { stdio: "inherit", env: globalThis.process.env },
  )
  for (const sig of forwardedSignals) {
    globalThis.process.on(sig, () => {
      if (!child.killed) child.kill(sig)
    })
  }
  child.on("exit", (code, signal) => {
    if (signal !== null) {
      globalThis.process.kill(globalThis.process.pid, signal)
      return
    }
    globalThis.process.exit(code ?? 0)
  })
  return child
}

// Exported for the legacy `bin/index.ts` import shape (`runFiregridHost`).
export const runFiregridHost = (): void => {
  launchFiregridHost()
}
