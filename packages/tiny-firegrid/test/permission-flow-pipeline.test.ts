import { DurableStreamTestServer } from "@durable-streams/server"
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import {
  Firegrid,
  FiregridConfig,
  FiregridRuntimeTables,
  FiregridStandaloneLive,
  local,
  type FiregridConfigError,
  type FiregridService,
  type FiregridSessionHandle,
  type RuntimeContextSnapshot,
} from "@firegrid/client-sdk/firegrid"
import { runtimeControlPlaneStreamUrl } from "@firegrid/protocol/launch"
import { Clock, Effect, Layer, Option, Stream, type Context, type Scope } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tinyPermissionFlowPipeline } from "../src/configurations/permission-flow-pipeline.ts"

type ControlPlaneService = Context.Tag.Service<typeof FiregridRuntimeTables.ControlPlane>
type AgentOutputObservation = RuntimeContextSnapshot["agentOutputs"][number]

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

const permissionAgentScript = `
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

class PermissionAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Set();
  }

  async initialize() {
    return {
      protocolVersion: ${JSON.stringify(PROTOCOL_VERSION)},
      agentCapabilities: { loadSession: false }
    };
  }

  async newSession() {
    const sessionId = "tiny-permission-session";
    this.sessions.add(sessionId);
    return { sessionId };
  }

  async authenticate() {
    return {};
  }

  async prompt(params) {
    this.sessions.add(params.sessionId);
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-permission",
        title: "edit config",
        kind: "edit",
        status: "pending",
        rawInput: { path: "config.json" }
      }
    });
    const permission = await this.connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "tool-permission",
        title: "edit config",
        kind: "edit",
        status: "pending",
        rawInput: { path: "config.json" }
      },
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow once" },
        { optionId: "deny", kind: "reject_once", name: "Deny" }
      ]
    });
    const selected = permission.outcome.outcome === "selected"
      ? permission.outcome.optionId
      : permission.outcome.outcome;
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "permission-result",
        content: {
          type: "text",
          text: "FIREGRID_PERMISSION_RESULT " + permission.outcome.outcome + ":" + selected
        }
      }
    });
    setTimeout(() => process.exit(0), 25);
    return {
      stopReason: "end_turn",
      ...(params.messageId === undefined ? {} : { userMessageId: params.messageId })
    };
  }

  async cancel() {}
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
new acp.AgentSideConnection(connection => new PermissionAgent(connection), stream);
setTimeout(() => process.exit(4), 10_000);
`

const permissionRuntime = (script: string) =>
  local.jsonl({
    argv: [process.execPath, "--input-type=module", "-e", script],
    agent: "tiny-permission-acp",
    agentProtocol: "acp",
    cwd: globalThis.process.cwd(),
  })

const controlPlaneLayer = (
  input: {
    readonly baseUrl: string
    readonly namespace: string
  },
) =>
  FiregridRuntimeTables.ControlPlane.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl(input),
      contentType: "application/json",
    },
    txTimeoutMs: 2_000,
  })

const firstWithinOrFail = <A, E>(
  stream: Stream.Stream<A, E>,
  label: string,
  timeoutMs: number,
): Effect.Effect<A, E | Error> =>
  Effect.raceFirst(
    Stream.runHead(stream).pipe(
      Effect.flatMap(row =>
        Option.match(row, {
          onNone: () => Effect.fail(new Error(`${label} stream ended before matching`)),
          onSome: Effect.succeed,
        })),
    ),
    Clock.sleep(`${timeoutMs} millis`).pipe(
      Effect.flatMap(() => Effect.fail(new Error(`timed out waiting for ${label}`))),
    ),
  )

const waitForMaterializedContext = (
  control: ControlPlaneService,
  session: FiregridSessionHandle,
) =>
  firstWithinOrFail(
    control.contexts.rows().pipe(
      Stream.filter(row => row.contextId === session.contextId),
    ),
    `context ${session.contextId}`,
    10_000,
  )

const waitForIntent = (
  control: ControlPlaneService,
  session: FiregridSessionHandle,
  intentId: string,
) =>
  firstWithinOrFail(
    control.inputIntents.rows().pipe(
      Stream.filter(row =>
        row.contextId === session.contextId &&
        row.intentId === intentId,
      ),
    ),
    `intent ${intentId}`,
    10_000,
  )

const waitForRunStatus = (
  control: ControlPlaneService,
  session: FiregridSessionHandle,
  status: "started" | "exited" | "failed",
  timeoutMs: number,
) =>
  firstWithinOrFail(
    control.runs.rows().pipe(
      Stream.filter(row =>
        row.contextId === session.contextId &&
        row.status === status,
      ),
    ),
    `${status} run for ${session.contextId}`,
    timeoutMs,
  )

const waitForAgentOutputMatching = (
  session: FiregridSessionHandle,
  predicate: (observation: AgentOutputObservation) => boolean,
  timeoutMs: number,
): Effect.Effect<AgentOutputObservation, Error> =>
  Effect.gen(function*() {
    const deadlineMs = (yield* Clock.currentTimeMillis) + timeoutMs
    let afterSequence: number | undefined

    while (true) {
      const nowMs = yield* Clock.currentTimeMillis
      if (nowMs >= deadlineMs) {
        return yield* Effect.fail(new Error(`timed out waiting for agent output from ${session.contextId}`))
      }
      const result = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: deadlineMs - nowMs,
      })
      if (!result.matched) {
        return yield* Effect.fail(new Error(`timed out waiting for agent output from ${session.contextId}`))
      }
      if (predicate(result.output)) return result.output
      afterSequence = result.output.sequence
    }
  })

const provideClient = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  input: {
    readonly baseUrl: string
    readonly namespace: string
  },
): Effect.Effect<A, E | DurableTableError | FiregridConfigError, Exclude<R, Firegrid>> =>
  self.pipe(
    Effect.provide(FiregridStandaloneLive),
    Effect.provide(Layer.succeed(FiregridConfig, {
      durableStreamsBaseUrl: input.baseUrl,
      namespace: input.namespace,
    })),
  )

const runWithPublicClient = <A, E>(
  scenario: (services: {
    readonly control: ControlPlaneService
    readonly firegrid: FiregridService
  }) => Effect.Effect<A, E, Scope.Scope>,
  input: {
    readonly baseUrl: string
    readonly namespace: string
  },
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      provideClient(
        Effect.gen(function*() {
          const control: ControlPlaneService = yield* FiregridRuntimeTables.ControlPlane
          const firegrid = yield* Firegrid
          return yield* scenario({ control, firegrid })
        }).pipe(Effect.provide(controlPlaneLayer(input))),
        input,
      ),
    ),
  )

const launchHost = (
  hostLayer: ReturnType<typeof tinyPermissionFlowPipeline>,
): Effect.Effect<void, DurableTableError, Scope.Scope> =>
  Layer.launch(hostLayer).pipe(
    Effect.forkScoped,
    Effect.asVoid,
  )

const textDeltaFromObservation = (
  observation: AgentOutputObservation,
): string | undefined => {
  if (observation.event._tag !== "TextChunk") return undefined
  return observation.event.part.delta
}

const outputTags = (
  snapshot: RuntimeContextSnapshot,
): ReadonlyArray<AgentOutputObservation["_tag"]> =>
  snapshot.agentOutputs.map(observation => observation._tag)

describe("tiny-firegrid permission-flow pipeline", () => {
  it(
    "firegrid-runtime-agent-event-pipeline.VALIDATION.3 firegrid-runtime-agent-event-pipeline.VALIDATION.3-1 firegrid-runtime-agent-event-pipeline.VALIDATION.3-2 resumes an ACP PermissionRequest through client-authored PermissionResponse intent",
    async () => {
      if (baseUrl === undefined) throw new Error("server not started")

      const durableStreamsBaseUrl = baseUrl
      const namespace = `tiny-permission-flow-${crypto.randomUUID()}`
      const externalKey = { source: "tiny-firegrid", id: "permission-flow" }
      const hostLayer = tinyPermissionFlowPipeline({
        baseUrl: durableStreamsBaseUrl,
        namespace,
      })

      const result = await runWithPublicClient(({ control, firegrid }) => Effect.gen(function*() {
        const session = yield* firegrid.sessions.createOrLoad({
          externalKey,
          runtime: permissionRuntime(permissionAgentScript),
          createdBy: "tiny-firegrid",
        })
        const started = yield* session.start()
        yield* launchHost(hostLayer)
        yield* waitForMaterializedContext(control, session)
        const promptIntent = yield* session.prompt({
          payload: "Request permission before editing config.json, then report the decision.",
          idempotencyKey: "permission-flow-turn-1",
        })
        const observedPromptIntent = yield* waitForIntent(control, session, promptIntent.intentId)
        const runStarted = yield* waitForRunStatus(control, session, "started", 30_000)
        const permission = yield* session.wait.forPermissionRequest({
          timeoutMs: 30_000,
        })
        if (!permission.matched) {
          return yield* Effect.fail(new Error("permission request timed out"))
        }
        const response = yield* session.permissions.respond({
          permissionRequestId: permission.request.permissionRequestId,
          decision: { _tag: "Allow", optionId: "allow" },
        })
        const observedResponseIntent = yield* waitForIntent(control, session, response.inputId)
        const finalText = yield* waitForAgentOutputMatching(
          session,
          observation =>
            textDeltaFromObservation(observation)?.includes(
              "FIREGRID_PERMISSION_RESULT selected:allow",
            ) === true,
          30_000,
        )
        const runExited = yield* waitForRunStatus(control, session, "exited", 30_000)
        const snapshot = yield* session.snapshot()
        return {
          finalText,
          observedPromptIntent,
          observedResponseIntent,
          permission: permission.request,
          promptIntent,
          response,
          runExited,
          runStarted,
          session,
          snapshot,
          started,
        }
      }), { baseUrl: durableStreamsBaseUrl, namespace })

      expect(result.started).toMatchObject({
        contextId: result.session.contextId,
        inserted: true,
      })
      expect(result.observedPromptIntent).toMatchObject({
        intentId: result.promptIntent.intentId,
        contextId: result.session.contextId,
        kind: "message",
      })
      expect(result.runStarted).toMatchObject({
        contextId: result.session.contextId,
        status: "started",
      })
      expect(result.permission).toMatchObject({
        contextId: result.session.contextId,
        _tag: "PermissionRequest",
        toolUseId: "tool-permission",
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow once" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ],
      })
      expect(result.response).toMatchObject({
        responded: true,
        contextId: result.session.contextId,
        permissionRequestId: result.permission.permissionRequestId,
      })
      expect(result.observedResponseIntent).toMatchObject({
        intentId: result.response.inputId,
        contextId: result.session.contextId,
        kind: "required_action_result",
        authoredBy: "client",
        payload: {
          _tag: "PermissionResponse",
          permissionRequestId: result.permission.permissionRequestId,
          decision: { _tag: "Allow", optionId: "allow" },
        },
      })
      expect(result.finalText).toMatchObject({
        contextId: result.session.contextId,
        _tag: "TextChunk",
      })
      expect(textDeltaFromObservation(result.finalText)).toContain(
        "FIREGRID_PERMISSION_RESULT selected:allow",
      )
      expect(result.runExited).toMatchObject({
        contextId: result.session.contextId,
        status: "exited",
        exitCode: 0,
      })
      expect(result.snapshot.context).toMatchObject({
        contextId: result.session.contextId,
      })
      expect(outputTags(result.snapshot)).toEqual([
        "Ready",
        "ToolUse",
        "PermissionRequest",
        "TextChunk",
        "TurnComplete",
        "Terminated",
      ])
    },
    60_000,
  )
})
