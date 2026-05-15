/**
 * Tracer 021: local MCP run interface.
 *
 * Implements:
 *  - firegrid-local-mcp-run.LOCAL_COMMAND.1
 *  - firegrid-local-mcp-run.LOCAL_COMMAND.2
 *  - firegrid-local-mcp-run.LOCAL_COMMAND.3
 *  - firegrid-local-mcp-run.EMBEDDED_DURABLE_STREAMS.1
 *  - firegrid-local-mcp-run.EMBEDDED_DURABLE_STREAMS.2
 *  - firegrid-local-mcp-run.MCP_ROUTE.1
 *  - firegrid-local-mcp-run.MCP_ROUTE.2
 *  - firegrid-local-mcp-run.EFFECT_COMPOSITION.1
 *  - firegrid-local-mcp-run.EFFECT_COMPOSITION.2
 *  - firegrid-local-mcp-run.EFFECT_COMPOSITION.3
 *  - firegrid-local-mcp-run.AUTHORITY_BOUNDARY.1
 *  - firegrid-local-mcp-run.AUTHORITY_BOUNDARY.2
 *  - firegrid-local-mcp-run.VALIDATION.1
 *  - firegrid-local-mcp-run.VALIDATION.2
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
} from "@firegrid/client"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Layer } from "effect"
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url))

const toolNames = [
  "execute",
  "schedule_me",
  "session_cancel",
  "session_close",
  "session_new",
  "session_prompt",
  "sleep",
  "wait_for",
] as const

interface ReadyRecord {
  readonly type: "firegrid.start.ready"
  readonly version: 1
  readonly contextId: string
  readonly mcpUrl: string
  readonly namespace: string
  readonly durableStreamsBaseUrl: string
  readonly embeddedDurableStreams: boolean
}

interface RunningLocalMcp {
  readonly child: LocalMcpProcess
  readonly ready: ReadyRecord
  readonly stdout: () => string
  readonly stderr: () => string
}

type LocalMcpProcess = ChildProcessByStdio<null, Readable, Readable>

const running: Array<LocalMcpProcess> = []
let configuredServer: DurableStreamTestServer | undefined

const isRunning = (child: LocalMcpProcess): boolean =>
  child.exitCode === null && child.signalCode === null

const waitForClose = (child: LocalMcpProcess, timeoutMs: number): Promise<boolean> => {
  if (!isRunning(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("close", onClose)
      resolve(false)
    }, timeoutMs)
    const onClose = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once("close", onClose)
  })
}

const signalLocalMcp = (child: LocalMcpProcess, signal: NodeJS.Signals): void => {
  if (!isRunning(child)) return
  if (child.pid === undefined || globalThis.process.platform === "win32") {
    child.kill(signal)
    return
  }
  try {
    // The smoke command is spawned as a process group so tsx/node grandchildren
    // cannot outlive the pnpm parent and block DurableStreamTestServer shutdown.
    globalThis.process.kill(-child.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      child.kill(signal)
    }
  }
}

const stopLocalMcp = async (child: LocalMcpProcess): Promise<void> => {
  signalLocalMcp(child, "SIGTERM")
  if (await waitForClose(child, 2_000)) return
  signalLocalMcp(child, "SIGKILL")
  await waitForClose(child, 2_000)
}

afterEach(async () => {
  for (const child of running.splice(0)) {
    await stopLocalMcp(child)
  }
  await configuredServer?.stop()
  configuredServer = undefined
}, 10_000)

const parseReadyRecord = (line: string): ReadyRecord => {
  const parsed = JSON.parse(line) as ReadyRecord
  expect(parsed.type).toBe("firegrid.start.ready")
  expect(parsed.version).toBe(1)
  expect(parsed.contextId.startsWith("ctx_")).toBe(true)
  expect(parsed.mcpUrl).toContain(`/mcp/runtime-context/${encodeURIComponent(parsed.contextId)}`)
  return parsed
}

const startLocalMcp = (
  input: {
    readonly namespace: string
    readonly env?: NodeJS.ProcessEnv
  },
): Promise<RunningLocalMcp> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "--silent",
        "firegrid",
        "--",
        "start",
        "--namespace",
        input.namespace,
      ],
      {
        cwd: repoRoot,
        detached: true,
        env: {
          ...globalThis.process.env,
          ...input.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    running.push(child)

    let stdout = ""
    let stderr = ""
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      stopLocalMcp(child).then(
        () => reject(new Error(`timed out waiting for ready record\nstdout:\n${stdout}\nstderr:\n${stderr}`)),
        (error) => reject(error),
      )
    }, 15_000)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      const newlineAt = stdout.indexOf("\n")
      if (newlineAt === -1 || settled) return
      settled = true
      clearTimeout(timeout)
      try {
        resolve({
          child,
          ready: parseReadyRecord(stdout.slice(0, newlineAt)),
          stdout: () => stdout,
          stderr: () => stderr,
        })
      } catch (error) {
        reject(error)
      }
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.on("exit", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(
        `firegrid start exited before ready record: code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      ))
    })
  })

const withMcpClient = async <A>(
  mcpUrl: string,
  use: (client: Client) => Promise<A>,
): Promise<A> => {
  const client = new Client(
    { name: "firegrid-local-mcp-run-smoke", version: "0.0.0" },
    {},
  )
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))
  await client.connect(
    transport as unknown as Parameters<Client["connect"]>[0],
  )
  try {
    return await use(client)
  } finally {
    await client.close()
  }
}

const readDurableState = (options: {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly contextId: string
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const firegrid = yield* Firegrid
      return yield* firegrid.open(options.contextId).snapshot
    }).pipe(
      Effect.provide(
        FiregridStandaloneLive.pipe(
          Layer.provide(Layer.succeed(FiregridConfig, {
            durableStreamsBaseUrl: options.durableStreamsBaseUrl,
            namespace: options.namespace,
          })),
        ),
      ),
      Effect.scoped,
    ),
  )

describe("tracer 021 local MCP run interface", () => {
  it("firegrid-local-mcp-run.VALIDATION.1 starts with no argv, embeds Durable Streams, lists tools, and calls session_new/session_prompt", async () => {
    const env = { ...globalThis.process.env }
    delete env["DURABLE_STREAMS_BASE_URL"]
    delete env["FIREGRID_DURABLE_STREAMS_TOKEN"]
    const namespace = `local-mcp-embedded-${crypto.randomUUID()}`

    const localMcp = await startLocalMcp({ namespace, env })

    expect(localMcp.ready.namespace).toBe(namespace)
    expect(localMcp.ready.embeddedDurableStreams).toBe(true)
    expect(localMcp.ready.durableStreamsBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/)
    await withMcpClient(localMcp.ready.mcpUrl, async (client) => {
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...toolNames])
      const result = await client.callTool({
        name: "sleep",
        arguments: { durationMs: 1 },
      })
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toEqual({ slept: true })

      const sessionNew = await client.callTool({
        name: "session_new",
        arguments: {
          agentKind: "/usr/bin/true",
          prompt: "ignored",
          options: { metadata: { correlationId: "tracer-021" } },
        },
      })
      expect(sessionNew.isError).toBeFalsy()
      const session = (
        sessionNew.structuredContent as {
          readonly session?: {
            readonly sessionId?: unknown
            readonly contextId?: unknown
            readonly status?: unknown
          }
        }
      ).session
      expect(session).toMatchObject({
        status: "running",
      })
      if (typeof session?.sessionId !== "string") {
        throw new Error("session_new did not return a string sessionId")
      }
      const sessionId = session.sessionId
      expect(sessionId).toBe(session.contextId)

      const sessionPrompt = await client.callTool({
        name: "session_prompt",
        arguments: {
          sessionId,
          inputId: "tracer-021-session-prompt",
          prompt: "follow-up",
        },
      })
      expect(sessionPrompt.isError).toBeFalsy()
      expect(sessionPrompt.structuredContent).toMatchObject({
        appended: true,
        sessionId,
        inputId: "tracer-021-session-prompt",
      })

      const childState = await readDurableState({
        durableStreamsBaseUrl: localMcp.ready.durableStreamsBaseUrl,
        namespace,
        contextId: sessionId,
      })
      expect(childState.context?.contextId).toBe(sessionId)
      expect(childState.inputs.map(input => ({
        contextId: input.contextId,
        authoredBy: input.authoredBy,
        status: input.status,
      }))).toEqual([
        {
          contextId: sessionId,
          authoredBy: "workflow",
          status: "sequenced",
        },
        {
          contextId: sessionId,
          authoredBy: "workflow",
          status: "sequenced",
        },
      ])
    })

    expect(localMcp.stdout().trim().split("\n")).toHaveLength(1)
  }, 25_000)

  it("firegrid-local-mcp-run.VALIDATION.2 attaches to configured Durable Streams instead of starting embedded streams", async () => {
    configuredServer = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
    const durableStreamsBaseUrl = await configuredServer.start()
    const namespace = `local-mcp-configured-${crypto.randomUUID()}`

    const localMcp = await startLocalMcp({
      namespace,
      env: {
        DURABLE_STREAMS_BASE_URL: durableStreamsBaseUrl,
      },
    })

    expect(localMcp.ready.namespace).toBe(namespace)
    expect(localMcp.ready.embeddedDurableStreams).toBe(false)
    expect(localMcp.ready.durableStreamsBaseUrl).toBe(durableStreamsBaseUrl)
    await withMcpClient(localMcp.ready.mcpUrl, async (client) => {
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...toolNames])
    })
    expect(localMcp.stdout().trim().split("\n")).toHaveLength(1)
  }, 15_000)
})
