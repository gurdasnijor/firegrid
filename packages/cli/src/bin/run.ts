// Thin subprocess launcher for the runtime-owned `firegrid run | start | acp`
// CLI. All command-line behavior, schema decoding, durable-streams
// fallback, MCP serving, ACP edge wiring, and OTel exporter resolution
// live in `packages/runtime/src/bin/run.ts`. This module ONLY forwards
// argv, env, stdio, exit code, and signal to that subprocess.
//
// Per Shape C cutover rule "CLI must not import @firegrid/runtime or
// @effect/workflow": the launcher never imports runtime code into its
// own process. The runtime bin runs in a child node process under
// `tsx`; the CLI package therefore needs only the `tsx` dep.

import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const tsxCli = require.resolve("tsx/cli")
const runtimeBin = fileURLToPath(
  new URL("../../../runtime/src/bin/run.ts", import.meta.url),
)

const child = spawn(
  globalThis.process.execPath,
  [tsxCli, runtimeBin, ...globalThis.process.argv.slice(2)],
  { stdio: "inherit", env: globalThis.process.env },
)

// Forward signals so an editor (Zed under ACP) or a shell that targets
// the launcher rather than the foreground process group still terminates
// the runtime child cleanly.
const forwardedSignals: ReadonlyArray<NodeJS.Signals> = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGQUIT",
]
for (const sig of forwardedSignals) {
  globalThis.process.on(sig, () => {
    if (!child.killed) child.kill(sig)
  })
}

child.on("exit", (code, signal) => {
  if (signal !== null) {
    // Re-raise the child's terminating signal so the operator sees the
    // same termination shape as if they had launched the runtime bin
    // directly.
    globalThis.process.kill(globalThis.process.pid, signal)
    return
  }
  globalThis.process.exit(code ?? 0)
})
