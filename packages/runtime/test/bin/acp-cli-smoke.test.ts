import * as acp from "@agentclientprotocol/sdk"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Readable, Writable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const requireFromTest = createRequire(import.meta.url)
const tsxCli = requireFromTest.resolve("tsx/cli")
const fakeAgent = path.join(
  repoRoot,
  "packages/tiny-firegrid/src/bin/fake-acp-agent-process.ts",
)

const REQUIRED_ZED_TRACE_SPANS = [
  "firegrid.acp_stdio_edge.initialize",
  "firegrid.acp_stdio_edge.new_session",
  "firegrid.acp_stdio_edge.prompt",
  "firegrid.mcp.register_toolkit",
  "McpServer.initialize",
  "McpServer.tools/list",
  "McpServer.tools/call",
] as const

const EXPECTED_FULL_TOOL_NAMES = [
  "call",
  "execute",
  "send",
  "session_cancel",
  "session_close",
  "session_new",
  "session_prompt",
  "sleep",
  "wait_any",
  "wait_for",
  "wait_until",
] as const

const FORBIDDEN_ACP_TOOL_RESULT_FAILURES = [
  "ACP ToolResult input is out-of-band for this codec slice",
  "codec send failed",
] as const

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

const waitForTraceRows = async (
  traceFile: string,
  label: string,
  predicate: (rows: ReadonlyArray<Record<string, unknown>>) => boolean,
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const deadline = Date.now() + 15_000
  let lastRows: ReadonlyArray<Record<string, unknown>> = []

  while (Date.now() < deadline) {
    if (existsSync(traceFile)) {
      try {
        const rows = readTraceRows(traceFile)
        lastRows = rows
        if (predicate(rows)) return rows
      } catch {
        // The file exporter writes continuously; retry if we observe a partial line.
      }
    }
    await delay(50)
  }

  throw new Error(
    `timed out waiting for ${label}; saw spans: ${
      readTraceNamesFromRows(lastRows).join(", ")
    }`,
  )
}

const readTraceNamesFromRows = (
  rows: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<string> =>
  rows.map(row => typeof row.name === "string" ? row.name : "")

const traceAttributes = (
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const attributes = row.attributes
  return typeof attributes === "object" &&
      attributes !== null &&
      !Array.isArray(attributes)
    ? attributes as Record<string, unknown>
    : {}
}

const completedSpanCount = (
  rows: ReadonlyArray<Record<string, unknown>>,
  name: string,
): number =>
  rows.filter(row => row.name === name && row.phase !== "start").length

const completedSpanNamed = (
  rows: ReadonlyArray<Record<string, unknown>>,
  name: string,
): Record<string, unknown> => {
  const span = rows.find(row => row.name === name && row.phase !== "start")
  if (span === undefined) {
    throw new Error(`trace did not contain completed span ${name}`)
  }
  return span
}

const injectedMcpUrlFromTrace = (traceFile: string): string => {
  for (const row of readTraceRows(traceFile)) {
    const attributes = traceAttributes(row)
    if ("firegrid.mcp.injected_url" in attributes &&
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

const mcpToolNames = (
  response: Record<string, unknown>,
): ReadonlyArray<string> => {
  const result = response.result
  expect(typeof result).toBe("object")
  expect(result).not.toBeNull()
  expect(Array.isArray(result)).toBe(false)

  const tools = (result as Record<string, unknown>).tools
  expect(Array.isArray(tools)).toBe(true)
  const names: Array<string> = []
  for (const tool of tools as ReadonlyArray<unknown>) {
    if (
      typeof tool === "object" &&
      tool !== null &&
      !Array.isArray(tool)
    ) {
      const name = (tool as { readonly name?: unknown }).name
      if (typeof name === "string") names.push(name)
    }
  }
  return names.sort()
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

  it("firegrid-zed-acp-stdio-external-agent.CLI_HELPER.1 firegrid-zed-acp-stdio-external-agent.CLI_HELPER.2 firegrid-zed-acp-stdio-external-agent.CLI_HELPER.3 firegrid-zed-acp-stdio-external-agent.CLI_HELPER.4 firegrid-zed-acp-stdio-external-agent.VALIDATION.6 reproduces the Zed ACP trace shape creds-free", async () => {
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
    const updateKinds = client.updates.map(update => update.update.sessionUpdate)
    expect(updateKinds).toContain("tool_call")

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
    const toolsList = await postMcpJsonRpc(mcpUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })
    expect(mcpToolNames(toolsList)).toEqual([...EXPECTED_FULL_TOOL_NAMES])

    const toolsCall = await postMcpJsonRpc(mcpUrl, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "sleep", arguments: { durationMs: 1 } },
    })
    expect(toolsCall.error).toBeUndefined()

    child.kill("SIGTERM")

    const stderr = stderrChunks.join("")
    expect(stderr).toContain(`firegrid acp: writing OTEL spans to ${absoluteTraceFile}`)

    const traceRows = await waitForTraceRows(
      absoluteTraceFile,
      "tf-r1gz Zed ACP trace spans",
      rows => REQUIRED_ZED_TRACE_SPANS.every(name =>
        completedSpanCount(rows, name) === 1,
      ),
    )
    for (const name of REQUIRED_ZED_TRACE_SPANS) {
      expect(completedSpanCount(traceRows, name)).toBe(1)
    }

    const registerToolkit = completedSpanNamed(traceRows, "firegrid.mcp.register_toolkit")
    const registerAttributes = traceAttributes(registerToolkit)
    expect(registerAttributes["firegrid.mcp.tool_count"]).toBe(11)
    expect(registerAttributes["firegrid.mcp.tool_names"]).toBe(EXPECTED_FULL_TOOL_NAMES.join(","))
    expect(registerAttributes["firegrid.mcp.tool_profile"]).toBe("full")

    const traceText = traceRows.map(row => JSON.stringify(row)).join("\n")
    for (const marker of FORBIDDEN_ACP_TOOL_RESULT_FAILURES) {
      expect(`${stderr}\n${traceText}`).not.toContain(marker)
    }

    const traceNames = readTraceNamesFromRows(traceRows)
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
