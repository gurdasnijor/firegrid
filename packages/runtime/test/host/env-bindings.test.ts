// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
//
// End-to-end integration test for the env binding authority boundary.
// Asserts that:
//   - The durable RuntimeContext row stores binding refs only — never the
//     resolved value.
//   - The child process receives the resolved value at spawn time when the
//     host policy authorizes the exact (target,source) pair.
//   - A row whose pair is not authorized fails before any spawn.
//   - The default deny-all policy rejects any binding.
//
// Important comment for future test authors: Firegrid never stores
// resolved env values as control-plane config, run-status evidence, or
// snapshots — that invariant is what this file protects. The child
// process's stdout/stderr are UNTRUSTED user output and the runtime
// journals them into RuntimeOutputTable verbatim; if a child prints its
// own env, it leaks. To prove the resolver delivered the right value
// WITHOUT leaking it into the journal, the happy path uses a SHA-256
// digest probe: the child computes a hash of process.env.FAKE_AGENT_KEY
// and prints only the digest. The test asserts the digest matches the
// expected one and that the raw secret value never appears in any
// durable surface.

import { DurableStreamTestServer } from "@durable-streams/server"
import { createHash } from "node:crypto"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  envBinding,
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  type HostId,
} from "@firegrid/protocol/launch"
import { Effect, Either, Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  FiregridRuntimeHostWithWorkflowLive,
  startRuntime,
} from "../../src/host/index.ts"
import { RuntimeEnvResolverPolicy } from "../../src/sources/sandbox/secrets.ts"

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

const appendRuntimeContext = (input: {
  readonly controlPlaneStreamUrl: string
  readonly argv: ReadonlyArray<string>
  readonly envBindings: ReadonlyArray<{ readonly name: string; readonly ref: string }>
  readonly hostId: HostId
  readonly namespace: string
}): Promise<string> =>
  Effect.runPromise(Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const contextId = `ctx_${crypto.randomUUID()}`
    const streamPrefix = makeHostStreamPrefix({
      namespace: input.namespace,
      hostId: input.hostId,
    })
    yield* table.contexts.upsert({
      contextId,
      createdAt: new Date().toISOString(),
      runtime: normalizeRuntimeIntent(local.jsonl({
        argv: [...input.argv],
        envBindings: input.envBindings.map(b => ({ name: b.name, ref: b.ref })),
      })),
      host: {
        hostId: input.hostId,
        streamPrefix,
        boundAtMs: Date.now(),
      },
    })
    return contextId
  }).pipe(
    Effect.provide(RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: input.controlPlaneStreamUrl,
        contentType: "application/json",
      },
    })),
    Effect.scoped,
  ))

const authorizingPolicy = (
  pairs: ReadonlyArray<readonly [string, string]>,
  values: Record<string, string>,
) =>
  Layer.succeed(
    RuntimeEnvResolverPolicy,
    RuntimeEnvResolverPolicy.make({
      authorizedBindings: pairs,
      lookupEnv: (name) => values[name],
    }),
  )

const sha256Hex = (input: string): string =>
  createHash("sha256").update(input).digest("hex")

describe("runtime env bindings authority boundary", () => {
  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 child receives resolved value (proved via digest probe) while durable row + output journal store no secret", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-env-bindings-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const streamPrefix = makeHostStreamPrefix({ namespace, hostId })
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`
    const outputTableStreamUrl = `${baseUrl}/v1/stream/${streamPrefix}.runtimeOutput`
    const secretValue = `super-secret-${crypto.randomUUID()}`
    const expectedDigest = sha256Hex(secretValue)

    // Digest-based proof: child computes SHA-256 of the env value and
    // prints only the digest. The runtime journal therefore captures a
    // digest, never the secret. The test verifies the digest matches
    // what we'd compute over the secret we injected through the policy
    // lookup — proving end-to-end resolution without leaking the secret
    // through child stdout into RuntimeOutputTable.events.
    const childCode = `
import { createHash } from "node:crypto"
const value = process.env.FAKE_AGENT_KEY
if (value === undefined) {
  process.stderr.write("missing env\\n")
  process.exit(7)
}
const digest = createHash("sha256").update(value).digest("hex")
console.log(JSON.stringify({ type: "probe", digest }))
`
    const contextId = await appendRuntimeContext({
      controlPlaneStreamUrl,
      argv: [process.execPath, "--input-type=module", "-e", childCode],
      envBindings: [envBinding("FAKE_AGENT_KEY", "PARENT_FAKE_AGENT_KEY")],
      hostId,
      namespace,
    })

    const result = await Effect.runPromise(
      startRuntime({ contextId }).pipe(
        Effect.provide(FiregridRuntimeHostWithWorkflowLive(
          { durableStreamsBaseUrl: baseUrl, namespace, hostId },
          // Authorize the exact (target, source) pair the row uses. The
          // lookup is injected so the test never touches real process env.
          authorizingPolicy(
            [["FAKE_AGENT_KEY", "PARENT_FAKE_AGENT_KEY"]],
            { PARENT_FAKE_AGENT_KEY: secretValue },
          ),
        )),
      ),
    )

    expect(result).toMatchObject({ contextId, exitCode: 0 })

    const retained = await Effect.runPromise(Effect.gen(function* () {
      const control = yield* RuntimeControlPlaneTable
      const outputTable = yield* RuntimeOutputTable
      const context = yield* control.contexts.get(contextId)
      const events = yield* outputTable.events.query((coll) =>
        coll.toArray
          .filter(event => event.contextId === contextId)
          .sort((left, right) => left.sequence - right.sequence))
      const logs = yield* outputTable.logs.query((coll) =>
        coll.toArray.filter(log => log.contextId === contextId))
      return { context, events, logs }
    }).pipe(
      Effect.provide(RuntimeControlPlaneTable.layer({
        streamOptions: {
          url: controlPlaneStreamUrl,
          contentType: "application/json",
        },
      })),
      Effect.provide(RuntimeOutputTable.layer({
        streamOptions: {
          url: outputTableStreamUrl,
          contentType: "application/json",
        },
      })),
      Effect.scoped,
    ))

    const contextRow = Option.getOrThrow(retained.context)
    // Durable row records the binding ref, never the resolved value.
    expect(contextRow.runtime.config.envBindings).toEqual([
      { name: "FAKE_AGENT_KEY", ref: "env:PARENT_FAKE_AGENT_KEY" },
    ])

    // The child saw the resolved value — proved by the matching digest.
    expect(retained.events).toHaveLength(1)
    const firstEvent = retained.events[0]
    expect(firstEvent).toBeDefined()
    const parsed = JSON.parse(firstEvent!.raw) as {
      readonly type: string
      readonly digest: string
    }
    expect(parsed.type).toBe("probe")
    expect(parsed.digest).toBe(expectedDigest)

    // The secret value must not appear anywhere durable: not in the
    // context row, not in the event journal, not in the log journal.
    // This is the Firegrid invariant the proposal protects. (Note: this
    // assertion stays trustworthy only because the child intentionally
    // does not print the raw secret — child stdout/stderr are untrusted
    // user output that the runtime journals verbatim, so a misbehaving
    // child *could* leak its own env. The platform guarantee is about
    // config/evidence rows, not about child-emitted bytes.)
    expect(JSON.stringify(contextRow)).not.toContain(secretValue)
    expect(JSON.stringify(retained.events)).not.toContain(secretValue)
    expect(JSON.stringify(retained.logs)).not.toContain(secretValue)
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 denies a row whose authorized pair does not match (no child spawn, no leak)", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-env-bindings-deny-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const streamPrefix = makeHostStreamPrefix({ namespace, hostId })
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`
    const outputTableStreamUrl = `${baseUrl}/v1/stream/${streamPrefix}.runtimeOutput`

    // Simulate a malicious / untrusted upstream that writes a binding
    // asking for AWS_SECRET_ACCESS_KEY. The host's policy authorizes
    // a different (target, source) pair — so the resolver must refuse
    // before any spawn.
    const contextId = await appendRuntimeContext({
      controlPlaneStreamUrl,
      argv: [process.execPath, "--input-type=module", "-e", "process.exit(0)"],
      envBindings: [{ name: "X", ref: "env:AWS_SECRET_ACCESS_KEY" }],
      hostId,
      namespace,
    })

    const awsSecret = `must-never-be-read-${crypto.randomUUID()}`
    const result = await Effect.runPromise(
      Effect.either(
        startRuntime({ contextId }).pipe(
          Effect.provide(FiregridRuntimeHostWithWorkflowLive(
            { durableStreamsBaseUrl: baseUrl, namespace, hostId },
            authorizingPolicy(
              [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
              { ANTHROPIC_API_KEY: "ok", AWS_SECRET_ACCESS_KEY: awsSecret },
            ),
          )),
        ),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "RuntimeContextError",
        op: "buildCommand.resolveEnvBindings",
      })
      expect(result.left.message).toContain("not authorized")
    }

    // run-status row chain should reflect "started" then "failed", and no
    // events row should exist (we never spawned the child). Sanity-check
    // that the unauthorized source value never made it into any durable
    // surface.
    const retained = await Effect.runPromise(Effect.gen(function* () {
      const control = yield* RuntimeControlPlaneTable
      const outputTable = yield* RuntimeOutputTable
      const runs = yield* control.runs.query((coll) =>
        coll.toArray.filter(event => event.contextId === contextId))
      const context = yield* control.contexts.get(contextId)
      const events = yield* outputTable.events.query((coll) =>
        coll.toArray.filter(event => event.contextId === contextId))
      const logs = yield* outputTable.logs.query((coll) =>
        coll.toArray.filter(log => log.contextId === contextId))
      return { runs, context, events, logs }
    }).pipe(
      Effect.provide(RuntimeControlPlaneTable.layer({
        streamOptions: {
          url: controlPlaneStreamUrl,
          contentType: "application/json",
        },
      })),
      Effect.provide(RuntimeOutputTable.layer({
        streamOptions: {
          url: outputTableStreamUrl,
          contentType: "application/json",
        },
      })),
      Effect.scoped,
    ))
    expect(retained.runs.map(event => event.status)).toEqual(expect.arrayContaining(["started", "failed"]))
    expect(retained.events).toHaveLength(0)
    expect(JSON.stringify(retained)).not.toContain(awsSecret)
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 rejects a row that smuggles an authorized source into an unapproved target (NODE_OPTIONS exfil)", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-env-bindings-target-mismatch-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const streamPrefix = makeHostStreamPrefix({ namespace, hostId })
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`
    const outputTableStreamUrl = `${baseUrl}/v1/stream/${streamPrefix}.runtimeOutput`

    // Operator authorized (ANTHROPIC_API_KEY, ANTHROPIC_API_KEY). A
    // malicious / untrusted row asks for the same source env but routes
    // it into the child's NODE_OPTIONS — which Node treats as command-
    // line flags and would let the attacker execute arbitrary code if
    // the resolver only gated by source env name. The pair-based
    // resolver must refuse.
    const apiKey = `would-be-injected-into-NODE_OPTIONS-${crypto.randomUUID()}`
    const contextId = await appendRuntimeContext({
      controlPlaneStreamUrl,
      argv: [process.execPath, "--input-type=module", "-e", "process.exit(0)"],
      envBindings: [{ name: "NODE_OPTIONS", ref: "env:ANTHROPIC_API_KEY" }],
      hostId,
      namespace,
    })

    const result = await Effect.runPromise(
      Effect.either(
        startRuntime({ contextId }).pipe(
          Effect.provide(FiregridRuntimeHostWithWorkflowLive(
            { durableStreamsBaseUrl: baseUrl, namespace, hostId },
            authorizingPolicy(
              [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
              { ANTHROPIC_API_KEY: apiKey },
            ),
          )),
        ),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "RuntimeContextError",
        op: "buildCommand.resolveEnvBindings",
      })
      expect(result.left.message).toContain("NODE_OPTIONS")
      expect(result.left.message).toContain("not authorized")
    }

    // The would-be-injected source value should not appear in any
    // retained durable surface.
    const retained = await Effect.runPromise(Effect.gen(function* () {
      const control = yield* RuntimeControlPlaneTable
      const outputTable = yield* RuntimeOutputTable
      const runs = yield* control.runs.query((coll) =>
        coll.toArray.filter(event => event.contextId === contextId))
      const events = yield* outputTable.events.query((coll) =>
        coll.toArray.filter(event => event.contextId === contextId))
      const logs = yield* outputTable.logs.query((coll) =>
        coll.toArray.filter(log => log.contextId === contextId))
      return { runs, events, logs }
    }).pipe(
      Effect.provide(RuntimeControlPlaneTable.layer({
        streamOptions: {
          url: controlPlaneStreamUrl,
          contentType: "application/json",
        },
      })),
      Effect.provide(RuntimeOutputTable.layer({
        streamOptions: {
          url: outputTableStreamUrl,
          contentType: "application/json",
        },
      })),
      Effect.scoped,
    ))
    expect(retained.runs.map(event => event.status)).toEqual(expect.arrayContaining(["started", "failed"]))
    expect(retained.events).toHaveLength(0)
    expect(JSON.stringify(retained)).not.toContain(apiKey)
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 default deny-all policy denies env bindings even with valid env values present", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-env-bindings-default-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`

    const contextId = await appendRuntimeContext({
      controlPlaneStreamUrl,
      argv: [process.execPath, "--input-type=module", "-e", "process.exit(0)"],
      envBindings: [{ name: "FAKE_AGENT_KEY", ref: "env:FAKE_AGENT_KEY" }],
      hostId,
      namespace,
    })

    const result = await Effect.runPromise(
      Effect.either(
        startRuntime({ contextId }).pipe(
          // No env policy override; the default deny-all from the host
          // base layer applies.
          Effect.provide(FiregridRuntimeHostWithWorkflowLive({
            durableStreamsBaseUrl: baseUrl,
            namespace,
            hostId,
          })),
        ),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "RuntimeContextError",
        op: "buildCommand.resolveEnvBindings",
      })
    }
  })
})
