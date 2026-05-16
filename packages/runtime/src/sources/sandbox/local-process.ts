import { Command } from "@effect/platform"
import {
  CommandExecutor as CommandExecutorTag,
  type CommandExecutor,
  type Process,
} from "@effect/platform/CommandExecutor"
import { Effect, Layer, Queue, Runtime, type Scope, Stream } from "effect"
import type { AgentByteStream } from "../../events/index.ts"
import {
  type ExecutionResult,
  type ProcessOutputChunk,
  type Sandbox,
  type SandboxCommand,
  type SandboxConfig,
  SandboxProvider,
  type SandboxProviderError,
  type SandboxProviderService,
} from "./SandboxProvider.ts"
import {
  makeInMemorySandboxStore,
  makeSandboxProviderService,
  sandboxProviderError,
  withExecutionDuration,
} from "./internal-provider.ts"

const providerName = "local-process"

interface LocalProcessSandboxConfig {
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly labels?: Record<string, string>
  readonly providerConfig?: Record<string, unknown>
}

interface LocalProcessSandboxProviderHelper {
  readonly provider: typeof providerName
  readonly config: LocalProcessSandboxConfig
}

export interface LocalProcessSandboxProviderOptions {
  readonly inheritedEnvKeys?: ReadonlyArray<string>
  readonly baselineEnvVars?: Record<string, string>
}

export const localProcess = (
  config: LocalProcessSandboxConfig = {},
): LocalProcessSandboxProviderHelper => ({
  provider: providerName,
  config,
})

const LOCAL_PROCESS_BASELINE_ENV_NAMES = [
  "PATH",
  "Path",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
] as const

export const localProcessSpawnEnvFromHostEnv = (
  env: Record<string, string | undefined>,
): LocalProcessSandboxProviderOptions => {
  const baselineEnvVars: Record<string, string> = {}
  for (const name of LOCAL_PROCESS_BASELINE_ENV_NAMES) {
    const value = env[name]
    if (value !== undefined && value.length > 0) baselineEnvVars[name] = value
  }
  return {
    inheritedEnvKeys: Object.keys(env),
    baselineEnvVars,
  }
}

const commandError = (
  op: string,
  message: string,
  cause?: unknown,
): SandboxProviderError =>
  sandboxProviderError(providerName, op, message, cause)

const buildCommand = (
  options: LocalProcessSandboxProviderOptions,
  config: SandboxConfig,
  command: SandboxCommand,
): Effect.Effect<Command.Command, SandboxProviderError> =>
  Effect.gen(function* () {
    const [executable, ...args] = command.argv
    if (executable === undefined) {
      return yield* commandError("buildCommand", "command argv is empty")
    }
    const inheritedEnvUnset: Record<string, string | undefined> = Object.fromEntries(
      (options.inheritedEnvKeys ?? []).map(key => [key, undefined]),
    )
    let built = Command.make(executable, ...args).pipe(
      // firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5-1
      Command.env({
        ...inheritedEnvUnset,
        ...options.baselineEnvVars,
        ...config.envVars,
        ...command.envVars,
      }),
    )
    if (typeof command.stdin === "string") {
      built = built.pipe(Command.feed(command.stdin))
    }
    const cwd = command.cwd ?? config.workingDir
    if (cwd !== undefined) built = built.pipe(Command.workingDirectory(cwd))
    return built
  })

// firegrid agent-io: convert an @effect/platform Process's Effect-shaped
// stdio into the WHATWG web streams that codecs consume. stdout/stderr
// are Effect Streams; we run them through Stream.toReadableStream.
// stdin is an Effect Sink; we feed it from a Queue that backs a
// WritableStream the caller writes into.
const makeAgentByteStreamFromProcess = (
  process: Process,
): Effect.Effect<AgentByteStream, SandboxProviderError, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const runPromise = Runtime.runPromise(runtime)
    const stdinQueue = yield* Queue.unbounded<Uint8Array>()
    yield* Stream.fromQueue(stdinQueue, { shutdown: true }).pipe(
      Stream.run(process.stdin),
      Effect.ignore,
      Effect.forkScoped,
    )
    const stdin: WritableStream<Uint8Array> = new WritableStream<Uint8Array>({
      async write(chunk) {
        await runPromise(Queue.offer(stdinQueue, chunk))
      },
      async close() {
        await runPromise(Queue.shutdown(stdinQueue))
      },
      async abort() {
        await runPromise(Queue.shutdown(stdinQueue))
      },
    })
    const stdout: ReadableStream<Uint8Array> = Stream.toReadableStreamRuntime(runtime)(
      process.stdout,
    ) as ReadableStream<Uint8Array>
    const stderr: ReadableStream<Uint8Array> = Stream.toReadableStreamRuntime(runtime)(
      process.stderr,
    ) as ReadableStream<Uint8Array>
    const exit = process.exitCode.pipe(
      Effect.map(exitCode => ({ exitCode: Number(exitCode) })),
      Effect.mapError(cause =>
        commandError("openBytePipe.exit", "local process failed while waiting for exit", cause),
      ),
    )
    return { stdin, stdout, stderr, exit } satisfies AgentByteStream
  })

const makeLocalProcessSandboxProvider = (
  commandExecutor: CommandExecutor,
  options: LocalProcessSandboxProviderOptions = {},
): SandboxProviderService => {
  const store = makeInMemorySandboxStore(providerName)

  const stream = (
    sandbox: Sandbox,
    command: SandboxCommand,
  ): Stream.Stream<ProcessOutputChunk, SandboxProviderError> =>
    Stream.unwrapScoped(
      Effect.gen(function* () {
        const config = yield* store.configFor(sandbox, "stream")
        const built = yield* buildCommand(options, config, command)
        const process = yield* commandExecutor.start(built).pipe(
          Effect.mapError(cause =>
            commandError("stream", "local process command failed to start", cause),
          ),
        )
        const stdout = process.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.map(text => ({
            type: "output",
            channel: "stdout",
            text,
          }) satisfies ProcessOutputChunk),
        )
        const stderr = process.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.map(text => ({
            type: "output",
            channel: "stderr",
            text,
          }) satisfies ProcessOutputChunk),
        )
        const output = Stream.merge(stdout, stderr).pipe(
          Stream.mapError(cause =>
            commandError("stream", "failed while reading local process output", cause),
          ),
        )
        const stdin = command.stdin !== undefined && typeof command.stdin !== "string"
          ? Stream.fromEffect(
            command.stdin.pipe(
              Stream.interruptWhen(process.exitCode.pipe(Effect.ignore)),
              Stream.run(process.stdin),
              Effect.mapError(cause =>
                commandError("stream.stdin", "failed while writing local process stdin", cause),
              ),
            ),
          ).pipe(Stream.drain)
          : Stream.empty
        const exit = Stream.fromEffect(
          process.exitCode.pipe(
            Effect.map(exitCode => ({
              type: "exit",
              exitCode: Number(exitCode),
            }) satisfies ProcessOutputChunk),
            Effect.mapError(cause =>
              commandError("stream", "local process failed while waiting for exit", cause),
            ),
          ),
        )
        // firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.6
        return output.pipe(
          Stream.merge(stdin),
          Stream.concat(exit),
        )
      }),
    )

  // firegrid agent-io: byte-pipe variant.
  //
  // Launch the process and expose its stdio as web streams so codecs
  // (ACP, future protocol-aware agents) can do byte-level framing
  // without bypassing the SandboxProvider boundary. The line-split
  // `stream` API stays for jsonl agents; the two methods coexist.
  //
  // Scope semantics: the returned `AgentByteStream` is tied to the
  // caller's Scope through `Effect.acquireRelease`; closing the scope
  // kills the launched process.
  const openBytePipe = (
    sandbox: Sandbox,
    command: SandboxCommand,
  ) =>
    Effect.gen(function* () {
      const config = yield* store.configFor(sandbox, "openBytePipe")
      const built = yield* buildCommand(options, config, command)
      const process = yield* Effect.acquireRelease(
        commandExecutor.start(built).pipe(
          Effect.mapError(cause =>
            commandError(
              "openBytePipe",
              "local process command failed to start",
              cause,
            ),
          ),
        ),
        (p) => p.kill().pipe(Effect.ignore),
      )
      return yield* makeAgentByteStreamFromProcess(process)
    })

  const execute = (
    sandbox: Sandbox,
    command: SandboxCommand,
  ): Effect.Effect<ExecutionResult, SandboxProviderError> =>
    withExecutionDuration(Effect.gen(function* () {
      const stdout: Array<string> = []
      const stderr: Array<string> = []
      let exitCode = 1
      yield* stream(sandbox, command).pipe(
        Stream.runForEach(chunk =>
          Effect.sync(() => {
            if (chunk.type === "exit") {
              exitCode = chunk.exitCode
            } else if (chunk.channel === "stdout") {
              stdout.push(chunk.text)
            } else {
              stderr.push(chunk.text)
            }
          }),
        ),
      )
      return {
        exitCode,
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
      }
    }))

  return makeSandboxProviderService({
    name: providerName,
    capabilities: {
      streaming: true,
    },
    // firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.1
    // firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.4
    // firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.5
    store,
    execute,
    stream,
    openBytePipe,
  })
}

export const LocalProcessSandboxProvider = {
  layer: (
    options: LocalProcessSandboxProviderOptions = {},
  ): Layer.Layer<SandboxProvider, never, CommandExecutor> =>
    Layer.effect(
      SandboxProvider,
      Effect.map(CommandExecutorTag, commandExecutor =>
        makeLocalProcessSandboxProvider(commandExecutor, options),
      ),
    ),
}
