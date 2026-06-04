import { WorkflowEngine } from "@effect/workflow"
import {
  HostSessionsCreateOrLoadChannel,
  SessionAgentOutputChannel,
  SessionPromptChannel,
} from "@firegrid/protocol/channels"
import { respondPermissionDecision } from "../unified/channel-bindings.ts"
import { Effect, Stream } from "effect"
import { pathToFileURL } from "node:url"
import { firegridNodeHost } from "../node.ts"
import { resolveNodeHostOptions } from "./_resolve.ts"
import {
  compositionOptionsFromAgentOptions,
  decodeAgentSecretEnv,
  localJsonlRuntimeFromAgentOptions,
  parseAgentProcessCliArgs,
  type AgentProcessCliOptions,
} from "./_agent-cli.ts"
import { runFiregridBinMain } from "./_main.ts"
import type { RuntimeAgentOutputObservation } from "@firegrid/protocol/session-facade"
import type { FiregridCliUsageError } from "./_resolve.ts"

export interface RunCliOptions extends AgentProcessCliOptions {
  readonly prompt?: string
}

const usage = [
  "Usage: firegrid run [--agent NAME] [--agent-protocol raw|stdio-jsonl|acp] [--secret-env NAME[=HOST_NAME]] [--prompt TEXT] [--cwd PATH] [--otel-file PATH] -- <agent-argv>",
].join("\n")

const parseArgs = (
  argv: ReadonlyArray<string>,
): Effect.Effect<RunCliOptions, FiregridCliUsageError> =>
  parseAgentProcessCliArgs<{ prompt?: string }>({
    argv,
    usage,
    commandName: "run",
    defaultAgentProtocol: "acp",
    allowedAgentProtocols: ["raw", "stdio-jsonl", "acp"],
    extra: {},
    parseExtra: (arg, next, extra) =>
      Effect.gen(function*() {
        switch (arg) {
          case "--prompt":
            extra.prompt = yield* next()
            return 2
          default:
            return 0
        }
      }),
  })

const writeStdout = (text: string): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(text)
  })

const writeStderr = (text: string): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stderr.write(text)
  })

const renderObservation = (
  output: RuntimeAgentOutputObservation,
): Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    switch (output._tag) {
      case "TextChunk":
        yield* writeStdout(output.event.part.delta)
        return
      case "ToolUse":
        yield* writeStderr(`firegrid run: tool ${output.event.part.name}\n`)
        return
      case "PermissionRequest": {
        const engine = yield* WorkflowEngine.WorkflowEngine
        yield* writeStderr(`firegrid run: allowing permission ${output.permissionRequestId}\n`)
        yield* respondPermissionDecision({
          engine,
          request: {
            contextId: output.contextId,
            permissionRequestId: output.event.permissionRequestId,
            decision: { _tag: "Allow" },
          },
        })
        return
      }
      case "TurnComplete":
        yield* writeStdout("\n")
        return
      case "Error":
        yield* writeStderr(`firegrid run: agent error ${String(output.event.cause)}\n`)
        return
      case "Terminated":
        return
      case "Ready":
      case "Status":
        return
    }
  })

export const runProgramFromOptions = (
  options: RunCliOptions,
  exitOnComplete = false,
): Effect.Effect<void, unknown, never> =>
  Effect.gen(function*() {
    const bindings = yield* decodeAgentSecretEnv(options.secretEnv)
    yield* Effect.gen(function*() {
      const createOrLoad = yield* HostSessionsCreateOrLoadChannel
      const prompt = yield* SessionPromptChannel
      const output = yield* SessionAgentOutputChannel
      const runtime = localJsonlRuntimeFromAgentOptions(options, bindings)
      const session = yield* createOrLoad.binding.call({
        externalKey: {
          source: "firegrid.cli.run",
          id: crypto.randomUUID(),
        },
        runtime,
        createdBy: "firegrid.cli.run",
      })
      // tf-vqv5: the session.start ack was vestigial — the real spawn happens
      // when the prompt drives the RuntimeContext workflow body's startOrAttach.
      if (options.prompt !== undefined) {
        const inputId = `input_${crypto.randomUUID()}`
        yield* prompt.forSession(session.sessionId).binding.append({
          payload: { text: options.prompt },
          inputId,
          idempotencyKey: inputId,
        })
      }
      yield* output.forContext(session.contextId).binding.stream.pipe(
        Stream.filter(
          observation => observation._tag !== "Ready" && observation._tag !== "Status",
        ),
        Stream.tap(renderObservation),
        Stream.takeUntil(
          observation =>
            observation._tag === "TurnComplete" ||
            observation._tag === "Terminated" ||
            observation._tag === "Error",
        ),
        Stream.runDrain,
        Effect.timeoutOption("12 seconds"),
      )
      if (exitOnComplete) {
        yield* Effect.sync(() => {
          process.exitCode = 0
          queueMicrotask(() => {
            process.exit(0)
          })
        })
      }
    }).pipe(
      Effect.provide(
        firegridNodeHost(resolveNodeHostOptions(compositionOptionsFromAgentOptions(options, bindings))),
      ),
      Effect.scoped,
    )
  })

export const runProgram = (
  argv: ReadonlyArray<string>,
): Effect.Effect<void, unknown, never> =>
  Effect.gen(function*() {
    const options = yield* parseArgs(argv)
    yield* runProgramFromOptions(options, true)
  })

export const runFiregridRunMain = (
  argv: ReadonlyArray<string> = process.argv.slice(2),
): void => {
  runFiregridBinMain(runProgram(argv))
}

const isDirectRun = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  runFiregridRunMain()
}
