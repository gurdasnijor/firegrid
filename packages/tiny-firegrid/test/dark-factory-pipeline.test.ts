import { DurableStreamTestServer } from "@durable-streams/server"
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
  local,
  type FiregridConfigError,
  type FiregridService,
} from "@firegrid/client-sdk/firegrid"
import { Clock, Effect, Fiber, Layer, Option, Stream, type Scope } from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DarkFactoryPipelineTable,
  darkFactoryPipelineTableLayer,
  darkFactoryRunKeyForTrigger,
  resolveDarkFactoryPermission,
  resumeDarkFactoryAfterPermission,
  runDarkFactoryPipelineLoop,
  tinyDarkFactoryPipeline,
  type DarkFactoryRunProjection,
  type DarkFactoryTrigger,
} from "../src/configurations/dark-factory-pipeline.ts"

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

const plannerAgentScript = `
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

class PlannerAgent {
  constructor(connection) {
    this.connection = connection;
    this.mcpServers = [];
  }

  async initialize() {
    return {
      protocolVersion: ${JSON.stringify(PROTOCOL_VERSION)},
      agentCapabilities: { loadSession: false }
    };
  }

  async newSession(params) {
    this.mcpServers = params.mcpServers || [];
    return { sessionId: "tiny-dark-factory-planner" };
  }

  async authenticate() {
    return {};
  }

  async prompt(params) {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "planner-mcp",
        content: {
          type: "text",
          text: "DARK_FACTORY_MCP_SERVERS " + this.mcpServers.length
        }
      }
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-plan-approval",
        title: "approve plan",
        kind: "edit",
        status: "pending",
        rawInput: { factoryRunKey: "from-prompt" }
      }
    });
    const permission = await this.connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "tool-plan-approval",
        title: "approve plan",
        kind: "edit",
        status: "pending"
      },
      options: [
        { optionId: "allow", kind: "allow_once", name: "Approve plan" },
        { optionId: "deny", kind: "reject_once", name: "Reject plan" }
      ]
    });
    const selected = permission.outcome.outcome === "selected"
      ? permission.outcome.optionId
      : permission.outcome.outcome;
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "planner-approved",
        content: {
          type: "text",
          text: "DARK_FACTORY_PLAN_APPROVED " + permission.outcome.outcome + ":" + selected + " mcp=" + this.mcpServers.length
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
new acp.AgentSideConnection(connection => new PlannerAgent(connection), stream);
setTimeout(() => process.exit(4), 10_000);
`

const implementerAgentScript = `
let buffer = "";
let completed = false;

const emit = (event) => {
  process.stdout.write(JSON.stringify(event) + "\\n");
};

const handleLine = (line) => {
  if (line.trim().length === 0) return;
  const event = JSON.parse(line);
  if (event.type !== "prompt" || completed) return;
  completed = true;
  emit({
    type: "text",
    text: "DARK_FACTORY_PR_OPENED https://github.com/example/dark-factory/pull/42"
  });
  emit({ type: "turn_complete", finishReason: "stop" });
  setTimeout(() => process.exit(0), 10);
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
  }
});

setTimeout(() => {
  if (!completed) process.exit(2);
}, 5_000);
`

const plannerRuntime = () =>
  local.jsonl({
    argv: [process.execPath, "--input-type=module", "-e", plannerAgentScript],
    agent: "tiny-dark-factory-planner",
    agentProtocol: "acp",
    cwd: globalThis.process.cwd(),
    runtimeContextMcp: { enabled: true },
  })

const implementerRuntime = () =>
  local.jsonl({
    argv: [process.execPath, "-e", implementerAgentScript],
    agent: "tiny-dark-factory-implementer",
    agentProtocol: "stdio-jsonl",
    cwd: globalThis.process.cwd(),
  })

const trigger = (id: string): DarkFactoryTrigger => ({
  provider: "mock",
  externalEntityId: id,
  externalEventKey: `mock-event-${id}`,
  title: "Dark factory fixture ticket",
  body: "Produce a deterministic PR-shaped output through Firegrid.",
})

const provideClientAndFactoryTable = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  input: {
    readonly baseUrl: string
    readonly namespace: string
  },
): Effect.Effect<
  A,
  E | DurableTableError | FiregridConfigError,
  Exclude<Exclude<Exclude<R, DarkFactoryPipelineTable>, Firegrid>, FiregridConfig>
> =>
  self.pipe(
    Effect.provide(darkFactoryPipelineTableLayer(input)),
    Effect.provide(FiregridStandaloneLive),
    Effect.provide(Layer.succeed(FiregridConfig, {
      durableStreamsBaseUrl: input.baseUrl,
      namespace: input.namespace,
    })),
  )

const runWithPublicClient = <A, E>(
  scenario: (services: {
    readonly firegrid: FiregridService
  }) => Effect.Effect<A, E, Scope.Scope | DarkFactoryPipelineTable>,
  input: {
    readonly baseUrl: string
    readonly namespace: string
  },
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      provideClientAndFactoryTable(
        Effect.gen(function*() {
          const firegrid = yield* Firegrid
          return yield* scenario({ firegrid })
        }),
        input,
      ),
    ),
  )

const launchHost = (
  hostLayer: ReturnType<typeof tinyDarkFactoryPipeline>,
): Effect.Effect<void, DurableTableError, Scope.Scope> =>
  Layer.launch(hostLayer).pipe(
    Effect.forkScoped,
    Effect.asVoid,
  )

const waitForProjectionStatus = (
  factoryRunKey: string,
  status: DarkFactoryRunProjection["status"],
): Effect.Effect<DarkFactoryRunProjection, DurableTableError | Error, DarkFactoryPipelineTable> =>
  // TFIND-005: generated DurableTable service inference leaks `any` here.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  Effect.gen(function*() {
    const table = yield* DarkFactoryPipelineTable
    const found = yield* Effect.raceFirst(
      table.runs.rows().pipe(
        Stream.filter(row =>
          row.factoryRunKey === factoryRunKey &&
          row.status === status),
        Stream.runHead,
      ),
      Clock.sleep("30000 millis").pipe(
        Effect.flatMap(() =>
          Effect.fail(new Error(`timed out waiting for projection ${status}`))),
      ),
    )
    return yield* Option.match(found, {
      onNone: () => Effect.fail(new Error(`projection ${status} not observed`)),
      onSome: Effect.succeed,
    })
  })

const waitForProjectionStatusOrLoopExit = (
  factoryRunKey: string,
  status: DarkFactoryRunProjection["status"],
  loop: Fiber.RuntimeFiber<unknown, DurableTableError | Error>,
): Effect.Effect<DarkFactoryRunProjection, DurableTableError | Error, DarkFactoryPipelineTable> =>
  Effect.raceFirst(
    waitForProjectionStatus(factoryRunKey, status),
    Fiber.join(loop).pipe(
      Effect.flatMap(() =>
        Effect.fail(new Error(`loop completed before projection ${status}`))),
    ),
  )

const factKinds = (
  facts: ReadonlyArray<{ readonly eventKind: string }>,
): ReadonlyArray<string> =>
  facts.map(fact => fact.eventKind)

describe("tiny-firegrid dark-factory pipeline", () => {
  it(
    "firegrid-factory-run-process.TINY_DARK_FACTORY_PIPELINE.1 firegrid-factory-run-process.TINY_DARK_FACTORY_PIPELINE.2 firegrid-factory-run-process.TINY_DARK_FACTORY_PIPELINE.3 firegrid-factory-run-process.TINY_DARK_FACTORY_PIPELINE.5 runs trigger to PR-opened through public sessions, MCP-enabled planner, and DurableTable rows",
    async () => {
      if (baseUrl === undefined) throw new Error("server not started")

      const durableStreamsBaseUrl = baseUrl
      const namespace = `tiny-dark-factory-${crypto.randomUUID()}`
      const mockTrigger = trigger("DF-100")
      const factoryRunKey = darkFactoryRunKeyForTrigger(mockTrigger)
      const hostLayer = tinyDarkFactoryPipeline({
        baseUrl: durableStreamsBaseUrl,
        namespace,
      })

      const result = await runWithPublicClient(({ firegrid }) =>
        Effect.gen(function*() {
          yield* launchHost(hostLayer)
          const loop = yield* runDarkFactoryPipelineLoop({
            firegrid,
            trigger: mockTrigger,
            plannerRuntime: plannerRuntime(),
            implementerRuntime: implementerRuntime(),
            waitTimeoutMs: 30_000,
          }).pipe(Effect.fork)
          const awaiting = yield* waitForProjectionStatusOrLoopExit(
            factoryRunKey,
            "awaiting_permission",
            loop,
          )
          const resolved = yield* resolveDarkFactoryPermission({
            firegrid,
            factoryRunKey,
          })
          const terminal = yield* Fiber.join(loop)
          return { awaiting, resolved, terminal }
        }), { baseUrl: durableStreamsBaseUrl, namespace })

      expect(result.awaiting).toMatchObject({
        factoryRunKey,
        status: "awaiting_permission",
      })
      expect(result.resolved).toMatchObject({
        factoryRunKey,
        status: "permission_resolved",
      })
      expect(result.terminal.projection).toMatchObject({
        factoryRunKey,
        status: "terminal",
        prUrl: "https://github.com/example/dark-factory/pull/42",
        terminalResult: "pull_request_opened",
      })
      expect(factKinds(result.terminal.facts)).toEqual(
        expect.arrayContaining([
          "factory.trigger.accepted",
          "factory.run.created",
          "factory.session.requested",
          "factory.prompt",
          "factory.permission.requested",
          "factory.permission.resolved",
          "factory.output",
          "factory.session.dispatched",
          "factory.pull_request.opened",
          "factory.run.terminal",
        ]),
      )
      const plannerOutput = result.terminal.facts.find(fact =>
        fact.eventKind === "factory.output" &&
        fact.phase === "planner")
      const plannerPayload = plannerOutput?.payload
      const plannerText = typeof plannerPayload === "object" && plannerPayload !== null
        ? (plannerPayload as { readonly text?: unknown }).text
        : undefined
      expect(plannerText).toContain("DARK_FACTORY_PLAN_APPROVED selected:allow mcp=1")
    },
    60_000,
  )

  it(
    "firegrid-factory-run-process.TINY_DARK_FACTORY_PIPELINE.4 resumes from durable rows after the app-led run process is interrupted while waiting for approval",
    async () => {
      if (baseUrl === undefined) throw new Error("server not started")

      const durableStreamsBaseUrl = baseUrl
      const namespace = `tiny-dark-factory-resume-${crypto.randomUUID()}`
      const mockTrigger = trigger("DF-101")
      const factoryRunKey = darkFactoryRunKeyForTrigger(mockTrigger)
      const hostLayer = tinyDarkFactoryPipeline({
        baseUrl: durableStreamsBaseUrl,
        namespace,
      })

      const result = await runWithPublicClient(({ firegrid }) =>
        Effect.gen(function*() {
          yield* launchHost(hostLayer)
          const loop = yield* runDarkFactoryPipelineLoop({
            firegrid,
            trigger: mockTrigger,
            plannerRuntime: plannerRuntime(),
            implementerRuntime: implementerRuntime(),
            waitTimeoutMs: 30_000,
          }).pipe(Effect.fork)
          const awaiting = yield* waitForProjectionStatusOrLoopExit(
            factoryRunKey,
            "awaiting_permission",
            loop,
          )
          yield* Fiber.interrupt(loop)
          const resolved = yield* resolveDarkFactoryPermission({
            firegrid,
            factoryRunKey,
          })
          const terminal = yield* resumeDarkFactoryAfterPermission({
            firegrid,
            factoryRunKey,
            implementerRuntime: implementerRuntime(),
            waitTimeoutMs: 30_000,
          })
          return { awaiting, resolved, terminal }
        }), { baseUrl: durableStreamsBaseUrl, namespace })

      expect(result.awaiting).toMatchObject({
        factoryRunKey,
        status: "awaiting_permission",
      })
      expect(result.resolved).toMatchObject({
        factoryRunKey,
        status: "permission_resolved",
      })
      expect(result.terminal.projection).toMatchObject({
        factoryRunKey,
        status: "terminal",
        prUrl: "https://github.com/example/dark-factory/pull/42",
      })
      expect(factKinds(result.terminal.facts)).toEqual(
        expect.arrayContaining([
          "factory.trigger.accepted",
          "factory.permission.requested",
          "factory.permission.resolved",
          "factory.pull_request.opened",
          "factory.run.terminal",
        ]),
      )
    },
    60_000,
  )
})
