/**
 * Tracer 019 B/C: sync-run smoke.
 *
 * The local scenario invokes the production root script:
 *
 *   pnpm firegrid -- run --cwd ... --prompt ... --secret-env ... -- <agent>
 *
 * It then inspects the durable control, ingress, run, and output tables. The
 * Electric scenario uses the same command shape but is opt-in and credential
 * gated.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
} from "@firegrid/client"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url))

interface FiregridRunInvocation {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

interface SmokeConfig {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly token?: string
  readonly workdir: string
  readonly prompt: string
  readonly parentSecretValue: string
  readonly expectedExitCode: number
}

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined
let workdir: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
  workdir = await realpath(await mkdtemp(join(tmpdir(), "firegrid-tracer-019-")))
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
  if (workdir !== undefined) {
    await rm(workdir, { recursive: true, force: true })
    workdir = undefined
  }
})

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex")

const syncRunProbe = `
import { createHash } from "node:crypto"

const [expectedCwd, expectedPromptDigest, expectedExitCodeRaw, expectTokenHiddenRaw] = process.argv.slice(1)
const expectedExitCode = Number(expectedExitCodeRaw)
const secret = process.env.CHILD_MARKER_SECRET
const hostOnlySecret = process.env.FIREGRID_TRACER_PARENT_SECRET
const durableStreamsToken = process.env.FIREGRID_DURABLE_STREAMS_TOKEN
let buffered = ""
const timeout = setTimeout(() => {
  process.stderr.write("timed out waiting for durable prompt ingress\\n")
  process.exit(24)
}, 10_000)

const fail = (message, code) => {
  clearTimeout(timeout)
  process.stderr.write(message + "\\n")
  process.exit(code)
}

if (process.cwd() !== expectedCwd) {
  fail("cwd mismatch", 21)
}
if (secret === undefined) {
  fail("missing CHILD_MARKER_SECRET", 22)
}
if (hostOnlySecret !== undefined) {
  fail("host-only FIREGRID_TRACER_PARENT_SECRET leaked to child env", 25)
}
if (expectTokenHiddenRaw === "1" && durableStreamsToken !== undefined) {
  fail("host-only FIREGRID_DURABLE_STREAMS_TOKEN leaked to child env", 26)
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  buffered += chunk
  const newlineAt = buffered.indexOf("\\n")
  if (newlineAt === -1) return

  clearTimeout(timeout)
  const prompt = buffered.slice(0, newlineAt)
  const promptDigest = createHash("sha256").update(prompt).digest("hex")
  if (promptDigest !== expectedPromptDigest) {
    fail("prompt digest mismatch", 23)
  }

  console.log(JSON.stringify({
    type: "sync-run-smoke",
    cwdOk: true,
    promptDigest,
    secretDigest: createHash("sha256").update(secret).digest("hex"),
    requestedExitCode: expectedExitCode
  }))
  process.exit(expectedExitCode)
})
`

const firegridRunEnv = (config: SmokeConfig): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...globalThis.process.env,
    DURABLE_STREAMS_BASE_URL: config.durableStreamsBaseUrl,
    FIREGRID_RUNTIME_NAMESPACE: config.namespace,
    FIREGRID_RUNTIME_INPUT_ENABLED: "false",
    FIREGRID_TRACER_PARENT_SECRET: config.parentSecretValue,
  }
  if (config.token === undefined) {
    delete env["FIREGRID_DURABLE_STREAMS_TOKEN"]
  } else {
    env["FIREGRID_DURABLE_STREAMS_TOKEN"] = config.token
  }
  return env
}

const invokeFiregridRun = (
  config: SmokeConfig,
): Promise<FiregridRunInvocation> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "firegrid",
        "--",
        "run",
        "--cwd",
        config.workdir,
        "--prompt",
        config.prompt,
        "--agent",
        "codex-acp",
        "--secret-env",
        "CHILD_MARKER_SECRET=FIREGRID_TRACER_PARENT_SECRET",
        "--",
        globalThis.process.execPath,
        "--input-type=module",
        "-e",
        syncRunProbe,
        config.workdir,
        sha256Hex(config.prompt),
        String(config.expectedExitCode),
        config.token === undefined ? "0" : "1",
      ],
      {
        cwd: repoRoot,
        env: firegridRunEnv(config),
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", chunk => {
      stdout += chunk
    })
    child.stderr.on("data", chunk => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr })
    })
  })

const contextIdFromFiregridRun = (stdout: string): string => {
  const match = /firegrid:run: launched context (ctx_[^\s]+)/.exec(stdout)
  if (match?.[1] === undefined) {
    throw new Error(`firegrid run did not print a launched context id. stdout:\n${stdout}`)
  }
  return match[1]
}

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
//
// Read durable state through the public client snapshot. The client
// resolves the row's host binding internally and opens the host-owned
// ingress / output streams per call; tests do not reconstruct any
// host stream names.
const queryDurableState = (
  options: {
    readonly durableStreamsBaseUrl: string
    readonly namespace: string
    readonly contextId: string
    readonly token?: string
  },
) =>
  Effect.gen(function* () {
    const firegrid = yield* Firegrid
    return yield* firegrid.open(options.contextId).snapshot
  }).pipe(
    Effect.provide(
      FiregridStandaloneLive.pipe(
        Layer.provide(Layer.succeed(FiregridConfig, {
          durableStreamsBaseUrl: options.durableStreamsBaseUrl,
          namespace: options.namespace,
          ...(options.token === undefined
            ? {}
            : { headers: { Authorization: () => `Bearer ${options.token}` } }),
        })),
      ),
    ),
    Effect.scoped,
  )

const readDurableState = (
  options: Parameters<typeof queryDurableState>[0],
) => Effect.runPromise(queryDurableState(options))

type DurableSmokeState = Awaited<ReturnType<typeof readDurableState>>

const assertSmokeDurableState = (
  retained: DurableSmokeState,
  config: SmokeConfig,
  contextId: string,
) => {
  expect(retained.context).toBeDefined()
  const context = retained.context!
  expect(context.contextId).toBe(contextId)
  expect(context.createdBy).toBe("firegrid-run")
  expect(context.runtime.config.cwd).toBe(config.workdir)
  expect(context.runtime.config.agent).toBe("codex-acp")
  expect(context.runtime.config.envBindings).toEqual([
    { name: "CHILD_MARKER_SECRET", ref: "env:FIREGRID_TRACER_PARENT_SECRET" },
  ])
  expect(context.runtime.config.mcpServers).toEqual([
    {
      name: "firegrid-runtime-context",
      server: {
        type: "url",
        url: expect.stringContaining(`/mcp/runtime-context/${encodeURIComponent(contextId)}`),
      },
    },
  ])

  expect(retained.inputs).toHaveLength(1)
  expect(retained.inputs[0]).toMatchObject({
    contextId,
    status: "sequenced",
    sequence: 0,
    kind: "message",
    authoredBy: "client",
    payload: config.prompt,
  })

  expect(retained.runs.map(row => row.status)).toEqual(["started", "exited"])
  expect(retained.runs.at(-1)).toMatchObject({
    contextId,
    status: "exited",
    exitCode: config.expectedExitCode,
  })

  expect(retained.events).toHaveLength(1)
  const output = JSON.parse(retained.events[0]!.raw) as {
    readonly type: string
    readonly cwdOk: boolean
    readonly promptDigest: string
    readonly secretDigest: string
    readonly requestedExitCode: number
  }
  expect(output).toEqual({
    type: "sync-run-smoke",
    cwdOk: true,
    promptDigest: sha256Hex(config.prompt),
    secretDigest: sha256Hex(config.parentSecretValue),
    requestedExitCode: config.expectedExitCode,
  })

  const durableJson = JSON.stringify({
    context,
    runs: retained.runs,
    events: retained.events,
    logs: retained.logs,
  })
  expect(durableJson).not.toContain(config.parentSecretValue)
}

describe("firegrid tracer 019 sync-run local smoke", () => {
  it(
    "firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1 firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.2 firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.3 firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.4 firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.7 firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8 firegrid-local-mcp-run.LAUNCH_CONFIG.5 firegrid-local-mcp-run.LAUNCH_CONFIG.6 firegrid-local-mcp-run.VALIDATION.3 firegrid-workflow-driven-runtime.VALIDATION.2 invokes pnpm firegrid -- run and observes durable context ingress run output evidence",
    async () => {
      if (baseUrl === undefined) throw new Error("durable streams test server not started")
      if (workdir === undefined) throw new Error("workdir not created")
      const config: SmokeConfig = {
        durableStreamsBaseUrl: baseUrl,
        namespace: `tracer-019-local-${crypto.randomUUID()}`,
        workdir,
        prompt: `durable prompt ${crypto.randomUUID()}`,
        parentSecretValue: `secret-value-${crypto.randomUUID()}`,
        expectedExitCode: 7,
      }

      const run = await invokeFiregridRun(config)
      expect(run.signal).toBeNull()
      expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(config.expectedExitCode)
      expect(run.stdout).not.toContain(config.parentSecretValue)
      expect(run.stderr).not.toContain(config.parentSecretValue)

      const contextId = contextIdFromFiregridRun(run.stdout)
      const retained = await readDurableState({
        durableStreamsBaseUrl: config.durableStreamsBaseUrl,
        namespace: config.namespace,
        contextId,
      })
      assertSmokeDurableState(retained, config, contextId)
    },
    60_000,
  )
})

describe("firegrid tracer 019 sync-run CLI local defaults", () => {
  it(
    "firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.9 pnpm firegrid -- run -- <node -e ...> succeeds with no DURABLE_STREAMS_BASE_URL or FIREGRID_RUNTIME_NAMESPACE in env",
    async () => {
      const env: NodeJS.ProcessEnv = { ...globalThis.process.env }
      delete env["DURABLE_STREAMS_BASE_URL"]
      delete env["FIREGRID_RUNTIME_NAMESPACE"]
      delete env["FIREGRID_DURABLE_STREAMS_TOKEN"]

      const run = await new Promise<FiregridRunInvocation>((resolve, reject) => {
        const child = spawn(
          "pnpm",
          [
            "firegrid",
            "--",
            "run",
            "--agent",
            "codex-acp",
            "--",
            globalThis.process.execPath,
            "-e",
            "console.log('child-ran'); process.exit(0)",
          ],
          { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
        )
        let stdout = ""
        let stderr = ""
        child.stdout.setEncoding("utf8")
        child.stderr.setEncoding("utf8")
        child.stdout.on("data", chunk => { stdout += chunk })
        child.stderr.on("data", chunk => { stderr += chunk })
        child.on("error", reject)
        child.on("close", (status, signal) => {
          resolve({ status, signal, stdout, stderr })
        })
      })

      expect(run.signal).toBeNull()
      expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0)
      expect(run.stdout).toMatch(/firegrid:run: launched context ctx_/)
      expect(run.stdout).toContain("child-ran")
      expect(run.stderr).not.toMatch(/Missing data at DURABLE_STREAMS_BASE_URL/)
      expect(run.stderr).not.toMatch(/Missing data at FIREGRID_RUNTIME_NAMESPACE/)
    },
    60_000,
  )
})

describe("firegrid codex-acp public run scaffold", () => {
  it.todo(
    "firegrid-local-mcp-run.LAUNCH_CONFIG.7 runs pnpm firegrid -- run --prompt TEXT --agent codex-acp -- npx -y @zed-industries/codex-acp@0.14.0 after ACP runtime codec integration lands",
  )
})

const electricSmokeEnabled =
  globalThis.process.env["FIREGRID_ELECTRIC_SMOKE"] === "1" &&
  globalThis.process.env["DURABLE_STREAMS_BASE_URL"] !== undefined &&
  globalThis.process.env["FIREGRID_DURABLE_STREAMS_TOKEN"] !== undefined

const electricIt = electricSmokeEnabled ? it : it.skip

describe("firegrid tracer 019 Electric Cloud sync-run smoke", () => {
  electricIt(
    "firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.3 firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.4 firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8 firegrid-workflow-driven-runtime.VALIDATION.2 runs the same pnpm firegrid -- run shape against Electric Cloud",
    async () => {
      if (workdir === undefined) throw new Error("workdir not created")
      const durableStreamsBaseUrl = globalThis.process.env["DURABLE_STREAMS_BASE_URL"]
      const token = globalThis.process.env["FIREGRID_DURABLE_STREAMS_TOKEN"]
      if (durableStreamsBaseUrl === undefined || token === undefined) {
        throw new Error("Electric smoke requires DURABLE_STREAMS_BASE_URL and FIREGRID_DURABLE_STREAMS_TOKEN")
      }
      const namespace = globalThis.process.env["FIREGRID_ELECTRIC_SMOKE_NAMESPACE"] ??
        `tracer-019-electric-${crypto.randomUUID()}`
      const config: SmokeConfig = {
        durableStreamsBaseUrl,
        namespace,
        token,
        workdir,
        prompt: `electric durable prompt ${crypto.randomUUID()}`,
        parentSecretValue: `electric-secret-value-${crypto.randomUUID()}`,
        expectedExitCode: 0,
      }

      const run = await invokeFiregridRun(config)
      expect(run.signal).toBeNull()
      expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(config.expectedExitCode)
      expect(run.stdout).not.toContain(config.parentSecretValue)
      expect(run.stderr).not.toContain(config.parentSecretValue)

      const contextId = contextIdFromFiregridRun(run.stdout)
      const retained = await readDurableState({
        durableStreamsBaseUrl: config.durableStreamsBaseUrl,
        namespace: config.namespace,
        contextId,
        token,
      })
      assertSmokeDurableState(retained, config, contextId)
    },
    120_000,
  )
})
