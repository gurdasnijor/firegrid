import type { DurableTableHeaders } from "effect-durable-operators"

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
}
