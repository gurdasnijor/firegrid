// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.7
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8
//
// End-to-end coverage for the sync-run --cwd and --prompt features.
// Each test exercises the real product path the firegrid:run binary
// uses: RunConfig → durable RuntimeContext row → (optional) durable
// Runtime input deferred → RuntimeContextWorkflow → local-process
// sandbox spawn → stdin delivery → child stdout journaled to
// RuntimeOutputTable.
//
// No service facades or test-only adapters — these tests call the
// same startRuntime / appendRuntimeIngress / control-plane upsert
// path the binary calls.

import { DurableStreamTestServer } from "@durable-streams/server"
import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  makeHostStreamPrefix,
  runtimeContextOutputStreamUrl,
  type HostId,
} from "@firegrid/protocol/launch"
import { Effect, type Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  FiregridRuntimeHostWithWorkflowLive,
  RuntimeEnvResolverPolicy,
  appendRuntimeIngress,
  startRuntime,
} from "../../src/host/index.ts"
import { RuntimeContextInsert } from "@firegrid/runtime/control-plane"
import {
  firegridRunCreatedBy,
  runConfigToIngressRequest,
  runConfigToRuntimeContextIntent,
  type RunConfig,
} from "../../src/host/sync-run.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const denyAllPolicy = RuntimeEnvResolverPolicy.denyAll

// Run the same pipeline the firegrid:run binary runs: build the
// durable context row from the config, optionally append the prompt
// ingress row, then drive startRuntime. The host topology is built
// with input=true when the config carries a prompt, matching the
// binary's envHostLayer behavior.
const runWithConfig = (
  config: RunConfig,
  namespace: string,
  hostId: HostId,
  envPolicy: Layer.Layer<RuntimeEnvResolverPolicy> = denyAllPolicy,
) =>
  Effect.gen(function* () {
    const intent = runConfigToRuntimeContextIntent(config)
    const contextInsert = yield* RuntimeContextInsert
    const context = yield* contextInsert.insertLocalContext(intent, {
      contextId: `ctx_${crypto.randomUUID()}`,
      createdBy: firegridRunCreatedBy,
    })
    const ingressRequest = runConfigToIngressRequest(config, context.contextId)
    if (ingressRequest !== undefined) {
      yield* appendRuntimeIngress(ingressRequest)
    }
    const result = yield* startRuntime({ contextId: context.contextId })
    return { contextId: context.contextId, result }
  }).pipe(
    Effect.provide(FiregridRuntimeHostWithWorkflowLive(
      {
        durableStreamsBaseUrl: baseUrl!,
        namespace,
        hostId,
        ...(config.prompt === undefined ? {} : { input: true }),
      },
      envPolicy,
    )),
    Effect.scoped,
  )

const queryRuntimeState = (
  namespace: string,
  hostId: HostId,
  contextId: string,
) =>
  Effect.gen(function* () {
    const control = yield* RuntimeControlPlaneTable
    const outputs = yield* RuntimeOutputTable
    const context = yield* control.contexts.get(contextId)
    const events = yield* outputs.events.query((coll) =>
      coll.toArray
        .filter(event => event.contextId === contextId)
        .sort((left, right) => left.sequence - right.sequence))
    const logs = yield* outputs.logs.query((coll) =>
      coll.toArray.filter(log => log.contextId === contextId))
    return { context, events, logs }
  }).pipe(
    Effect.provide(RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: `${baseUrl!}/v1/stream/${namespace}.firegrid.runtime`,
        contentType: "application/json",
      },
    })),
    Effect.provide(RuntimeOutputTable.layer({
      streamOptions: {
        url: runtimeContextOutputStreamUrl({
          baseUrl: baseUrl!,
          prefix: makeHostStreamPrefix({ namespace, hostId }),
          contextId,
        }),
        contentType: "application/json",
      },
    })),
    Effect.scoped,
  )

describe("sync-run --cwd integration", () => {
  let workdir: string | undefined

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "firegrid-sync-run-cwd-"))
    // realpath unwraps platform-specific symlinks (macOS prepends
    // /private/) so the child's process.cwd() matches what we pass in.
    workdir = await realpath(workdir)
  })

  afterEach(async () => {
    if (workdir !== undefined) {
      await rm(workdir, { recursive: true, force: true })
      workdir = undefined
    }
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.7 child spawns in --cwd and the durable row records it", async () => {
    if (!baseUrl) throw new Error("server not started")
    if (workdir === undefined) throw new Error("workdir not created")
    const namespace = `sync-run-cwd-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId

    // Child prints its own cwd as a JSON envelope so we observe it
    // through the runtime journal. The path is non-sensitive (it's a
    // tmpdir we created) so emitting it is fine.
    const childCode = `
console.log(JSON.stringify({ type: "probe", cwd: process.cwd() }))
`
    const config: RunConfig = {
      agentArgv: [process.execPath, "--input-type=module", "-e", childCode],
      cwd: workdir,
    }

    const { contextId, result } = await Effect.runPromise(
      runWithConfig(config, namespace, hostId),
    )
    expect(result).toMatchObject({ contextId, exitCode: 0 })

    const retained = await Effect.runPromise(queryRuntimeState(namespace, hostId, contextId))
    const contextRow = Option.getOrThrow(retained.context)
    expect(contextRow.runtime.config.cwd).toBe(workdir)

    expect(retained.events).toHaveLength(2)
    const parsed = JSON.parse(retained.events[0]!.raw) as { readonly cwd: string }
    expect(parsed.cwd).toBe(workdir)
    expect(JSON.parse(retained.events[1]!.raw) as unknown).toEqual({
      type: "firegrid.agent-output",
      event: { _tag: "Terminated", exitCode: 0 },
    })
  })
})

describe("sync-run --prompt integration", () => {
  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8 appends a sequenced ingress row, delivers it to the child via stdin, and the child emits a digest of what it read", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `sync-run-prompt-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const prompt = `summarize-the-diff-${crypto.randomUUID()}`
    const expectedDigest = createHash("sha256").update(prompt).digest("hex")

    // Child reads one line from stdin, computes a SHA-256 digest of it,
    // and emits ONLY the digest (non-secret marker). This proves the
    // prompt reached the child via the full ingress → stdin path
    // without depending on the runtime journaling the prompt text
    // verbatim.
    const childCode = `
import { createHash } from "node:crypto"
let buffered = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  buffered += chunk
  const newlineAt = buffered.indexOf("\\n")
  if (newlineAt === -1) return
  const line = buffered.slice(0, newlineAt)
  const digest = createHash("sha256").update(line).digest("hex")
  console.log(JSON.stringify({ type: "probe", digest }))
  process.exit(0)
})
`

    const config: RunConfig = {
      agentArgv: [process.execPath, "--input-type=module", "-e", childCode],
      prompt,
    }

    const { contextId, result } = await Effect.runPromise(
      runWithConfig(config, namespace, hostId),
    )
    expect(result).toMatchObject({ contextId, exitCode: 0 })

    const retained = await Effect.runPromise(queryRuntimeState(namespace, hostId, contextId))
    expect(retained.events).toHaveLength(2)
    const parsed = JSON.parse(retained.events[0]!.raw) as {
      readonly type: string
      readonly digest: string
    }
    expect(parsed.type).toBe("probe")
    expect(parsed.digest).toBe(expectedDigest)
    expect(JSON.parse(retained.events[1]!.raw) as unknown).toEqual({
      type: "firegrid.agent-output",
      event: { _tag: "Terminated", exitCode: 0 },
    })

    // Sanity-check: the durable context row contains no ingress payload
    // value (the ingress payload is durable runtime input, not on
    // the context row).
    const contextRow = Option.getOrThrow(retained.context)
    expect(JSON.stringify(contextRow)).not.toContain(prompt)
  })
})
