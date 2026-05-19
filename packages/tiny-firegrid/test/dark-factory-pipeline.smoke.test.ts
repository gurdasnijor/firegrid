// tf-se0 happy-path smoke: env-gated and excluded from CI by filename.
// The planner is a real tool-use ACP agent. The test only supplies the
// external human-approval signal when the agent has entered the supported
// `wait_for` step, plus one explicitly marked PR-open placeholder for the
// known live-host `execute` gap tracked by tf-mn2.

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Firegrid,
  FiregridConfig,
  FiregridStandaloneLive,
  local,
  type FiregridConfigError,
  type FiregridSessionHandle,
  type RuntimeContextSnapshot,
} from "@firegrid/client-sdk/firegrid"
import {
  localProcessSpawnEnvFromHostEnv,
} from "@firegrid/host-sdk"
import {
  Clock,
  Context,
  Effect,
  Fiber,
  Layer,
  Schedule,
} from "effect"
import type { DurableTableError } from "effect-durable-operators"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  darkFactoryChoreographyHappyPathPrompt,
  darkFactoryRealAgentEnvPolicy,
  DarkFactoryEvidenceTable,
  makeDarkFactoryPermissionResolvedFact,
  makeDarkFactoryPullRequestOpenedFact,
  makeDarkFactoryTerminalFact,
  makeDarkFactoryTriggerAcceptedFact,
  tinyDarkFactoryPipeline,
} from "../src/configurations/dark-factory-pipeline.ts"

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

interface RealToolUseAgent {
  readonly agent: string
  readonly argv: ReadonlyArray<string>
  readonly envBindingName: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY"
}

const selectRealToolUseAgent = (): RealToolUseAgent | undefined => {
  if (
    typeof globalThis.process.env.ANTHROPIC_API_KEY === "string" &&
    globalThis.process.env.ANTHROPIC_API_KEY.length > 0
  ) {
    return {
      agent: "claude-code-acp",
      argv: ["npx", "-y", "@zed-industries/claude-code-acp"],
      envBindingName: "ANTHROPIC_API_KEY",
    }
  }
  if (
    typeof globalThis.process.env.OPENAI_API_KEY === "string" &&
    globalThis.process.env.OPENAI_API_KEY.length > 0
  ) {
    return {
      agent: "codex-acp",
      argv: ["npx", "-y", "@zed-industries/codex-acp@0.14.0"],
      envBindingName: "OPENAI_API_KEY",
    }
  }
  return undefined
}

const realAgent = selectRealToolUseAgent()

if (realAgent === undefined) {
  console.warn(
    "Skipping dark-factory happy-path smoke: OPENAI_API_KEY or ANTHROPIC_API_KEY is not set.",
  )
}

const localProcessEnv = () => {
  const base = localProcessSpawnEnvFromHostEnv(globalThis.process.env)
  const baselineEnvVars = { ...(base.baselineEnvVars ?? {}) }
  for (const key of [
    "HOME",
    "TMPDIR",
    "TEMP",
    "USER",
    "LOGNAME",
    "NPM_CONFIG_CACHE",
    "npm_config_cache",
  ]) {
    const value = globalThis.process.env[key]
    if (value !== undefined && value.length > 0) baselineEnvVars[key] = value
  }
  return {
    ...base,
    baselineEnvVars,
  }
}

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

const waitNextAgentOutput = (
  session: FiregridSessionHandle,
  input: {
    readonly afterSequence?: number
    readonly timeoutMs: number
  },
) =>
  session.wait.forAgentOutput({
    ...(input.afterSequence === undefined ? {} : {
      afterSequence: input.afterSequence,
    }),
    timeoutMs: input.timeoutMs,
  }).pipe(
    Effect.retry(
      Schedule.intersect(
        Schedule.spaced("1000 millis"),
        Schedule.recurs(5),
      ),
    ),
  )

const approvalSignalScript = `
let buffer = "";
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
const handleLine = line => {
  if (line.trim().length === 0) return;
  const event = JSON.parse(line);
  if (event.type !== "prompt") return;
  const text = typeof event.prompt === "object"
    ? JSON.stringify(event.prompt)
    : String(event.prompt);
  emit({ type: "text", messageId: "approval-resolution", text });
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
setTimeout(() => process.exit(2), 120_000);
`

const approvalSignalRuntime = () =>
  local.jsonl({
    argv: [process.execPath, "-e", approvalSignalScript],
    agent: "dark-factory-approval-signal",
    agentProtocol: "stdio-jsonl",
    cwd: globalThis.process.cwd(),
  })

const observePlannerHappyPath = (
  input: {
    readonly planner: FiregridSessionHandle
    readonly approvalSignal: FiregridSessionHandle
    readonly factoryRunKey: string
    readonly timeoutMs: number
  },
) =>
  Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + input.timeoutMs
    let afterSequence: number | undefined
    let text = ""
    let sawReady = false
    let approvalPrompted = false
    const toolUses: Array<{ readonly name: string; readonly params: unknown }> = []

    while ((yield* Clock.currentTimeMillis) < deadline) {
      const remaining = Math.max(1, deadline - (yield* Clock.currentTimeMillis))
      const next = yield* waitNextAgentOutput(input.planner, {
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: Math.min(remaining, 15_000),
      })
      if (!next.matched) continue

      const observation: AgentOutputObservation = next.output
      afterSequence = observation.sequence
      const event = observation.event

      if (event._tag === "Ready") sawReady = true
      if (event._tag === "ToolUse") {
        toolUses.push({ name: event.part.name, params: event.part.params })
        if (event.part.name === "wait_for" && !approvalPrompted) {
          approvalPrompted = true
          yield* input.approvalSignal.prompt({
            payload: `factory.permission.resolved approved ${input.factoryRunKey}`,
            idempotencyKey: `approval-resolution:${input.factoryRunKey}`,
          })
        }
      }
      if (event._tag === "TextChunk") {
        text += event.part.delta
        if (text.includes("DARK_FACTORY_TERMINAL")) break
      }
    }

    return {
      sawReady,
      approvalPrompted,
      toolUses,
      text,
      toolNames: toolUses.map(tool => tool.name),
    }
  })

describe("tiny-firegrid dark-factory happy-path smoke", () => {
  const maybeIt = realAgent === undefined ? it.skip : it

  maybeIt(
    "lets a real tool-use ACP planner choreograph trigger -> approval -> implementer -> PR placeholder -> terminal through supported public surfaces",
    async () => {
      if (baseUrl === undefined) throw new Error("server not started")
      if (realAgent === undefined) throw new Error("real agent env not selected")

      const durableStreamsBaseUrl = baseUrl
      const namespace = `tiny-dark-factory-${crypto.randomUUID()}`
      const factoryRunKey = `factory-run-${crypto.randomUUID()}`
      const triggerFact = makeDarkFactoryTriggerAcceptedFact({
        factoryRunKey,
        externalEventKey: "mock-trigger-1",
        externalEntityKey: "ticket-DF-1",
        createdAt: new Date().toISOString(),
        payload: {
          title: "Open a PR after approval",
          repository: "gurdasnijor/firegrid",
        },
      })

      const result = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const hostContext = yield* Layer.build(
            tinyDarkFactoryPipeline({
              baseUrl: durableStreamsBaseUrl,
              namespace,
              localProcessEnv: localProcessEnv(),
              envPolicy: darkFactoryRealAgentEnvPolicy(globalThis.process.env),
            }),
          )
          const table = Context.get(hostContext, DarkFactoryEvidenceTable)
          yield* table.facts.insertOrGet(triggerFact)

          return yield* provideClient(
            Effect.gen(function*() {
              const firegrid = yield* Firegrid
              const approvalSignal = yield* firegrid.sessions.createOrLoad({
                externalKey: {
                  source: "tiny-firegrid",
                  id: `approval-signal-${factoryRunKey}`,
                },
                runtime: approvalSignalRuntime(),
                createdBy: "tiny-firegrid",
              })
              yield* approvalSignal.start()

              const planner = yield* firegrid.sessions.createOrLoad({
                externalKey: {
                  source: "tiny-firegrid",
                  id: `dark-factory-${factoryRunKey}`,
                },
                runtime: local.jsonl({
                  argv: [...realAgent.argv],
                  agent: realAgent.agent,
                  agentProtocol: "acp",
                  cwd: globalThis.process.cwd(),
                  envBindings: [
                    {
                      name: realAgent.envBindingName,
                      ref: `env:${realAgent.envBindingName}`,
                    },
                  ],
                  runtimeContextMcp: { enabled: true },
                }),
                createdBy: "tiny-firegrid",
              })

              const permissionFiber = yield* Effect.gen(function*() {
                const permission = yield* planner.wait.forPermissionRequest({
                  timeoutMs: 45_000,
                })
                if (!permission.matched) {
                  return { _tag: "NoPermissionRequest" as const }
                }
                const response = yield* planner.permissions.respond({
                        permissionRequestId: permission.request.permissionRequestId,
                        decision: { _tag: "Allow", optionId: "allow" },
                })
                return {
                  _tag: "PermissionResponded" as const,
                  request: permission.request,
                  response,
                }
              }).pipe(
                Effect.either,
                Effect.fork,
              )

              yield* planner.prompt({
                payload: darkFactoryChoreographyHappyPathPrompt({
                  factoryRunKey,
                  triggerFact,
                  approvalSignalContextId: approvalSignal.contextId,
                  // tf-mn2: session_new currently accepts an agentKind
                  // command, not a full public runtime config. `/bin/cat`
                  // is the smallest non-durable implementer stand-in that
                  // lets the real planner exercise session_new/session_prompt.
                  implementerAgentKind: "/bin/cat",
                }),
                idempotencyKey: `dark-factory-happy-path:${factoryRunKey}:prompt`,
              }).pipe(
                Effect.retry(
                  Schedule.intersect(
                    Schedule.spaced("1000 millis"),
                    Schedule.recurs(60),
                  ),
                ),
              )
              yield* planner.start()

              const observed = yield* observePlannerHappyPath({
                planner,
                approvalSignal,
                factoryRunKey,
                timeoutMs: 240_000,
              })
              const permission = yield* Fiber.join(permissionFiber)

              const permissionResolved = makeDarkFactoryPermissionResolvedFact({
                factoryRunKey,
                decision: "approved",
                createdAt: new Date().toISOString(),
              })
              yield* table.facts.insertOrGet(permissionResolved)

              // tf-mn2 sub-gap 3: live host `execute` is not wired for a
              // provider PR-open side effect. This row is a deliberately
              // non-durable happy-path placeholder at that one unsupported
              // edge; the planner still choreographs the supported steps.
              const pullRequestOpened = makeDarkFactoryPullRequestOpenedFact({
                factoryRunKey,
                url: `https://example.invalid/firegrid/pull/${factoryRunKey}`,
                createdAt: new Date().toISOString(),
                placeholder: true,
              })
              yield* table.facts.insertOrGet(pullRequestOpened)

              const terminal = makeDarkFactoryTerminalFact({
                factoryRunKey,
                createdAt: new Date().toISOString(),
                payload: {
                  observed,
                  permission,
                  pullRequestOpened,
                },
              })
              yield* table.facts.insertOrGet(terminal)

              return {
                approvalSignalContextId: approvalSignal.contextId,
                factoryRunKey,
                plannerContextId: planner.contextId,
                observed,
                permission,
                pullRequestOpened,
                terminal,
              }
            }),
            { baseUrl: durableStreamsBaseUrl, namespace },
          )
        })),
      )

      console.error("[dark-factory-happy-path]", JSON.stringify(result, null, 2))

      expect(result.observed.sawReady).toBe(true)
      expect(result.observed.approvalPrompted).toBe(true)
      expect(result.observed.toolNames).toContain("wait_for")
      expect(result.observed.toolNames).toContain("session_new")
      expect(result.observed.toolNames).toContain("session_prompt")
      expect(result.observed.text).toContain("DARK_FACTORY_TERMINAL")
      expect(result.pullRequestOpened.eventType).toBe("factory.pull_request.opened")
      expect(result.pullRequestOpened.payload).toMatchObject({
        placeholder: true,
      })
      expect(result.terminal.eventType).toBe("factory.terminal")
    },
    300_000,
  )
})
