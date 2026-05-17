import type { DurableTableHeaders } from "effect-durable-operators"
import type { LocalProcessSandboxProviderOptions } from "@firegrid/runtime/sources/sandbox"

export interface RuntimeHostConfigValue {
  readonly inputEnabled: boolean
  readonly durableStreamsBaseUrl: string
  readonly headers?: DurableTableHeaders
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
  // Stable host identity is required at the programmatic composition
  // boundary. Direct callers of FiregridRuntimeHostLive supply
  // `hostId` explicitly; `FiregridLocalHostLive` derives it
  // deterministically from the namespace. The runtime host does NOT
  // acquire identity from env or disk — a missing hostId is a
  // type-level mistake.
  readonly hostId: string
  // Per-process session identifier. When omitted, the layer assigns
  // a fresh value; durable identity remains hostId.
  readonly hostSessionId?: string
  readonly headers?: DurableTableHeaders
  readonly input?: boolean
  readonly localProcessEnv?: LocalProcessSandboxProviderOptions
}
