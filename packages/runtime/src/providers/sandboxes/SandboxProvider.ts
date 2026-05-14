import type { Effect, Scope, Stream } from "effect"
import { Context, Layer, Schema } from "effect"
import type { AgentByteStream } from "../../agent-io/index.ts"

type SandboxState =
  | "creating"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "terminated"
  | "error"

export interface SandboxConfig {
  readonly image?: string
  readonly language?: string
  readonly memoryMb?: number
  readonly cpuCores?: number
  readonly timeoutSeconds?: number
  readonly envVars?: Record<string, string>
  readonly labels?: Record<string, string>
  readonly providerConfig?: Record<string, unknown>
  readonly setupCommands?: ReadonlyArray<ReadonlyArray<string>>
  readonly workingDir?: string
}

export interface SandboxCommand {
  readonly argv: ReadonlyArray<string>
  readonly cwd?: string
  readonly envVars?: Record<string, string>
  readonly stdin?: string | Stream.Stream<Uint8Array, unknown>
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
  readonly createdAt?: string
  readonly connectionInfo: Record<string, unknown>
  readonly metadata: Record<string, unknown>
}

interface SandboxProviderCapabilities {
  readonly persistent: boolean
  readonly snapshot: boolean
  readonly streaming: boolean
  readonly fileUpload: boolean
  readonly interactiveShell: boolean
  readonly gpu: boolean
}

export type ProcessOutputChunk =
  | {
    readonly type: "output"
    readonly channel: "stdout" | "stderr"
    readonly text: string
  }
  | {
    readonly type: "exit"
    readonly exitCode: number
    readonly signal?: string
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
  readonly capabilities: SandboxProviderCapabilities
  readonly create: (config: SandboxConfig) => Effect.Effect<Sandbox, SandboxProviderError>
  readonly getOrCreate: (config: SandboxConfig) => Effect.Effect<Sandbox, SandboxProviderError>
  readonly find: (labels: Record<string, string>) => Effect.Effect<Sandbox | undefined, SandboxProviderError>
  readonly execute: (
    sandbox: Sandbox,
    command: SandboxCommand,
  ) => Effect.Effect<ExecutionResult, SandboxProviderError>
  readonly executeMany: (
    sandbox: Sandbox,
    commands: ReadonlyArray<SandboxCommand>,
  ) => Effect.Effect<ReadonlyArray<ExecutionResult>, SandboxProviderError>
  readonly stream: (
    sandbox: Sandbox,
    command: SandboxCommand,
  ) => Stream.Stream<ProcessOutputChunk, SandboxProviderError>
  // Byte-pipe variant: launch the process and expose its stdio as a
  // duplex byte stream for codecs that need byte-level framing (ACP,
  // future protocol-aware agents). The line-split `stream` API stays
  // for jsonl agents; this method coexists with it.
  //
  // Scope semantics: closing the returned scope kills the launched
  // process and releases the underlying transport. Codecs are
  // responsible for emitting durable observations of the bytes
  // flowing through.
  readonly openBytePipe: (
    sandbox: Sandbox,
    command: SandboxCommand,
  ) => Effect.Effect<AgentByteStream, SandboxProviderError, Scope.Scope>
  readonly upload: (sandbox: Sandbox, localPath: string, remotePath: string) => Effect.Effect<void, SandboxProviderError>
  readonly download: (sandbox: Sandbox, remotePath: string, localPath: string) => Effect.Effect<void, SandboxProviderError>
  readonly destroy: (sandbox: Sandbox) => Effect.Effect<boolean, SandboxProviderError>
}

export class SandboxProvider extends Context.Tag("firegrid/sandboxes/SandboxProvider")<
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
} satisfies SandboxProviderCapabilities

export const findRunningSandbox = (
  sandboxes: ReadonlyArray<Sandbox>,
): Sandbox | undefined => sandboxes.find(sandbox => sandbox.state === "running")
