/**
 * Tracer 022: Firegrid CLI help discoverability.
 *
 * Implements:
 *  - firegrid-local-mcp-run.CLI_HELP.1
 *  - firegrid-local-mcp-run.CLI_HELP.2
 *  - firegrid-local-mcp-run.CLI_HELP.3
 *  - firegrid-local-mcp-run.CLI_HELP.5
 */

import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url))

const stripAnsi = (text: string): string =>
  text.replace(/\u001b\[[0-9;]*m/g, "")

// TFIND-042: this spawns a *cold* `pnpm firegrid` (pnpm bin resolution +
// Node start + the CLI's TS/ESM module graph). `--help` itself is fully
// deterministic — no ports, network, or races; it asserts static strings —
// so the only variable is process-startup latency. Under high local turbo
// contention (every package's vitest running in parallel) the first, cold
// invocation can exceed a tight `execFile` cap and get killed mid-startup
// (observed: empty-output "failed"); later calls run on warmed caches, and
// isolated/CI runs are ~1.4s/~8s. The bound below is a deterministic
// *ceiling* — the call resolves as soon as the process exits, it is NOT a
// fixed sleep — calibrated to a pathological-contention worst case so the
// test stays in the contended local turbo lane and in CI with all of its
// assertions and coverage fully intact.
const HELP_PROCESS_TIMEOUT_MS = 60_000
const HELP_TEST_TIMEOUT_MS = 90_000

const firegridHelp = (args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "pnpm",
      ["--silent", "firegrid", ...args],
      {
        cwd: repoRoot,
        env: {
          ...globalThis.process.env,
          NO_COLOR: "1",
        },
        timeout: HELP_PROCESS_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        const output = stripAnsi(`${stdout}${stderr}`)
        if (error !== null) {
          reject(new Error(`firegrid ${args.join(" ")} failed:\n${output}`))
          return
        }
        resolve(output)
      },
    )
  })

describe("tracer 022 CLI help discoverability", () => {
  it("firegrid-local-mcp-run.CLI_HELP.1 describes root commands and common workflows", async () => {
    const output = await firegridHelp(["--help"])

    expect(output).toContain("Run Firegrid agents or start a route-scoped local host/MCP server.")
    expect(output).toContain("Common workflows")
    expect(output).toContain("pnpm firegrid -- start")
    expect(output).toContain("pnpm firegrid -- run --prompt")
    expect(output).toContain("--agent codex-acp --agent-protocol acp")
    expect(output).toContain("--secret-env ANTHROPIC_API_KEY")
    expect(output).toContain("run")
    expect(output).toContain("start")
  }, HELP_TEST_TIMEOUT_MS)

  it("firegrid-local-mcp-run.CLI_HELP.2 documents run launch options from schema help", async () => {
    const output = await firegridHelp(["run", "--help"])

    expect(output).toContain("Run one agent command synchronously through a host-bound RuntimeContext.")
    expect(output).toContain("generated runtime-context MCP server")
    expect(output).toContain("--agent")
    expect(output).toContain("Opaque agent selector")
    expect(output).toContain("--agent-protocol")
    expect(output).toContain("Runtime codec")
    expect(output).toContain("--cwd")
    expect(output).toContain("Working directory")
    expect(output).toContain("--prompt")
    expect(output).toContain("RuntimeContext ingress")
    expect(output).toContain("--secret-env")
    expect(output).toContain("literal secret values are never accepted")
    expect(output).toContain("agent-argv")
  }, HELP_TEST_TIMEOUT_MS)

  it("firegrid-local-mcp-run.CLI_HELP.3 documents start host and MCP options", async () => {
    const output = await firegridHelp(["start", "--help"])

    expect(output).toContain("Start a local Firegrid host and route-scoped MCP server.")
    expect(output).toContain("firegrid.start.ready")
    expect(output).toContain("contextId")
    expect(output).toContain("mcpUrl")
    expect(output).toContain("--namespace")
    expect(output).toContain("FIREGRID_RUNTIME_NAMESPACE")
    expect(output).toContain("--mcp-host")
    expect(output).toContain("--mcp-port")
    expect(output).toContain("Default 0 asks the OS for a free loopback port")
    expect(output).toContain("--mcp-path")
  }, HELP_TEST_TIMEOUT_MS)
})
