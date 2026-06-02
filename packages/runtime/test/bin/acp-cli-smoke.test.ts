import * as acp from "@agentclientprotocol/sdk"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Readable, Writable } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const requireFromTest = createRequire(import.meta.url)
const tsxCli = requireFromTest.resolve("tsx/cli")
const fakeAgent = path.join(
  repoRoot,
  "packages/tiny-firegrid/src/bin/fake-acp-agent-process.ts",
)

const readTraceNames = (traceFile: string): ReadonlyArray<string> =>
  readTraceRows(traceFile)
    .map(row => typeof row.name === "string" ? row.name : "")

const readTraceRows = (traceFile: string): ReadonlyArray<Record<string, unknown>> =>
  readFileSync(traceFile, "utf8")
    .trim()
    .split("\n")
    .filter(line => line.length > 0)
    .map((line) => {
      const parsed = JSON.parse(line) as unknown
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    })

const injectedMcpUrlFromTrace = (traceFile: string): string => {
  for (const row of readTraceRows(traceFile)) {
    const attributes = row.attributes
    if (
      typeof attributes === "object" &&
      attributes !== null &&
      !Array.isArray(attributes) &&
      "firegrid.mcp.injected_url" in attributes &&
      typeof attributes["firegrid.mcp.injected_url"] === "string"
    ) {
      return attributes["firegrid.mcp.injected_url"]
    }
  }
  throw new Error("trace did not contain firegrid.mcp.injected_url")
}

const postMcpJsonRpc = async (
  url: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  })
  expect(response.ok).toBe(true)
  const body = await response.text()
  if (body.trim() === "") return {}
  const parsed = JSON.parse(body) as unknown
  expect(typeof parsed).toBe("object")
  expect(parsed).not.toBeNull()
  expect(Array.isArray(parsed)).toBe(false)
  return parsed as Record<string, unknown>
}

const waitForExit = (
  child: ChildProcessWithoutNullStreams,
): Promise<number | null> =>
  new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", code => resolve(code))
  })

class SmokeClient implements acp.Client {
  readonly updates: Array<acp.SessionNotification> = []

  async requestPermission(): Promise<acp.RequestPermissionResponse> {
    return { outcome: { outcome: "selected", optionId: "allow" } }
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.updates.push(params)
  }
}

describe("firegrid acp CLI", () => {
  let child: ChildProcessWithoutNullStreams | undefined

  afterEach(() => {
    if (child !== undefined && child.exitCode === null) {
      child.kill("SIGTERM")
    }
    child = undefined
  })

  it("firegrid-zed-acp-stdio-external-agent.CLI_HELPER.1 firegrid-zed-acp-stdio-external-agent.CLI_HELPER.2 firegrid-zed-acp-stdio-external-agent.CLI_HELPER.3 firegrid-zed-acp-stdio-external-agent.CLI_HELPER.4 runs as an ACP stdio server over the fake ACP agent process", async () => {
    const cwd = path.join(tmpdir(), `firegrid-acp-cli-${randomUUID()}`)
    mkdirSync(cwd, { recursive: true })
    const traceFile = ".firegrid/acp-trace.jsonl"
    const absoluteTraceFile = path.join(cwd, traceFile)
    const stderrChunks: Array<string> = []

    child = spawn(
      "pnpm",
      [
        "--silent",
        "firegrid",
        "--",
        "acp",
        "--cwd",
        cwd,
        "--otel-file",
        traceFile,
        "--permission",
        "allow",
        "--agent",
        "fake-acp-agent-process",
        "--agent-protocol",
        "acp",
        "--",
        process.execPath,
        tsxCli,
        fakeAgent,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DURABLE_STREAMS_BASE_URL: "",
          FIREGRID_RUNTIME_NAMESPACE: `acp-cli-smoke-${randomUUID()}`,
          FIREGRID_OTEL_FILE_PHASES: "start-end",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk)
    })

    const client = new SmokeClient()
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    const connection = new acp.ClientSideConnection(() => client, stream)

    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "firegrid-acp-cli-smoke", version: "0.0.0" },
    })
    expect(initialized.agentCapabilities?.loadSession).toBe(false)

    const session = await connection.newSession({
      cwd,
      mcpServers: [],
    })
    expect(session.sessionId).toMatch(/^acp_/)

    const prompt = await connection.prompt({
      sessionId: session.sessionId,
      messageId: randomUUID(),
      prompt: [{ type: "text", text: "hello from firegrid acp smoke" }],
    })
    expect(prompt.stopReason).toBe("end_turn")
    expect(client.updates.length).toBeGreaterThan(0)

    const mcpUrl = injectedMcpUrlFromTrace(absoluteTraceFile)
    await postMcpJsonRpc(mcpUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "firegrid-acp-cli-smoke", version: "0.0.0" },
      },
    })
    await postMcpJsonRpc(mcpUrl, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    })
    await postMcpJsonRpc(mcpUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "sleep", arguments: { durationMs: 1 } },
    })

    child.kill("SIGTERM")

    expect(stderrChunks.join("")).toContain(`firegrid acp: writing OTEL spans to ${absoluteTraceFile}`)
    const traceNames = readTraceNames(absoluteTraceFile)
    expect(traceNames).toContain("firegrid.mcp.register_toolkit")
    expect(traceNames).toContain("firegrid.acp_stdio_edge.prompt")
    expect(traceNames).toContain("firegrid.channel.dispatch")
  }, 60_000)

  it("firegrid-zed-acp-stdio-external-agent.VALIDATION.6 runs a creds-free ACP agent turn through firegrid run", async () => {
    const cwd = path.join(tmpdir(), `firegrid-run-cli-${randomUUID()}`)
    mkdirSync(cwd, { recursive: true })
    const stdoutChunks: Array<string> = []
    const stderrChunks: Array<string> = []

    child = spawn(
      "pnpm",
      [
        "--silent",
        "firegrid",
        "--",
        "run",
        "--cwd",
        cwd,
        "--prompt",
        "hello from firegrid run smoke",
        "--agent",
        "fake-acp-agent-process",
        "--agent-protocol",
        "acp",
        "--",
        process.execPath,
        tsxCli,
        fakeAgent,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DURABLE_STREAMS_BASE_URL: "",
          FIREGRID_RUNTIME_NAMESPACE: `run-cli-smoke-${randomUUID()}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdoutChunks.push(chunk)
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk)
    })

    const exitCode = await waitForExit(child)
    expect(exitCode).toBe(0)
    expect(stdoutChunks.join("")).toContain("Perfect! I've successfully updated the configuration.")
    expect(stderrChunks.join("")).toContain("firegrid run: allowing permission")
  }, 60_000)
})
