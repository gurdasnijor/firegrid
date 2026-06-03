import { Clock, Effect } from "effect"
import {
  defaultCapabilities,
  findRunningSandbox,
  type ExecutionResult,
  type Sandbox,
  type SandboxConfig,
  SandboxProviderError,
  type SandboxProviderService,
} from "./SandboxProvider.ts"

type ExecutionResultCore = Pick<ExecutionResult, "exitCode" | "stdout" | "stderr">

export const sandboxProviderError = (
  provider: string,
  op: string,
  message: string,
  cause?: unknown,
): SandboxProviderError =>
  new SandboxProviderError({
    provider,
    op,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

export const unsupportedSandboxProviderOperation = <A>(
  provider: string,
  op: string,
  label = provider,
): Effect.Effect<A, SandboxProviderError> =>
  Effect.fail(sandboxProviderError(provider, op, `${label} provider does not support ${op}`))

export const runningSandboxFromConfig = (
  provider: string,
  id: string,
  config: SandboxConfig,
  metadata: Record<string, unknown> = {},
): Sandbox => ({
  id,
  provider,
  state: "running",
  labels: config.labels ?? {},
  // Pure sync Sandbox value-builder (passed as a non-Effect callback to the
  // in-memory store); `createdAt` is local metadata, not durable workflow state.
  // effect-quality-allow-wall-clock
  createdAt: new Date().toISOString(),
  connectionInfo: {},
  metadata,
})

export const makeInMemorySandboxStore = (
  provider: string,
  sandboxFromConfig: (id: string, config: SandboxConfig) => Sandbox =
    (id, config) => runningSandboxFromConfig(provider, id, config),
) => {
  const configs = new Map<string, SandboxConfig>()

  const create = (config: SandboxConfig) =>
    Effect.sync(() => {
      const id = `${provider}:${crypto.randomUUID()}`
      configs.set(id, config)
      return sandboxFromConfig(id, config)
    })

  const find = (labels: Record<string, string>) =>
    Effect.sync(() => {
      const entries = Object.entries(labels)
      if (entries.length === 0) return undefined
      return findRunningSandbox(
        Array.from(configs, ([id, config]) => sandboxFromConfig(id, config))
          .filter(sandbox =>
            entries.every(([key, value]) => sandbox.labels[key] === value),
          ),
      )
    })

  const getOrCreate = (config: SandboxConfig) =>
    Effect.gen(function* () {
      const labels = config.labels ?? {}
      if (Object.keys(labels).length > 0) {
        const existing = yield* find(labels)
        if (existing !== undefined) return existing
      }
      return yield* create(config)
    })

  const configFor = (
    sandbox: Sandbox,
    op: string,
  ): Effect.Effect<SandboxConfig, SandboxProviderError> =>
    Effect.gen(function* () {
      const config = configs.get(sandbox.id)
      if (config === undefined) {
        return yield* sandboxProviderError(provider, op, `sandbox not found: ${sandbox.id}`)
      }
      return config
    })

  const destroy = (sandbox: Sandbox) => Effect.sync(() => configs.delete(sandbox.id))

  return {
    create,
    getOrCreate,
    find,
    configFor,
    destroy,
  }
}

interface SandboxProviderServiceOptions {
  readonly name: string
  readonly capabilities?: Partial<SandboxProviderService["capabilities"]>
  readonly store: ReturnType<typeof makeInMemorySandboxStore>
  readonly execute: SandboxProviderService["execute"]
  readonly stream: SandboxProviderService["stream"]
  readonly openBytePipe: SandboxProviderService["openBytePipe"]
  readonly upload?: SandboxProviderService["upload"]
  readonly download?: SandboxProviderService["download"]
}

export const makeSandboxProviderService = (
  options: SandboxProviderServiceOptions,
): SandboxProviderService => ({
  name: options.name,
  capabilities: {
    ...defaultCapabilities,
    ...options.capabilities,
  },
  create: options.store.create,
  getOrCreate: options.store.getOrCreate,
  find: options.store.find,
  execute: options.execute,
  executeMany: (sandbox, commands) =>
    Effect.forEach(commands, command => options.execute(sandbox, command)),
  stream: options.stream,
  openBytePipe: options.openBytePipe,
  upload: options.upload ?? ((_sandbox, _localPath, _remotePath) =>
    unsupportedSandboxProviderOperation(options.name, "upload")),
  download: options.download ?? ((_sandbox, _remotePath, _localPath) =>
    unsupportedSandboxProviderOperation(options.name, "download")),
  destroy: options.store.destroy,
})

export const withExecutionDuration = <E, R>(
  effect: Effect.Effect<ExecutionResultCore, E, R>,
): Effect.Effect<ExecutionResult, E, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const core = yield* effect
    const finishedAt = yield* Clock.currentTimeMillis
    return {
      ...core,
      durationMs: finishedAt - startedAt,
      truncated: false,
      timedOut: false,
    }
  })
