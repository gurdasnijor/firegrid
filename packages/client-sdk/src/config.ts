import { Context } from "effect"
import type { ChannelRegistration } from "@firegrid/protocol/channels"

/**
 * Client/consumer configuration — the durable-streams endpoint a consumer
 * talks to. Kept in its own dependency-light module (not the deleted
 * `firegrid.ts` client facade) so MCP-only consumers can read it without
 * pulling in any client surface.
 */
export interface ClientOptions {
  readonly durableStreamsBaseUrl?: string
  readonly namespace?: string
  readonly runtimeStreamUrl?: string
  readonly contentType?: string
  readonly txTimeoutMs?: number
  readonly channels?: ReadonlyArray<ChannelRegistration>
}

export class FiregridConfig extends Context.Tag("@firegrid/client/FiregridConfig")<
  FiregridConfig,
  ClientOptions
>() {}
