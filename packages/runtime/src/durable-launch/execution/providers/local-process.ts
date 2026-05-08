import { Command } from "@effect/platform"
import {
  defaultCapabilities,
  type SandboxConfig,
  SandboxProviderError,
  SandboxProvider,
  type SandboxProviderService,
} from "../sandbox.ts"
import { Effect } from "effect"

const makeLocalProcessSandboxProvider = (): SandboxProviderService => {
  const sandboxes = new Map<string, SandboxConfig>()
  const name = "local-process"
  return {
    name,
    capabilities: defaultCapabilities,
    createSandbox: config =>
      Effect.sync(() => {
        const id = `local-process:${crypto.randomUUID()}`
        sandboxes.set(id, config)
        return {
          id,
          provider: name,
          state: "running",
          labels: config.labels ?? {},
          createdAt: new Date().toISOString(),
          connectionInfo: {},
          metadata: {},
        }
      }),
    getSandbox: sandboxId =>
      Effect.sync(() => {
        const config = sandboxes.get(sandboxId)
        if (config === undefined) return undefined
        return {
          id: sandboxId,
          provider: name,
          state: "running",
          labels: config.labels ?? {},
          connectionInfo: {},
          metadata: {},
        }
      }),
    listSandboxes: labels =>
      Effect.sync(() =>
        Array.from(sandboxes, ([id, config]) => ({
          id,
          provider: name,
          state: "running" as const,
          labels: config.labels ?? {},
          connectionInfo: {},
          metadata: {},
        })).filter(sandbox =>
          labels === undefined ||
          Object.entries(labels).every(([key, value]) => sandbox.labels[key] === value),
        ),
      ),
    executeCommand: (sandboxId, command, options) =>
      Effect.gen(function* () {
        const config = sandboxes.get(sandboxId)
        if (config === undefined) {
          return yield* new SandboxProviderError({
            provider: name,
            op: "executeCommand",
            message: `sandbox not found: ${sandboxId}`,
          })
        }
        const [executable, ...args] = command.argv
        if (executable === undefined) {
          return yield* new SandboxProviderError({
            provider: name,
            op: "executeCommand",
            message: "command argv is empty",
          })
        }
        const startedAt = Date.now()
        let built = Command.make(executable, ...args).pipe(
          Command.env({
            ...config.envVars,
            ...options?.envVars,
          }),
        )
        const cwd = command.cwd ?? config.workingDir
        if (cwd !== undefined) built = built.pipe(Command.workingDirectory(cwd))
        const exitCode = yield* Command.exitCode(built).pipe(
          Effect.map(Number),
          Effect.mapError(cause =>
            new SandboxProviderError({
              provider: name,
              op: "executeCommand",
              message: "local process command failed to start or complete",
              cause,
            }),
          ),
        )
        return {
          exitCode,
          stdout: "",
          stderr: "",
          durationMs: Date.now() - startedAt,
          truncated: false,
          timedOut: false,
        }
      }),
    destroySandbox: sandboxId =>
      Effect.sync(() => sandboxes.delete(sandboxId)),
  }
}

export const LocalProcessSandboxProviderLive =
  SandboxProvider.layer(makeLocalProcessSandboxProvider())
