import type { DurableTableHeaders } from "effect-durable-operators"
import type { LocalProcessSandboxProviderOptions } from "../providers/sandboxes/local-process.ts"

export interface RuntimeHostConfigValue {
  readonly inputEnabled: boolean
}

export interface StartRuntimeOptions {
  readonly contextId: string
}

export interface StartRuntimeResult {
  readonly contextId: string
  readonly activityAttempt: number
  readonly exitCode: number
  readonly signal?: string
}

export interface RuntimeHostTopologyOptions {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly headers?: DurableTableHeaders
  readonly input?: boolean
  readonly localProcessEnv?: LocalProcessSandboxProviderOptions
}
