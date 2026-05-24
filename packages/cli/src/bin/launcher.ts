import { spawn, type ChildProcess } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const tsxCli = require.resolve("tsx/cli")

const forwardedSignals: ReadonlyArray<NodeJS.Signals> = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGQUIT",
]

export const launchRuntimeBin = (
  runtimeBin: string,
): ChildProcess => {
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
