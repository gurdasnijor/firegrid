import { DurableStreamTestServer } from "@durable-streams/server"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  runtimeControlPlaneStreamUrl,
  runtimeContextOutputStreamUrl,
  type HostId,
} from "@firegrid/protocol/launch"
import { encodeRuntimeAgentOutputEnvelope } from "@firegrid/runtime/events"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AgentToolHost } from "../../src/agent-tools/execution/tool-host.ts"
import { FiregridRuntimeHostWithWorkflowLive } from "../../src/host/index.ts"

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

const seedContext = (input: {
  readonly namespace: string
  readonly hostId: HostId
  readonly contextId: string
}) =>
  Effect.gen(function*() {
    const table = yield* RuntimeControlPlaneTable
    yield* table.contexts.upsert({
      contextId: input.contextId,
      createdAt: new Date().toISOString(),
      runtime: normalizeRuntimeIntent(local.jsonl({
        argv: [process.execPath, "--version"],
      })),
      host: {
        hostId: input.hostId,
        streamPrefix: makeHostStreamPrefix({
          namespace: input.namespace,
          hostId: input.hostId,
        }),
        boundAtMs: Date.now(),
      },
    })
  })

const appendPermissionRequest = (input: {
  readonly namespace: string
  readonly hostId: HostId
  readonly contextId: string
}) =>
  Effect.gen(function*() {
    const table = yield* RuntimeOutputTable
    yield* table.events.upsert({
      eventId: {
        contextId: input.contextId,
        activityAttempt: 1,
        target: "events",
        sequence: 1,
      },
      contextId: input.contextId,
      activityAttempt: 1,
      sequence: 1,
      source: "stdout",
      format: "jsonl",
      receivedAt: new Date().toISOString(),
      raw: encodeRuntimeAgentOutputEnvelope({
        _tag: "PermissionRequest",
        permissionRequestId: "permission-1",
        toolUseId: "tool-needing-permission",
        options: [
          {
            optionId: "allow_once",
            kind: "allow_once",
            name: "Allow once",
          },
        ],
      }),
    })
  }).pipe(
    Effect.provide(RuntimeOutputTable.layer({
      streamOptions: {
        url: runtimeContextOutputStreamUrl({
          baseUrl: baseUrl!,
          prefix: makeHostStreamPrefix({
            namespace: input.namespace,
            hostId: input.hostId,
          }),
          contextId: input.contextId,
        }),
        contentType: "application/json",
      },
    })),
  )

describe("RuntimeHostAgentToolHostLive", () => {
  it("firegrid-agent-body-plan.APPROVAL_CALL.3 routes approval call-channel requests through permission wait + response ingress", async () => {
    if (baseUrl === undefined) throw new Error("server not started")
    const namespace = `approval-channel-${crypto.randomUUID()}`
    const hostId = `host_${crypto.randomUUID()}` as HostId
    const contextId = `ctx_${crypto.randomUUID()}`
    const host = FiregridRuntimeHostWithWorkflowLive({
      durableStreamsBaseUrl: baseUrl,
      namespace,
      hostId,
      controlRequestReconciler: false,
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* seedContext({ namespace, hostId, contextId })
        yield* appendPermissionRequest({ namespace, hostId, contextId })
        const agentToolHost = yield* AgentToolHost
        return yield* agentToolHost.callApprovalChannel({
          toolUseId: "tool-call",
          contextId,
          channel: "approval.operator",
          request: {
            decision: { _tag: "Allow", optionId: "allow_once" },
            timeoutMs: 100,
          },
        })
      }).pipe(
        Effect.provide(host),
        Effect.scoped,
      ),
    )

    expect(result).toMatchObject({
      matched: true,
      request: {
        contextId,
        permissionRequestId: "permission-1",
        toolUseId: "tool-needing-permission",
      },
      response: {
        responded: true,
        contextId,
        permissionRequestId: "permission-1",
      },
    })

    const intents = await Effect.runPromise(
      Effect.gen(function*() {
        const table = yield* RuntimeControlPlaneTable
        return yield* table.inputIntents.query(coll =>
          coll.toArray.filter(row => row.contextId === contextId),
        )
      }).pipe(
        Effect.provide(RuntimeControlPlaneTable.layer({
          streamOptions: {
            url: runtimeControlPlaneStreamUrl({ baseUrl, namespace }),
            contentType: "application/json",
          },
        })),
        Effect.scoped,
      ),
    )

    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({
      contextId,
      kind: "required_action_result",
      authoredBy: "client",
      payload: {
        _tag: "PermissionResponse",
        permissionRequestId: "permission-1",
        decision: { _tag: "Allow", optionId: "allow_once" },
      },
    })
  })
})
