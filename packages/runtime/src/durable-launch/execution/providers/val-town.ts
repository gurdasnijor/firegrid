import ValTown, { APIError } from "@valtown/sdk"
import { Effect, Redacted, Schema } from "effect"
import {
  defaultCapabilities,
  type ExecutionResult,
  type Sandbox,
  type SandboxConfig,
  type SandboxCommand,
  SandboxProviderError,
  SandboxProvider,
  type SandboxProviderService,
} from "../sandbox.ts"
import type { Layer } from "effect"

export class ValTownSandboxProviderError extends Schema.TaggedError<ValTownSandboxProviderError>()(
  "ValTownSandboxProviderError",
  {
    op: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export interface ValTownSandboxProviderOptions {
  readonly token: Redacted.Redacted<string>
  readonly httpSource: string
  readonly filePath?: string
  readonly privacy?: "public" | "unlisted" | "private"
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
}

export interface ValTownSandboxDeployment {
  readonly valId: string
  readonly endpoint: string
}

interface ValTownVal {
  readonly id: string
}

interface ValTownFile {
  readonly links?: {
    readonly endpoint?: string
  }
}

interface ValTownSandboxRecord {
  readonly sandbox: Sandbox
  readonly deployment: ValTownSandboxDeployment
  readonly launchId: string
  readonly providerWireStreamUrl?: string
}

interface ValTownLaunchConfig {
  readonly launchId: string
  readonly providerWireStreamUrl?: string
  readonly tracerSecret: string
}

const providerName = "val-town"

const errorMessage = (cause: unknown): string =>
  cause instanceof APIError
    ? `Val Town API ${cause.status}: ${cause.message}`
    : cause instanceof Error
    ? cause.message
    : String(cause)

const makeClient = (options: ValTownSandboxProviderOptions): ValTown =>
  new ValTown({
    bearerToken: Redacted.value(options.token),
    baseURL: options.baseUrl,
    fetch: options.fetch,
    maxRetries: 0,
    timeout: 15_000,
  })

const asProviderError = (
  op: string,
  cause: unknown,
): SandboxProviderError =>
  cause instanceof SandboxProviderError
    ? cause
    : new SandboxProviderError({
      provider: providerName,
      op,
      message: errorMessage(cause),
      cause,
    })

const requireLaunchConfig = (config: SandboxConfig): ValTownLaunchConfig => {
  const launchId = config.providerConfig?.["launchId"]
  if (typeof launchId !== "string") {
    throw new SandboxProviderError({
      provider: providerName,
      op: "createSandbox",
      message: "Val Town sandbox requires launchId providerConfig field",
    })
  }
  const providerWireStreamUrl = config.providerConfig?.["providerWireStreamUrl"]
  if (providerWireStreamUrl !== undefined && typeof providerWireStreamUrl !== "string") {
    throw new SandboxProviderError({
      provider: providerName,
      op: "createSandbox",
      message: "Val Town sandbox providerWireStreamUrl providerConfig field must be a string when provided",
    })
  }
  const tracerSecret = config.envVars?.["FIREGRID_TRACER_SECRET"]
  if (tracerSecret === undefined) {
    throw new SandboxProviderError({
      provider: providerName,
      op: "createSandbox",
      message: "Val Town sandbox requires FIREGRID_TRACER_SECRET env var",
    })
  }
  return {
    launchId,
    tracerSecret,
    ...(providerWireStreamUrl === undefined ? {} : { providerWireStreamUrl }),
  }
}

const deploySandbox = async (
  options: ValTownSandboxProviderOptions,
  launch: ValTownLaunchConfig,
): Promise<ValTownSandboxDeployment> => {
  const client = makeClient(options)
  const val = await client.vals.create({
    name: `firegrid_sandbox_${Date.now()}`,
    privacy: options.privacy ?? "public",
    description: "Firegrid Val Town sandbox",
  }).catch((cause: unknown) => {
    throw new ValTownSandboxProviderError({
      op: "createVal",
      message: `failed to create Val Town val: ${errorMessage(cause)}`,
      cause,
    })
  }) as ValTownVal

  try {
    await client.vals.environmentVariables.create(val.id, {
      key: "FIREGRID_TRACER_SECRET",
      value: launch.tracerSecret,
      description: "Firegrid sandbox secret binding",
    }).catch((cause: unknown) => {
      throw new ValTownSandboxProviderError({
        op: "createEnvironmentVariable",
        message: `failed to create Val Town environment variable: ${errorMessage(cause)}`,
        cause,
      })
    })

    const file = await client.vals.files.create(val.id, {
      path: options.filePath ?? "sandbox.ts",
      type: "http",
      content: options.httpSource,
    }).catch((cause: unknown) => {
      throw new ValTownSandboxProviderError({
        op: "createHttpFile",
        message: `failed to create Val Town HTTP file: ${errorMessage(cause)}`,
        cause,
      })
    }) as ValTownFile

    const endpoint = file.links?.endpoint
    if (endpoint === undefined) {
      throw new ValTownSandboxProviderError({
        op: "endpoint",
        message: "Val Town did not return an HTTP endpoint for sandbox file",
      })
    }

    return {
      valId: val.id,
      endpoint,
    }
  } catch (cause) {
    await destroySandboxDeployment(options, val.id).catch(() => undefined)
    throw cause
  }
}

const invokeSandbox = async (
  options: ValTownSandboxProviderOptions,
  record: ValTownSandboxRecord,
): Promise<unknown> => {
  const runFetch = options.fetch ?? fetch
  const response = await runFetch(record.deployment.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      launchId: record.launchId,
      providerWireStreamUrl: record.providerWireStreamUrl,
    }),
  })
  if (!response.ok) {
    throw new ValTownSandboxProviderError({
      op: "invoke",
      message: `Val Town sandbox invocation failed with HTTP ${response.status}: ${await response.text()}`,
    })
  }
  return await response.json()
}

const destroySandboxDeployment = async (
  options: ValTownSandboxProviderOptions,
  valId: string,
): Promise<void> => {
  const client = makeClient(options)
  try {
    await client.vals.delete(valId)
  } catch (cause) {
    if (cause instanceof APIError && cause.status === 404) return
    throw new ValTownSandboxProviderError({
      op: "deleteVal",
      message: `failed to delete Val Town val: ${errorMessage(cause)}`,
      cause,
    })
  }
}

const executionResult = (response: unknown): ExecutionResult => ({
  exitCode: 0,
  stdout: JSON.stringify(response),
  stderr: "",
  truncated: false,
  timedOut: false,
})

export const makeValTownSandboxProvider = (
  options: ValTownSandboxProviderOptions,
): SandboxProviderService => {
  const sandboxes = new Map<string, ValTownSandboxRecord>()
  return {
    name: providerName,
    capabilities: {
      ...defaultCapabilities,
      persistent: true,
    },
    createSandbox: config =>
      Effect.tryPromise({
        try: async () => {
          const launch = requireLaunchConfig(config)
          const deployment = await deploySandbox(options, launch)
          const sandbox = {
            id: deployment.valId,
            provider: providerName,
            state: "running",
            labels: config.labels ?? {},
            createdAt: new Date().toISOString(),
            connectionInfo: {
              endpoint: deployment.endpoint,
            },
            metadata: {},
          } satisfies Sandbox
          sandboxes.set(deployment.valId, {
            sandbox,
            deployment,
            launchId: launch.launchId,
            ...(launch.providerWireStreamUrl === undefined ? {} : {
              providerWireStreamUrl: launch.providerWireStreamUrl,
            }),
          })
          return sandbox
        },
        catch: cause => asProviderError("createSandbox", cause),
      }),
    getSandbox: sandboxId =>
      Effect.sync(() => sandboxes.get(sandboxId)?.sandbox),
    listSandboxes: labels =>
      Effect.sync(() =>
        Array.from(sandboxes.values(), record => record.sandbox)
          .filter(sandbox =>
            labels === undefined ||
            Object.entries(labels).every(([key, value]) => sandbox.labels[key] === value),
          ),
      ),
    executeCommand: (sandboxId: string, _command: SandboxCommand) =>
      Effect.tryPromise({
        try: async () => {
          const record = sandboxes.get(sandboxId)
          if (record === undefined) {
            throw new SandboxProviderError({
              provider: providerName,
              op: "executeCommand",
              message: `sandbox not found: ${sandboxId}`,
            })
          }
          return executionResult(await invokeSandbox(options, record))
        },
        catch: cause => asProviderError("executeCommand", cause),
      }),
    destroySandbox: sandboxId =>
      Effect.tryPromise({
        try: async () => {
          await destroySandboxDeployment(options, sandboxId)
          return sandboxes.delete(sandboxId)
        },
        catch: cause => asProviderError("destroySandbox", cause),
      }),
  }
}

export const ValTownSandboxProviderLive = (
  options: ValTownSandboxProviderOptions,
): Layer.Layer<SandboxProvider> =>
  SandboxProvider.layer(makeValTownSandboxProvider(options))
