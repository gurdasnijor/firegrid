import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const requireFromTest = createRequire(import.meta.url)
const tsxCli = requireFromTest.resolve("tsx/cli")
const runtimeHostBin = path.join(repoRoot, "packages/runtime/src/bin/host.ts")

const waitForOutput = async (
  chunks: ReadonlyArray<string>,
  predicate: (output: string) => boolean,
): Promise<string> => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 15_000) {
    const output = chunks.join("")
    if (predicate(output)) return output
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for output; received: ${chunks.join("")}`)
}

describe("firegrid host CLI", () => {
  let child: ChildProcessWithoutNullStreams | undefined

  afterEach(() => {
    if (child !== undefined && child.exitCode === null) {
      child.kill("SIGTERM")
    }
    child = undefined
  })

  it("firegrid-runtime-process.BINARIES.13 firegrid-runtime-process.CONFIG_SURFACE.8 starts with an embedded local-dev backend when DURABLE_STREAMS_BASE_URL is unset", async () => {
    const stderrChunks: Array<string> = []

    child = spawn(
      process.execPath,
      [tsxCli, runtimeHostBin],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DURABLE_STREAMS_BASE_URL: "",
          FIREGRID_RUNTIME_NAMESPACE: "",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    child.stdout.resume()
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk)
    })

    const stderr = await waitForOutput(
      stderrChunks,
      output =>
        output.includes("firegrid host: embedded durable-streams at http://127.0.0.1:") &&
        output.includes(
          "local dev: ephemeral in-process durable-streams; state lost on exit; set DURABLE_STREAMS_BASE_URL for a real backend",
        ),
    )

    expect(stderr).toContain("Firegrid host started")
  }, 30_000)
})
