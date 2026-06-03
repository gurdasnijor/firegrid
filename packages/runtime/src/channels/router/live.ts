// The legacy flattened `ChannelMetadata` view. The router Tag/factory live in
// `@firegrid/runtime/channels` (the runtime root); the deprecated catalog shim
// that used to live here was retired with the channel-catalog burn-down.

import type { ChannelSourceClass, ChannelTarget } from "@firegrid/protocol/channels"
import type { Schema } from "effect"

/**
 * @deprecated ChannelRouteMetadata from @firegrid/protocol/channels/router is
 * the canonical router metadata shape. This legacy flattened shape remains for
 * tests and old host-sdk callers during the catalog burn-down.
 */
export type ChannelMetadata =
  | {
    readonly target: ChannelTarget
    readonly direction: "ingress"
    readonly schema: Schema.Schema.Any
    readonly sourceClass?: ChannelSourceClass
  }
  | {
    readonly target: ChannelTarget
    readonly direction: "egress"
    readonly schema: Schema.Schema.Any
  }
  | {
    readonly target: ChannelTarget
    readonly direction: "bidirectional"
    readonly directions: readonly ["ingress", "egress"]
    readonly schema: Schema.Schema.Any
    readonly sourceClasses: ReadonlyArray<ChannelSourceClass>
  }
  | {
    readonly target: ChannelTarget
    readonly direction: "call"
    readonly requestSchema: Schema.Schema.Any
    readonly responseSchema: Schema.Schema.Any
  }
