// tf-r06u.28 slice 2 — green sleep end-to-end through the relay-free
// MCP-entry Shape D dispatch.
//
// Proves:
//   A. `ToolDispatch.call({ toolName: "sleep" })` returns the typed output
//      `{ slept: true }` through `McpToolDispatchWorkflow` on a real
//      `DurableStreamsWorkflowEngine` — the sleep milestone.
//   B. at-most-once: a repeated `toolUseId` runs the shared arm exactly once
//      (`Workflow.idempotencyKey: toolUseId` memoization — the Shape D C3
//      mechanism; no separate result table), and the second call returns the
//      memoized result.
//   C. channel tools lower onto RuntimeChannelRouter rather than falling
//      through to the unported default.
//   D. honest surface: a tool not yet ported fails on the typed `ToolError`
//      channel (which `@effect/ai`'s McpServer lowers to `isError:true`),
//      not a thrown defect.

import { WorkflowEngine } from "@effect/workflow"
import { DurableStreamTestServer } from "@durable-streams/server"
import * as AgentToolSchemas from "@firegrid/protocol/agent-tools"
import {
  eventOffset,
  HostPermissionRespondChannel,
  HostPermissionRespondChannelRequestSchema,
  HostPromptChannel,
  HostPromptChannelTarget,
  HostPermissionRespondChannelTarget,
  HostSessionsCreateOrLoadChannel,
  HostSessionsCreateOrLoadChannelTarget,
  HostSessionsCreateOrLoadRequestSchema,
  HostSessionsCreateOrLoadResponseSchema,
  HostSessionsStartChannel,
  HostSessionsStartChannelTarget,
  HostSessionsStartRequestSchema,
  makeCallableChannel,
  makeDurableEventChannel,
  makeEgressChannel,
  SessionCancelChannel,
  SessionCancelChannelTarget,
  SessionCloseChannel,
  SessionCloseChannelTarget,
  SessionPromptChannel,
  SessionPromptChannelTarget,
} from "@firegrid/protocol/channels"
import {
  CurrentHostSession,
  HostIdSchema,
  HostSessionIdSchema,
  makeHostSessionRow,
  makeRuntimeContext,
  normalizeRuntimeIntent,
  RuntimeControlPlaneTable,
  runtimeControlPlaneStreamUrl,
} from "@firegrid/protocol/launch"
import { RuntimeContextSessionAdapter } from "../../src/unified/adapter.ts"
import { RuntimeContextSessionWorkflowLayer } from "../../src/unified/subscribers/runtime-context.ts"
import { PublicPromptRequestSchema } from "@firegrid/protocol/runtime-ingress"
import { SessionHandlePromptInputSchema } from "@firegrid/protocol/session-facade"
import { Effect, Exit, Layer, Option, Ref, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  HostControlChannelBindingsLive,
  HostPlaneChannelRouter,
  HostPlaneSessionControlRouterLive,
  RuntimeChannelRouter,
  makeRuntimeChannelRouter,
  runtimeRouteFromChannel,
} from "../../src/channels/index.ts"
import { DurableStreamsWorkflowEngine } from "../../src/engine/durable-streams-workflow-engine.ts"
import { ContextResolverTag } from "../../src/tables/codec-adapter-tags.ts"
import {
  buildMcpToolDispatchLayer,
  makeFiregridAgentToolExecutor,
  McpToolDispatchWorkflow,
  ToolDispatch,
  ToolDispatchLive,
} from "../../src/unified/mcp-host/tool-dispatch.ts"

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

const streamUrlFor = (tag: string): string =>
  `${baseUrl}/v1/stream/mcp-tool-dispatch-${tag}-${crypto.randomUUID()}`

const controlPlaneLayer = (namespace: string) =>
  RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl({
        baseUrl: baseUrl!,
        namespace,
      }),
      contentType: "application/json",
    },
  })

const currentHostSessionLayer = (namespace: string) =>
  Layer.succeed(
    CurrentHostSession,
    makeHostSessionRow({
      hostId: Schema.decodeSync(HostIdSchema)("mcp-tool-dispatch-host"),
      hostSessionId: Schema.decodeSync(HostSessionIdSchema)(
        "mcp-tool-dispatch-host-session",
      ),
      namespace,
      startedAtMs: 0,
    }),
  )

const contextResolverFromControlPlaneTable = Layer.effect(
  ContextResolverTag,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return {
      resolve: (contextId: string) => control.contexts.get(contextId),
    }
  }),
)

const hostPlaneNoopEventChannelsLayer = Layer.mergeAll(
  Layer.succeed(
    HostSessionsStartChannel,
    makeDurableEventChannel({
      target: HostSessionsStartChannelTarget,
      schema: HostSessionsStartRequestSchema,
      append: request =>
        Effect.succeed(eventOffset(`host.sessions.start:${request.sessionId}`)),
    }),
  ),
  Layer.succeed(
    SessionPromptChannel,
    SessionPromptChannel.of({
      forSession: sessionId =>
        makeDurableEventChannel({
          target: SessionPromptChannelTarget,
          schema: SessionHandlePromptInputSchema,
          append: request =>
            Effect.succeed(
              eventOffset(`session.prompt:${sessionId}:${request.idempotencyKey}`),
            ),
        }),
    }),
  ),
  Layer.succeed(
    SessionCancelChannel,
    makeDurableEventChannel({
      target: SessionCancelChannelTarget,
      schema: AgentToolSchemas.SessionCancelToolInputSchema,
      append: request =>
        Effect.succeed(eventOffset(`session.cancel:${request.sessionId}`)),
    }),
  ),
  Layer.succeed(
    SessionCloseChannel,
    makeDurableEventChannel({
      target: SessionCloseChannelTarget,
      schema: AgentToolSchemas.SessionCloseToolInputSchema,
      append: request =>
        Effect.succeed(eventOffset(`session.close:${request.sessionId}`)),
    }),
  ),
  Layer.succeed(
    HostPermissionRespondChannel,
    makeDurableEventChannel({
      target: HostPermissionRespondChannelTarget,
      schema: HostPermissionRespondChannelRequestSchema,
      append: request =>
        Effect.succeed(
          eventOffset(`host.permissions.respond:${request.contextId}:${request.permissionRequestId}`),
        ),
    }),
  ),
)

const sessionNewHostPlaneLayer = HostPlaneSessionControlRouterLive.pipe(
  Layer.provideMerge(HostControlChannelBindingsLive),
  Layer.provideMerge(hostPlaneNoopEventChannelsLayer),
)

const hostSessionsCreateOrLoadStubLayer = Layer.succeed(
  HostSessionsCreateOrLoadChannel,
  makeCallableChannel({
    target: HostSessionsCreateOrLoadChannelTarget,
    requestSchema: HostSessionsCreateOrLoadRequestSchema,
    responseSchema: HostSessionsCreateOrLoadResponseSchema,
    call: request =>
      Effect.succeed(
        Schema.decodeSync(HostSessionsCreateOrLoadResponseSchema)({
          sessionId: `session:${request.externalKey.source}:${request.externalKey.id}`,
          contextId: `session:${request.externalKey.source}:${request.externalKey.id}`,
        }),
      ),
  }),
)

const hostPlanePermissionRouterLayer = HostPlaneSessionControlRouterLive.pipe(
  Layer.provideMerge(hostSessionsCreateOrLoadStubLayer),
  Layer.provideMerge(hostPlaneNoopEventChannelsLayer),
)

const runWith = <A, E, R>(
  streamUrl: string,
  workflowLayer: Layer.Layer<R, unknown, WorkflowEngine.WorkflowEngine>,
  effect: Effect.Effect<A, E, R | WorkflowEngine.WorkflowEngine>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          workflowLayer.pipe(
            Layer.provideMerge(DurableStreamsWorkflowEngine.layer({ streamUrl })),
          ),
        ),
      ),
    ),
  )

const promptRecorderLayer = (
  prompts: Ref.Ref<Array<unknown>>,
): Layer.Layer<HostPromptChannel> =>
  Layer.succeed(
    HostPromptChannel,
    makeDurableEventChannel({
      target: HostPromptChannelTarget,
      schema: PublicPromptRequestSchema,
      append: (request) =>
        Ref.update(prompts, current => [...current, request]).pipe(
          Effect.as({
            target: String(HostPromptChannelTarget),
            offset: `prompt:${request.contextId}:${request.idempotencyKey ?? ""}`,
          }),
        ),
    }),
  )

const channelRouterLayer = (options: {
  readonly sent: Ref.Ref<Array<unknown>>
  readonly calls: Ref.Ref<Array<unknown>>
}): Layer.Layer<RuntimeChannelRouter> =>
  Layer.succeed(
    RuntimeChannelRouter,
    makeRuntimeChannelRouter([
      runtimeRouteFromChannel(makeEgressChannel({
        target: "test.egress",
        schema: Schema.Unknown,
        append: payload =>
          Ref.update(options.sent, current => [...current, payload]).pipe(
            Effect.asVoid,
          ),
      })),
      runtimeRouteFromChannel(makeCallableChannel({
        target: "test.call",
        requestSchema: Schema.Unknown,
        responseSchema: Schema.Unknown,
        call: request =>
          Ref.update(options.calls, current => [...current, request]).pipe(
            Effect.as({ ok: true, request }),
          ),
      })),
    ]),
  )

describe("mcp-host: relay-free MCP-entry sleep dispatch", () => {
  it("A. sleep returns the typed output { slept: true } through ToolDispatch.call", async () => {
    const result = await runWith(
      streamUrlFor("sleep"),
      ToolDispatchLive,
      Effect.gen(function*() {
        const dispatch = yield* ToolDispatch
        return yield* dispatch.call({
          contextId: "ctx-sleep",
          toolUseId: "tu-sleep-1",
          toolName: "sleep",
          input: { durationMs: 5 },
        })
      }),
    )
    expect(result).toEqual({ slept: true })
  })

  it("B. same toolUseId runs the arm exactly once (idempotencyKey memo)", async () => {
    // Hold the executor instance so we can read its invocation counter
    // after driving the workflow twice with the same toolUseId.
    const executor = await Effect.runPromise(makeFiregridAgentToolExecutor())
    const observed = await runWith(
      streamUrlFor("idem"),
      buildMcpToolDispatchLayer(executor),
      Effect.gen(function*() {
        const engine = yield* WorkflowEngine.WorkflowEngine
        const exec = (durationMs: number) =>
          McpToolDispatchWorkflow.execute({
            contextId: "ctx-idem",
            attempt: 1,
            toolUseId: "tu-idem-same",
            toolName: "sleep",
            inputJson: JSON.stringify({ durationMs }),
          }).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine))
        const first = yield* exec(3)
        // Different input, same toolUseId → memoized first result.
        const second = yield* exec(99)
        const invocations = yield* Ref.get(executor.state.invocationCount)
        return { first, second, invocations }
      }),
    )
    expect(observed.invocations).toBe(1)
    expect(observed.second).toEqual(observed.first)
    expect(JSON.parse(observed.first.resultJson)).toEqual({ slept: true })
  })

  it("C. agentic-patterns-primitive-profile.LOCKED_TOOL_SURFACE.1 agentic-patterns-primitive-profile.LOCKED_TOOL_SURFACE.4 send dispatches through RuntimeChannelRouter", async () => {
    const sent = await Effect.runPromise(Ref.make<Array<unknown>>([]))
    const calls = await Effect.runPromise(Ref.make<Array<unknown>>([]))
    const result = await runWith(
      streamUrlFor("send"),
      ToolDispatchLive.pipe(Layer.provideMerge(channelRouterLayer({ sent, calls }))),
      Effect.gen(function*() {
        const dispatch = yield* ToolDispatch
        const output = yield* dispatch.call({
          contextId: "ctx-send",
          toolUseId: "tu-send-1",
          toolName: "send",
          input: { channel: "test.egress", payload: { eventType: "ready" } },
        })
        const sentPayloads = yield* Ref.get(sent)
        const callPayloads = yield* Ref.get(calls)
        return { output, sentPayloads, callPayloads }
      }),
    )
    expect(result.output).toEqual({ sent: true, channel: "test.egress" })
    expect(result.sentPayloads).toEqual([{ eventType: "ready" }])
    expect(result.callPayloads).toEqual([])
  })

  it("C. agentic-patterns-primitive-profile.LOCKED_TOOL_SURFACE.1 agentic-patterns-primitive-profile.LOCKED_TOOL_SURFACE.4 call dispatches through RuntimeChannelRouter", async () => {
    const sent = await Effect.runPromise(Ref.make<Array<unknown>>([]))
    const calls = await Effect.runPromise(Ref.make<Array<unknown>>([]))
    const result = await runWith(
      streamUrlFor("call"),
      ToolDispatchLive.pipe(Layer.provideMerge(channelRouterLayer({ sent, calls }))),
      Effect.gen(function*() {
        const dispatch = yield* ToolDispatch
        const output = yield* dispatch.call({
          contextId: "ctx-call",
          toolUseId: "tu-call-1",
          toolName: "call",
          input: { channel: "test.call", request: { command: "approve" } },
        })
        const sentPayloads = yield* Ref.get(sent)
        const callPayloads = yield* Ref.get(calls)
        return { output, sentPayloads, callPayloads }
      }),
    )
    expect(result.output).toEqual({
      ok: true,
      request: { command: "approve" },
    })
    expect(result.callPayloads).toEqual([{ command: "approve" }])
    expect(result.sentPayloads).toEqual([])
  })

  it("tf-nors: dedicated permission.respond dispatches through HostPlaneChannelRouter", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const router = yield* HostPlaneChannelRouter
          return yield* router.dispatch({
            target: String(HostPermissionRespondChannelTarget),
            verb: "call",
            payload: {
              contextId: "ctx-permission-respond",
              permissionRequestId: "permission-1",
              decision: { _tag: "Allow", optionId: "allow_once" },
            },
          })
        }).pipe(Effect.provide(hostPlanePermissionRouterLayer)),
      ),
    )

    expect(result).toEqual({
      offset: "host.permissions.respond:ctx-permission-respond:permission-1",
    })
  })

  it("D. execute remains PO-owned and fails on the typed ToolError channel", async () => {
    const exit = await runWith(
      streamUrlFor("unported"),
      ToolDispatchLive,
      Effect.gen(function*() {
        const dispatch = yield* ToolDispatch
        return yield* dispatch.call({
          contextId: "ctx-unported",
          toolUseId: "tu-execute-1",
          toolName: "execute",
          input: { input: {} },
        })
      }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("not yet ported")
    }
  })

  it("firegrid-factory-aligned-agent-tools.SESSION.1 firegrid-factory-aligned-agent-tools.OBSERVATION.1 persists session_new child context row with parentContextId", async () => {
    const namespace = `session-new-parent-fk-${crypto.randomUUID()}`
    const parentContextId = "ctx-parent-session-new-fk"
    const toolUseId = "tu-session-new-fk"
    const result = await runWith(
      streamUrlFor("session-new-parent-fk"),
      ToolDispatchLive.pipe(
        Layer.provideMerge(contextResolverFromControlPlaneTable),
        Layer.provideMerge(sessionNewHostPlaneLayer),
        Layer.provideMerge(controlPlaneLayer(namespace)),
        Layer.provideMerge(currentHostSessionLayer(namespace)),
      ),
      Effect.gen(function*() {
        const control = yield* RuntimeControlPlaneTable
        const hostSession = yield* CurrentHostSession
        yield* control.contexts.insertOrGet(
          makeRuntimeContext({
            contextId: parentContextId,
            createdAtMs: 0,
            createdBy: "test-parent",
            runtime: normalizeRuntimeIntent({
              provider: "local-process",
              config: {
                argv: ["node", "parent-agent.js"],
                agent: "parent-agent",
                agentProtocol: "acp",
              },
            }),
            host: {
              hostId: hostSession.hostId,
              streamPrefix: hostSession.streamPrefix,
              boundAtMs: 0,
            },
          }),
        )

        const dispatch = yield* ToolDispatch
        const output = yield* dispatch.call({
          contextId: parentContextId,
          toolUseId,
          toolName: "session_new",
          input: {
            agentKind: "child-agent",
            prompt: "Implement the child task.",
          },
        }).pipe(
          Effect.flatMap(Schema.decodeUnknown(AgentToolSchemas.SessionNewToolOutputSchema)),
        )
        const child = yield* control.contexts.get(output.session.contextId)
        return { output, child }
      }),
    )

    expect(result.output.session.metadata).toMatchObject({ parentContextId })
    expect(Option.isSome(result.child)).toBe(true)
    if (!Option.isSome(result.child)) throw new Error("expected child context row")
    expect(result.child.value).toMatchObject({
      contextId: `session:firegrid.mcp.session_new:${parentContextId}:${toolUseId}`,
      createdBy: `mcp:${parentContextId}`,
      parentContextId,
    })
  })

  it("tf-0awo.15: wait_until without prompt resolves inline without appending a new turn", async () => {
    const prompts = await Effect.runPromise(Ref.make<Array<unknown>>([]))
    const result = await runWith(
      streamUrlFor("wait-until-inline"),
      ToolDispatchLive.pipe(Layer.provideMerge(promptRecorderLayer(prompts))),
      Effect.gen(function*() {
        const dispatch = yield* ToolDispatch
        const output = yield* dispatch.call({
          contextId: "ctx-wait-inline",
          toolUseId: "tu-wait-inline",
          toolName: "wait_until",
          input: { time: "+0ms" },
        })
        const appended = yield* Ref.get(prompts)
        return { output, appended }
      }),
    )
    expect(result.output).toMatchObject({ waited: true })
    expect(result.appended).toEqual([])
  })

  it("tf-0awo.15: wait_until with prompt appends a deterministic self prompt on resolve", async () => {
    const prompts = await Effect.runPromise(Ref.make<Array<unknown>>([]))
    const result = await runWith(
      streamUrlFor("wait-until-prompt"),
      ToolDispatchLive.pipe(Layer.provideMerge(promptRecorderLayer(prompts))),
      Effect.gen(function*() {
        const dispatch = yield* ToolDispatch
        const output = yield* dispatch.call({
          contextId: "ctx-wait-prompt",
          toolUseId: "tu-wait-prompt",
          toolName: "wait_until",
          input: { time: "+0ms", prompt: "Check the build." },
        })
        const appended = yield* Ref.get(prompts)
        return { output, appended }
      }),
    )
    expect(result.output).toMatchObject({ waited: true })
    expect(result.appended).toEqual([
      {
        contextId: "ctx-wait-prompt",
        payload: "Check the build.",
        idempotencyKey: "wait-prompt:tu-wait-prompt",
      },
    ])
  })

  // tf-hzln SPIKE — channel-collapse viability.
  // session_close is dispatched DIRECT to the durable terminal op
  // (emitSessionTerminalSignal → RuntimeContextSessionWorkflow), bypassing the
  // channel router. This composition provides NO HostPlaneChannelRouter and NO
  // RuntimeChannelRouter — before the direct rewire, session_close went through
  // hostPlaneDispatch and would fail "session tools require HostPlaneChannelRouter".
  // It now succeeds AND drives the real terminal body (adapter.deregister),
  // proving the router was pure indirection for this fixed-target op.
  it("tf-hzln: session_close dispatches direct to the terminal op — no channel router", async () => {
    const namespace = `session-close-direct-${crypto.randomUUID()}`
    const contextId = "ctx-close-direct"
    const deregistered = await Effect.runPromise(Ref.make<Array<string>>([]))
    const recordingAdapter = Layer.succeed(RuntimeContextSessionAdapter, {
      startOrAttach: () => Effect.void,
      send: () => Effect.void,
      deregister: (ctx) => Ref.update(deregistered, (current) => [...current, ctx]),
    })
    const result = await runWith(
      streamUrlFor("session-close-direct"),
      ToolDispatchLive.pipe(
        Layer.provideMerge(RuntimeContextSessionWorkflowLayer),
        Layer.provideMerge(recordingAdapter),
        Layer.provideMerge(contextResolverFromControlPlaneTable),
        Layer.provideMerge(controlPlaneLayer(namespace)),
        Layer.provideMerge(currentHostSessionLayer(namespace)),
      ),
      Effect.gen(function*() {
        const control = yield* RuntimeControlPlaneTable
        const hostSession = yield* CurrentHostSession
        yield* control.contexts.insertOrGet(
          makeRuntimeContext({
            contextId,
            createdAtMs: 0,
            runtime: normalizeRuntimeIntent({
              provider: "local-process",
              config: {
                argv: ["node", "agent.js"],
                agent: "spike-agent",
                agentProtocol: "acp",
              },
            }),
            host: {
              hostId: hostSession.hostId,
              streamPrefix: hostSession.streamPrefix,
              boundAtMs: 0,
            },
          }),
        )
        const dispatch = yield* ToolDispatch
        const output = yield* dispatch.call({
          contextId,
          toolUseId: "tu-close-direct",
          toolName: "session_close",
          input: { sessionId: contextId, reason: "tf-hzln spike" },
        }).pipe(
          Effect.flatMap(Schema.decodeUnknown(AgentToolSchemas.SessionCloseToolOutputSchema)),
        )
        // The terminal input is enqueued (discard); the engine runs the body
        // asynchronously. Settle, then read whether the real terminal handler
        // drove adapter.deregister.
        yield* Effect.sleep("3000 millis")
        const seen = yield* Ref.get(deregistered)
        return { output, seen }
      }),
    )
    expect(result.output).toEqual({ closed: true, sessionId: contextId })
    expect(result.seen).toContain(contextId)
  })
})
