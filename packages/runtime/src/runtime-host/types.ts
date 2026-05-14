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
  // firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
  //
  // Stable host identity for this runtime process. When omitted, V1
  // generates a fresh `host_<uuid>` at boot — durable persistence of a
  // stable host id (e.g. `$HOME/.firegrid/host-id`) is follow-up work.
  // The hostSessionId is per-process and may always be regenerated.
  readonly hostId?: string
  readonly hostSessionId?: string
  readonly headers?: DurableTableHeaders
  readonly input?: boolean
  readonly localProcessEnv?: LocalProcessSandboxProviderOptions
}
