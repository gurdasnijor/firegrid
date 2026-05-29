import { LanguageModel } from "@effect/ai"
import type { Prompt } from "@effect/ai"
import { Effect, Layer, Option, type Scope, Stream } from "effect"
import type { AgentByteStream } from "./byte-stream.ts"
import { SandboxProvider } from "./SandboxProvider.ts"
import type * as SandboxProviderContract from "./SandboxProvider.ts"
import {
  makeInMemorySandboxStore,
  makeSandboxProviderService,
  runningSandboxFromConfig,
  sandboxProviderError,
  unsupportedSandboxProviderOperation,
  withExecutionDuration,
} from "./internal-provider.ts"

const providerName = "effect-ai"

export interface EffectAiSandboxConfig {
  readonly labels?: Record<string, string>
  readonly providerConfig?: Record<string, unknown>
}

export interface EffectAiSandboxProviderHelper {
  readonly provider: typeof providerName
  readonly config: EffectAiSandboxConfig
}

export const effectAi = (
  config: EffectAiSandboxConfig = {},
): EffectAiSandboxProviderHelper => ({
  provider: providerName,
  config,
})

const providerError = (
  op: string,
  message: string,
  cause?: unknown,
): SandboxProviderContract.SandboxProviderError =>
  sandboxProviderError(providerName, op, message, cause)

const unsupported = <A>(
  op: string,
): Effect.Effect<A, SandboxProviderContract.SandboxProviderError> =>
  unsupportedSandboxProviderOperation(providerName, op)

const sandboxFromConfig = (
  id: string,
  config: SandboxProviderContract.SandboxConfig,
): SandboxProviderContract.Sandbox =>
  runningSandboxFromConfig(providerName, id, config, {
    ...(config.providerConfig ?? {}),
    provider: providerName,
  })

const commandPrompt = (
  config: SandboxProviderContract.SandboxConfig,
  command: SandboxProviderContract.SandboxCommand,
): Effect.Effect<Prompt.RawInput, SandboxProviderContract.SandboxProviderError> => {
  if (command.cwd !== undefined || config.workingDir !== undefined) {
    return unsupported("command.cwd")
  }
  if (
    command.envVars !== undefined ||
    config.envVars !== undefined ||
    config.setupCommands !== undefined
  ) {
    return unsupported("command.env")
  }
  if (command.stdin !== undefined && typeof command.stdin !== "string") {
    return Effect.fail(providerError(
      "command.stdin",
      "effect-ai provider supports string stdin but not stream-shaped stdin",
    ))
  }

  // firegrid-effect-ai-inprocess-provider.EXECUTION.1-1
  const argvText = command.argv.join(" ").trim()
  const stdinText = command.stdin?.trim()
  const prompt = [argvText, stdinText]
    .filter(text => text !== undefined && text.length > 0)
    .join("\n")

  if (prompt.length === 0) {
    return Effect.fail(providerError("command.prompt", "command prompt is empty"))
  }
  return Effect.succeed(prompt)
}

const makeEffectAiSandboxProvider = (
  languageModel: LanguageModel.Service,
): SandboxProviderContract.SandboxProviderService => {
  const store = makeInMemorySandboxStore(providerName, sandboxFromConfig)

  const execute = (
    sandbox: SandboxProviderContract.Sandbox,
    command: SandboxProviderContract.SandboxCommand,
  ): Effect.Effect<SandboxProviderContract.ExecutionResult, SandboxProviderContract.SandboxProviderError> =>
    withExecutionDuration(Effect.gen(function* () {
      const config = yield* store.configFor(sandbox, "execute")
      const prompt = yield* commandPrompt(config, command)
      const response = yield* languageModel.generateText({ prompt }).pipe(
        Effect.mapError(cause =>
          providerError("execute", "effect ai generateText failed", cause),
        ),
      )
      return {
        exitCode: 0,
        stdout: response.text,
        stderr: "",
      }
    }))

  const stream = (
    sandbox: SandboxProviderContract.Sandbox,
    command: SandboxProviderContract.SandboxCommand,
  ): Stream.Stream<SandboxProviderContract.ProcessOutputChunk, SandboxProviderContract.SandboxProviderError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const config = yield* store.configFor(sandbox, "stream")
        const prompt = yield* commandPrompt(config, command)
        // firegrid-effect-ai-inprocess-provider.EXECUTION.2
        return languageModel.streamText({ prompt }).pipe(
          Stream.filterMap(part =>
            part.type === "text-delta"
              ? Option.some({
                type: "output",
                channel: "stdout",
                text: part.delta,
              } satisfies SandboxProviderContract.ProcessOutputChunk)
              : Option.none(),
          ),
          Stream.mapError(cause =>
            providerError("stream", "effect ai streamText failed", cause),
          ),
          Stream.concat(Stream.succeed({
            type: "exit",
            exitCode: 0,
          } satisfies SandboxProviderContract.ProcessOutputChunk)),
        )
      }),
    )

  return makeSandboxProviderService({
    name: providerName,
    // firegrid-effect-ai-inprocess-provider.SANDBOX_PROVIDER.3
    capabilities: {
      streaming: true,
    },
    // firegrid-effect-ai-inprocess-provider.SANDBOX_PROVIDER.1
    // firegrid-effect-ai-inprocess-provider.SANDBOX_PROVIDER.2
    store,
    execute,
    stream,
    openBytePipe: (_sandbox, _command): Effect.Effect<AgentByteStream, SandboxProviderContract.SandboxProviderError, Scope.Scope> =>
      unsupported("openBytePipe"),
  })
}

export const EffectAiSandboxProvider = {
  layer: (): Layer.Layer<SandboxProvider, never, LanguageModel.LanguageModel> =>
    Layer.effect(
      SandboxProvider,
      Effect.map(LanguageModel.LanguageModel, languageModel =>
        makeEffectAiSandboxProvider(languageModel),
      ),
    ),
}
