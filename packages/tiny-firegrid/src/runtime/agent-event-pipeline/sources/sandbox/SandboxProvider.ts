import type {
  ExecutionResult,
  ProcessOutputChunk,
  Sandbox,
  SandboxCommand,
  SandboxConfig,
  SandboxProviderService,
} from "@firegrid/runtime/sources/sandbox"
import { SandboxProviderError } from "@firegrid/runtime/sources/sandbox"
import { Effect, Stream } from "effect"

type OutputChunk = Extract<ProcessOutputChunk, { readonly type: "output" }>

const isOutputChunk = (chunk: ProcessOutputChunk): chunk is OutputChunk =>
  chunk.type === "output"

export const tinySandbox = (id = "tiny-sandbox"): Sandbox => ({
  id,
  provider: "tiny-firegrid",
  state: "running",
  labels: {},
  connectionInfo: {},
  metadata: {},
})

export const tinySandboxProvider = (
  chunks: ReadonlyArray<ProcessOutputChunk>,
): SandboxProviderService => ({
  name: "tiny-firegrid",
  capabilities: {
    persistent: false,
    snapshot: false,
    streaming: true,
    fileUpload: false,
    interactiveShell: false,
    gpu: false,
  },
  create: (_config: SandboxConfig) => Effect.succeed(tinySandbox()),
  getOrCreate: (_config: SandboxConfig) => Effect.succeed(tinySandbox()),
  find: (_labels: Record<string, string>) => Effect.succeed(tinySandbox()),
  execute: (_sandbox: Sandbox, _command: SandboxCommand): Effect.Effect<ExecutionResult> =>
    Effect.succeed({
      exitCode: 0,
      stdout: chunks
        .filter(isOutputChunk)
        .filter(chunk => chunk.channel === "stdout")
        .map(chunk => chunk.text)
        .join(""),
      stderr: chunks
        .filter(isOutputChunk)
        .filter(chunk => chunk.channel === "stderr")
        .map(chunk => chunk.text)
        .join(""),
      truncated: false,
      timedOut: false,
    }),
  executeMany: (sandbox, commands) =>
    Effect.forEach(commands, command =>
      tinySandboxProvider(chunks).execute(sandbox, command)),
  stream: (_sandbox, _command) => Stream.fromIterable(chunks),
  openBytePipe: () =>
    Effect.fail(new SandboxProviderError({
      provider: "tiny-firegrid",
      op: "openBytePipe",
      message: "tiny-firegrid mock sandbox models line/chunk stream output only",
    })),
  upload: () => Effect.void,
  download: () => Effect.void,
  destroy: () => Effect.succeed(true),
})
