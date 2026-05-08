import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import { Context, Effect, Layer, Schema } from "effect"

type SandboxState =
  | "creating"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "terminated"
  | "error"

export interface SandboxConfig {
  readonly image?: string | undefined
  readonly language?: string | undefined
  readonly memoryMb?: number | undefined
  readonly cpuCores?: number | undefined
  readonly timeoutSeconds?: number | undefined
  readonly envVars?: Record<string, string> | undefined
  readonly labels?: Record<string, string> | undefined
  readonly providerConfig?: Record<string, unknown> | undefined
  readonly setupCommands?: ReadonlyArray<ReadonlyArray<string>> | undefined
  readonly workingDir?: string | undefined
}

export interface SandboxCommand {
  readonly argv: ReadonlyArray<string>
  readonly cwd?: string | undefined
}

export interface ExecutionResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs?: number
  readonly truncated: boolean
  readonly timedOut: boolean
}

export interface Sandbox {
  readonly id: string
  readonly provider: string
  readonly state: SandboxState
  readonly labels: Record<string, string>
  readonly createdAt?: string | undefined
  readonly connectionInfo: Record<string, unknown>
  readonly metadata: Record<string, unknown>
}

interface ProviderCapabilities {
  readonly persistent: boolean
  readonly snapshot: boolean
  readonly streaming: boolean
  readonly fileUpload: boolean
  readonly interactiveShell: boolean
  readonly gpu: boolean
}

export class SandboxProviderError extends Schema.TaggedError<SandboxProviderError>()(
  "SandboxProviderError",
  {
    provider: Schema.String,
    op: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export interface SandboxProviderService {
  readonly name: string
  readonly capabilities: ProviderCapabilities
  readonly createSandbox: (config: SandboxConfig) => Effect.Effect<Sandbox, SandboxProviderError>
  readonly getSandbox: (sandboxId: string) => Effect.Effect<Sandbox | undefined, SandboxProviderError>
  readonly listSandboxes: (labels?: Record<string, string>) => Effect.Effect<ReadonlyArray<Sandbox>, SandboxProviderError>
  readonly executeCommand: (
    sandboxId: string,
    command: SandboxCommand,
    options?: {
      readonly timeoutSeconds?: number
      readonly envVars?: Record<string, string>
    },
  ) => Effect.Effect<ExecutionResult, SandboxProviderError, CommandExecutor>
  readonly destroySandbox: (sandboxId: string) => Effect.Effect<boolean, SandboxProviderError>
}

export class SandboxProvider extends Context.Tag("firegrid/runtime/durable-launch/SandboxProvider")<
  SandboxProvider,
  SandboxProviderService
>() {
  static layer = (service: SandboxProviderService): Layer.Layer<SandboxProvider> =>
    Layer.succeed(this, service)
}

export const defaultCapabilities = {
  persistent: false,
  snapshot: false,
  streaming: false,
  fileUpload: false,
  interactiveShell: false,
  gpu: false,
} satisfies ProviderCapabilities

export const getOrCreateSandbox = (
  provider: SandboxProviderService,
  config: SandboxConfig,
): Effect.Effect<Sandbox, SandboxProviderError> =>
  Effect.gen(function* () {
    const labels = config.labels ?? {}
    if (Object.keys(labels).length > 0) {
      const existing = (yield* provider.listSandboxes(labels))
        .find(sandbox => sandbox.state === "running")
      if (existing !== undefined) return existing
    }
    return yield* provider.createSandbox(config)
  })
