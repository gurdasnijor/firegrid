import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import { Context, Effect, Layer, Schema } from "effect"

export const SandboxStateSchema = Schema.Literal(
  "creating",
  "starting",
  "running",
  "stopping",
  "stopped",
  "terminated",
  "error",
)
export type SandboxState = Schema.Schema.Type<typeof SandboxStateSchema>

export const SandboxConfigSchema = Schema.Struct({
  image: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
  memoryMb: Schema.optional(Schema.Number),
  cpuCores: Schema.optional(Schema.Number),
  timeoutSeconds: Schema.optional(Schema.Number),
  envVars: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  labels: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  providerConfig: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  setupCommands: Schema.optional(Schema.Array(Schema.Array(Schema.String))),
  workingDir: Schema.optional(Schema.String),
})
export type SandboxConfig = Schema.Schema.Type<typeof SandboxConfigSchema>

export const SandboxCommandSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
})
export type SandboxCommand = Schema.Schema.Type<typeof SandboxCommandSchema>

export const ExecutionResultSchema = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
  durationMs: Schema.optional(Schema.Number),
  truncated: Schema.Boolean,
  timedOut: Schema.Boolean,
})
export type ExecutionResult = Schema.Schema.Type<typeof ExecutionResultSchema>

export const SandboxSchema = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  state: SandboxStateSchema,
  labels: Schema.Record({ key: Schema.String, value: Schema.String }),
  createdAt: Schema.optional(Schema.String),
  connectionInfo: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
})
export type Sandbox = Schema.Schema.Type<typeof SandboxSchema>

export const ProviderCapabilitiesSchema = Schema.Struct({
  persistent: Schema.Boolean,
  snapshot: Schema.Boolean,
  streaming: Schema.Boolean,
  fileUpload: Schema.Boolean,
  interactiveShell: Schema.Boolean,
  gpu: Schema.Boolean,
})
export type ProviderCapabilities = Schema.Schema.Type<typeof ProviderCapabilitiesSchema>

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
