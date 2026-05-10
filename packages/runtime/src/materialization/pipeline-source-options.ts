import type { RuntimeOutputCursor } from "@firegrid/protocol/launch"
import type { RuntimeOutputContextEventSourceOptions } from "./runtime-output-source.ts"

interface RuntimeOutputProjectionSourceInput {
  readonly runtimeOutputStreamUrl: string
  readonly contextId: string
  readonly since?: RuntimeOutputCursor
}

export const runtimeOutputProjectionSourceOptions = (
  options: RuntimeOutputProjectionSourceInput,
): RuntimeOutputContextEventSourceOptions =>
  options.since === undefined
    ? {
      streamUrl: options.runtimeOutputStreamUrl,
      contextId: options.contextId,
    }
    : {
      streamUrl: options.runtimeOutputStreamUrl,
      contextId: options.contextId,
      since: options.since,
    }
