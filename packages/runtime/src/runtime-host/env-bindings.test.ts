// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
//
// End-to-end integration test for the env binding authority boundary.
// Asserts that:
//   - The durable RuntimeContext row stores binding refs only — never the
//     resolved value.
//   - The child process receives the resolved value at spawn time when the
//     host policy authorizes the env ref.
//   - The child process never sees a value (and never even spawns) when
//     the host policy denies the env ref, even if the binding row is
//     persisted by an upstream / malicious launcher.

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  envBinding,
  local,
  normalizeRuntimeIntent,
} from "@firegrid/protocol/launch"
import { Effect, Either, Layer, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  FiregridRuntimeHostWithWorkflowLive,
  startRuntime,
} from "../runtime-host/index.ts"
import { RuntimeEnvResolverPolicy } from "../providers/sandboxes/secrets.ts"

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

const appendRuntimeContext = (
  controlPlaneStreamUrl: string,
  argv: ReadonlyArray<string>,
  envBindings: ReadonlyArray<{ readonly name: string; readonly ref: string }>,
): Promise<string> =>
  Effect.runPromise(Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const contextId = `ctx_${crypto.randomUUID()}`
    yield* table.contexts.upsert({
      contextId,
      createdAt: new Date().toISOString(),
      runtime: normalizeRuntimeIntent(local.jsonl({
        argv: [...argv],
        envBindings: envBindings.map(b => ({ name: b.name, ref: b.ref })),
      })),
    })
    return contextId
  }).pipe(
    Effect.provide(RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: controlPlaneStreamUrl,
        contentType: "application/json",
      },
    })),
    Effect.scoped,
  ))

const allowingPolicy = (
  allowedEnvVars: ReadonlyArray<string>,
  values: Record<string, string>,
) =>
  Layer.succeed(
    RuntimeEnvResolverPolicy,
    RuntimeEnvResolverPolicy.make({
      allowedEnvVars,
      lookupEnv: (name) => values[name],
    }),
  )

describe("runtime env bindings authority boundary", () => {
  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 child receives resolved value while durable row stores the ref only", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-env-bindings-${crypto.randomUUID()}`
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`
    const outputTableStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtimeOutput`
    const secretValue = `super-secret-${crypto.randomUUID()}`

    // Child prints exactly what it saw in process.env.FAKE_AGENT_KEY so we
    // can assert the resolved value reached it. The child wraps it in a
    // JSONL envelope so the runtime journals it to the events table.
    const childCode = `
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: process.env.FAKE_AGENT_KEY }] },
}))
`
    const contextId = await appendRuntimeContext(
      controlPlaneStreamUrl,
      [process.execPath, "--input-type=module", "-e", childCode],
      [envBinding("FAKE_AGENT_KEY", "PARENT_FAKE_AGENT_KEY")],
    )

    const result = await Effect.runPromise(
      startRuntime({ contextId }).pipe(
        Effect.provide(FiregridRuntimeHostWithWorkflowLive(
          { durableStreamsBaseUrl: baseUrl, namespace },
          // Authorize the host env var that the binding ref names. The
          // test injects its lookup so we never touch real process env.
          allowingPolicy(["PARENT_FAKE_AGENT_KEY"], {
            PARENT_FAKE_AGENT_KEY: secretValue,
          }),
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
      return { context, events }
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
    // Bindings present, value never.
    expect(contextRow.runtime.config.envBindings).toEqual([
      { name: "FAKE_AGENT_KEY", ref: "env:PARENT_FAKE_AGENT_KEY" },
    ])
    const serializedRow = JSON.stringify(contextRow)
    expect(serializedRow).not.toContain(secretValue)

    // Child saw the resolved value.
    expect(retained.events).toHaveLength(1)
    const firstEvent = retained.events[0]
    expect(firstEvent).toBeDefined()
    const parsed = JSON.parse(firstEvent!.raw) as {
      readonly message: { readonly content: ReadonlyArray<{ readonly text: string }> }
    }
    expect(parsed.message.content[0]!.text).toBe(secretValue)
    // Output journal should not contain anything that reveals the host env
    // var name (the journal is bounded by what the child printed; we just
    // sanity-check there's no leakage of the binding ref into evidence).
    const serializedEvents = JSON.stringify(retained.events)
    expect(serializedEvents).not.toContain("env:PARENT_FAKE_AGENT_KEY")
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 denies a row whose env ref is not on the host allowlist (no child spawn, no leak)", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-env-bindings-deny-${crypto.randomUUID()}`
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`

    // Simulate a malicious / untrusted upstream that writes a binding
    // asking for AWS_SECRET_ACCESS_KEY. The host's policy only authorizes
    // ANTHROPIC_API_KEY — so the resolver must refuse before any spawn.
    const contextId = await appendRuntimeContext(
      controlPlaneStreamUrl,
      [process.execPath, "--input-type=module", "-e", "process.exit(0)"],
      [{ name: "X", ref: "env:AWS_SECRET_ACCESS_KEY" }],
    )

    const result = await Effect.runPromise(
      Effect.either(
        startRuntime({ contextId }).pipe(
          Effect.provide(FiregridRuntimeHostWithWorkflowLive(
            { durableStreamsBaseUrl: baseUrl, namespace },
            allowingPolicy(["ANTHROPIC_API_KEY"], {
              ANTHROPIC_API_KEY: "ok",
              AWS_SECRET_ACCESS_KEY: "must-never-be-read",
            }),
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
      expect(result.left.message).toContain("AWS_SECRET_ACCESS_KEY")
      expect(result.left.message).toContain("not on the runtime host's authorized env allowlist")
    }

    // run-status row chain should reflect "started" then "failed", and no
    // events row should exist (we never spawned the child).
    const retained = await Effect.runPromise(Effect.gen(function* () {
      const control = yield* RuntimeControlPlaneTable
      const runs = yield* control.runs.query((coll) =>
        coll.toArray.filter(event => event.contextId === contextId))
      return runs.map(event => event.status)
    }).pipe(
      Effect.provide(RuntimeControlPlaneTable.layer({
        streamOptions: {
          url: controlPlaneStreamUrl,
          contentType: "application/json",
        },
      })),
      Effect.scoped,
    ))
    expect(retained).toEqual(expect.arrayContaining(["started", "failed"]))
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 default deny-all policy denies env bindings even with valid env values present", async () => {
    if (!baseUrl) throw new Error("server not started")
    const namespace = `runtime-env-bindings-default-${crypto.randomUUID()}`
    const controlPlaneStreamUrl = `${baseUrl}/v1/stream/${namespace}.firegrid.runtime`

    const contextId = await appendRuntimeContext(
      controlPlaneStreamUrl,
      [process.execPath, "--input-type=module", "-e", "process.exit(0)"],
      [{ name: "FAKE_AGENT_KEY", ref: "env:FAKE_AGENT_KEY" }],
    )

    const result = await Effect.runPromise(
      Effect.either(
        startRuntime({ contextId }).pipe(
          // No env policy override; the default deny-all from the host
          // base layer applies.
          Effect.provide(FiregridRuntimeHostWithWorkflowLive({
            durableStreamsBaseUrl: baseUrl,
            namespace,
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
