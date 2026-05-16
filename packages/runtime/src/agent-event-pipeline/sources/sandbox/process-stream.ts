import { Effect, Stream } from "effect"
import {
  SandboxProvider,
  type ProcessOutputChunk,
  type SandboxCommand,
  type SandboxProviderError,
} from "./SandboxProvider.ts"

export const streamSandboxProcess = (
  options: {
    readonly labels: Record<string, string>
    readonly workingDir?: string
    readonly providerConfig?: Record<string, unknown>
    readonly command: SandboxCommand
  },
): Stream.Stream<ProcessOutputChunk, SandboxProviderError, SandboxProvider> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const provider = yield* SandboxProvider
      const sandbox = yield* Effect.acquireRelease(
        provider.getOrCreate({
          labels: options.labels,
          ...(options.workingDir === undefined ? {} : { workingDir: options.workingDir }),
          ...(options.providerConfig === undefined ? {} : { providerConfig: options.providerConfig }),
        }),
        sandbox => provider.destroy(sandbox).pipe(Effect.ignore),
      )
      return provider.stream(sandbox, options.command)
    }),
  )
