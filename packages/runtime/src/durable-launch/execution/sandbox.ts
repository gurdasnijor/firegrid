import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import type { Effect, Stream } from "effect"
import { Context, Layer, Schema } from "effect"

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
  envVars: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
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

export const ProcessOutputChunkSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("output"),
    channel: Schema.Literal("stdout", "stderr"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("exit"),
    exitCode: Schema.Number,
    signal: Schema.optional(Schema.String),
  }),
)
export type ProcessOutputChunk = Schema.Schema.Type<typeof ProcessOutputChunkSchema>

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
  readonly create: (config: SandboxConfig) => Effect.Effect<Sandbox, SandboxProviderError>
  readonly getOrCreate: (config: SandboxConfig) => Effect.Effect<Sandbox, SandboxProviderError>
  readonly find: (labels: Record<string, string>) => Effect.Effect<Sandbox | undefined, SandboxProviderError>
  readonly execute: (
    sandbox: Sandbox,
    command: SandboxCommand,
  ) => Effect.Effect<ExecutionResult, SandboxProviderError, CommandExecutor>
  readonly executeMany: (
    sandbox: Sandbox,
    commands: ReadonlyArray<SandboxCommand>,
  ) => Effect.Effect<ReadonlyArray<ExecutionResult>, SandboxProviderError, CommandExecutor>
  readonly stream: (
    sandbox: Sandbox,
    command: SandboxCommand,
  ) => Stream.Stream<ProcessOutputChunk, SandboxProviderError, CommandExecutor>
  readonly upload: (sandbox: Sandbox, localPath: string, remotePath: string) => Effect.Effect<void, SandboxProviderError>
  readonly download: (sandbox: Sandbox, remotePath: string, localPath: string) => Effect.Effect<void, SandboxProviderError>
  readonly destroy: (sandbox: Sandbox) => Effect.Effect<boolean, SandboxProviderError>
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

export const findRunningSandbox = (
  sandboxes: ReadonlyArray<Sandbox>,
): Sandbox | undefined => sandboxes.find(sandbox => sandbox.state === "running")
