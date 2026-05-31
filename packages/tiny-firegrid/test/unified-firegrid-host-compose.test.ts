/**
 * FiregridHost composition smoke test.
 *
 * Proves the canonical production composition factory builds without
 * errors and provides all the Tags a Firegrid client expects.
 * Does NOT exercise the codec — that's scenario 8/9's job. This test
 * is a Layer-build / type-channel sanity check:
 *
 *   - `FiregridHost({codec: "acp", ...})` returns a Layer that resolves
 *     to never (no missing requirements).
 *   - The Layer satisfies the substrate Tags (`RuntimeControlPlaneTable`,
 *     `RuntimeOutputTable`, `SignalTable`, `UnifiedTable`,
 *     `WorkflowEngine`).
 *   - The Layer satisfies the channel Tags (HostPromptChannel,
 *     SessionPromptChannel, HostSessionsStart, etc.).
 *
 * Treats the factory as a black box: builds it, asks for the services
 * via `Effect.scoped` + `yield* Tag`, asserts none are missing.
 */

// eslint-disable-next-line no-restricted-imports
import { DurableStreamTestServer } from "@durable-streams/server"
import { WorkflowEngine } from "@effect/workflow"
import {
  HostContextsCreateChannel,
  HostPermissionRespondChannel,
  HostPromptChannel,
  HostSessionsStartChannel,
  SessionPromptChannel,
} from "@firegrid/protocol/channels"
import {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
} from "@firegrid/protocol/launch"
import {
  FiregridHost,
  SignalTable,
  UnifiedTable,
} from "@firegrid/runtime/unified"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

describe("FiregridHost composition", () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
    baseUrl = await server.start()
  })

  afterAll(async () => {
    await server.stop()
  })

  it("composes with `codec: \"acp\"` sugar and provides every public Tag", async () => {
    const host = FiregridHost({
      codec: "acp",
      durableStreamsBaseUrl: baseUrl,
      namespace: "smoke-test",
    })

    const program = Effect.gen(function*() {
      const control = yield* RuntimeControlPlaneTable
      const output = yield* RuntimeOutputTable
      const signals = yield* SignalTable
      const unified = yield* UnifiedTable
      const engine = yield* WorkflowEngine.WorkflowEngine
      const session = yield* CurrentHostSession
      const hostPrompt = yield* HostPromptChannel
      const sessionPrompt = yield* SessionPromptChannel
      const start = yield* HostSessionsStartChannel
      const respond = yield* HostPermissionRespondChannel
      const create = yield* HostContextsCreateChannel
      return {
        controlPresent: control !== undefined,
        outputPresent: output !== undefined,
        signalsPresent: signals !== undefined,
        unifiedPresent: unified !== undefined,
        enginePresent: engine !== undefined,
        sessionPresent: session !== undefined,
        hostPromptDirection: hostPrompt.direction,
        sessionPromptHasForSession: typeof sessionPrompt.forSession === "function",
        startDirection: start.direction,
        respondDirection: respond.direction,
        createDirection: create.direction,
        hostId: String(session.hostId),
        streamPrefix: String(session.streamPrefix),
      }
    })

    const result = await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(host))),
    )

    expect(result.controlPresent).toBe(true)
    expect(result.outputPresent).toBe(true)
    expect(result.signalsPresent).toBe(true)
    expect(result.unifiedPresent).toBe(true)
    expect(result.enginePresent).toBe(true)
    expect(result.sessionPresent).toBe(true)
    expect(result.hostPromptDirection).toBe("egress")
    expect(result.sessionPromptHasForSession).toBe(true)
    expect(result.startDirection).toBe("egress")
    expect(result.respondDirection).toBe("egress")
    expect(result.createDirection).toBe("call")
    expect(result.hostId).toBe("smoke-test-host")
    expect(result.streamPrefix).toBe("smoke-test.firegrid.host.smoke-test-host")
  }, 10_000)
})
