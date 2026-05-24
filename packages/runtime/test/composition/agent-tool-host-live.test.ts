import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeControlPlaneTable,
  local,
  normalizeRuntimeIntent,
} from "@firegrid/protocol/launch"
import { Effect, Option } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FiregridRuntimeHostLive } from "../../src/composition/host-live.ts"
import {
  RuntimeContextInsert,
  RuntimeContextRead,
} from "../../src/tables/runtime-control-plane.ts"
import { AgentToolHost } from "../../src/subscribers/tool-dispatch/tool-host.ts"

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

const hostLayer = (namespace: string) =>
  FiregridRuntimeHostLive({
    durableStreamsBaseUrl: baseUrl!,
    namespace,
    hostId: "host-a",
    hostSessionId: "host-a-session",
    input: true,
    controlRequestReconciler: false,
  })

describe("RuntimeHostAgentToolHostLive", () => {
  it("firegrid-agent-body-plan.WAIT_FOR_CHANNEL.3 starts child sessions and preserves the parent agent runtime when agentKind matches", async () => {
    const namespace = `agent-tool-host-${crypto.randomUUID()}`
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const insert = yield* RuntimeContextInsert
          const read = yield* RuntimeContextRead
          const toolHost = yield* AgentToolHost
          const control = yield* RuntimeControlPlaneTable
          yield* insert.insertLocalContext(
            normalizeRuntimeIntent(
              local.jsonl({
                argv: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.36.1"],
                agent: "claude-acp",
                agentProtocol: "acp",
                runtimeContextMcp: { enabled: true },
              }),
            ),
            { contextId: "ctx-parent", createdBy: "test" },
          )
          const child = yield* toolHost.spawnChildContext({
            parentContextId: "ctx-parent",
            toolUseId: "tool-session-new",
            agentKind: "claude-acp",
            prompt: "Reply with exactly: CHILD_PONG",
          })
          const childContext = yield* read.readContext(child.childContextId)
          const starts = yield* control.startRequests.query((rows) => rows.toArray)
          return { child, childContext, starts }
        }).pipe(Effect.provide(hostLayer(namespace))),
      ),
    )

    expect(result.child.status).toBe("created")
    expect(Option.isSome(result.childContext)).toBe(true)
    if (Option.isNone(result.childContext)) {
      throw new Error("child context was not inserted")
    }
    expect(result.childContext.value.runtime.config).toMatchObject({
      argv: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.36.1"],
      agent: "claude-acp",
      agentProtocol: "acp",
      runtimeContextMcp: { enabled: true },
    })
    expect(result.starts).toEqual([
      expect.objectContaining({
        contextId: result.child.childContextId,
        requestedBy: "agent-tool:ctx-parent",
      }),
    ])
  })
})
