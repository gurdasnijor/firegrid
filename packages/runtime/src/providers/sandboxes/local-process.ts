import { Command } from "@effect/platform"
import {
  CommandExecutor as CommandExecutorTag,
  type CommandExecutor,
} from "@effect/platform/CommandExecutor"
import { Effect, Layer, Stream } from "effect"
import {
  defaultCapabilities,
  findRunningSandbox,
  type ExecutionResult,
  type ProcessOutputChunk,
  type Sandbox,
  type SandboxCommand,
  type SandboxConfig,
  SandboxProvider,
  SandboxProviderError,
  type SandboxProviderService,
} from "./SandboxProvider.ts"

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

export const localProcess = (
  config: LocalProcessSandboxConfig = {},
): LocalProcessSandboxProviderHelper => ({
  provider: providerName,
  config,
})

const commandError = (
  op: string,
  message: string,
  cause?: unknown,
): SandboxProviderError =>
  new SandboxProviderError({
    provider: providerName,
    op,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const buildCommand = (
  config: SandboxConfig,
  command: SandboxCommand,
): Effect.Effect<Command.Command, SandboxProviderError> =>
  Effect.gen(function* () {
    const [executable, ...args] = command.argv
    if (executable === undefined) {
      return yield* commandError("buildCommand", "command argv is empty")
    }
    let built = Command.make(executable, ...args).pipe(
      Command.env({
        ...config.envVars,
        ...command.envVars,
      }),
    )
    if (command.stdin !== undefined) built = built.pipe(Command.feed(command.stdin))
    const cwd = command.cwd ?? config.workingDir
    if (cwd !== undefined) built = built.pipe(Command.workingDirectory(cwd))
    return built
  })

const sandboxFromConfig = (
  id: string,
  config: SandboxConfig,
): Sandbox => ({
  id,
  provider: providerName,
  state: "running",
  labels: config.labels ?? {},
  createdAt: new Date().toISOString(),
  connectionInfo: {},
  metadata: {},
})

const unsupported = (
  op: string,
): Effect.Effect<void, SandboxProviderError> =>
  Effect.fail(commandError(op, `local process provider does not support ${op}`))

const makeLocalProcessSandboxProvider = (
  commandExecutor: CommandExecutor,
): SandboxProviderService => {
  const sandboxes = new Map<string, SandboxConfig>()

  const create = (config: SandboxConfig) =>
    Effect.sync(() => {
      const id = `local-process:${crypto.randomUUID()}`
      sandboxes.set(id, config)
      return sandboxFromConfig(id, config)
    })

  const find = (labels: Record<string, string>) =>
    Effect.sync(() =>
      findRunningSandbox(
        Array.from(sandboxes, ([id, config]) => sandboxFromConfig(id, config))
          .filter(sandbox =>
            Object.entries(labels).every(([key, value]) => sandbox.labels[key] === value),
          ),
      ),
    )

  const stream = (
    sandbox: Sandbox,
    command: SandboxCommand,
  ): Stream.Stream<ProcessOutputChunk, SandboxProviderError> =>
    Stream.unwrapScoped(
      Effect.gen(function* () {
        const config = sandboxes.get(sandbox.id)
        if (config === undefined) {
          return yield* commandError("stream", `sandbox not found: ${sandbox.id}`)
        }
        const built = yield* buildCommand(config, command)
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
        return output.pipe(Stream.concat(exit))
      }),
    )

  const execute = (
    sandbox: Sandbox,
    command: SandboxCommand,
  ): Effect.Effect<ExecutionResult, SandboxProviderError> => {
    const startedAt = Date.now()
    const stdout: Array<string> = []
    const stderr: Array<string> = []
    let exitCode = 1
    return stream(sandbox, command).pipe(
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
      Effect.map(() => ({
        exitCode,
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
        durationMs: Date.now() - startedAt,
        truncated: false,
        timedOut: false,
      })),
    )
  }

  return {
    name: providerName,
    capabilities: {
      ...defaultCapabilities,
      streaming: true,
    },
    // firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.1
    // firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.4
    // firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.5
    create,
    getOrCreate: config =>
      Effect.gen(function* () {
        const labels = config.labels ?? {}
        if (Object.keys(labels).length > 0) {
          const existing = yield* find(labels)
          if (existing !== undefined) return existing
        }
        return yield* create(config)
      }),
    find,
    execute,
    executeMany: (sandbox, commands) =>
      Effect.forEach(commands, command => execute(sandbox, command)),
    stream,
    upload: (_sandbox, _localPath, _remotePath) => unsupported("upload"),
    download: (_sandbox, _remotePath, _localPath) => unsupported("download"),
    destroy: sandbox => Effect.sync(() => sandboxes.delete(sandbox.id)),
  }
}

export const LocalProcessSandboxProvider = {
  layer: (): Layer.Layer<SandboxProvider, never, CommandExecutor> =>
    Layer.effect(
      SandboxProvider,
      Effect.map(CommandExecutorTag, makeLocalProcessSandboxProvider),
    ),
}
