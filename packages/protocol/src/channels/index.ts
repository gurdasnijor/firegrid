/**
 * `@firegrid/protocol/channels` — channel CONTRACT pieces.
 *
 * Owns:
 *   - Channel type definitions (Ingress/Egress/Call/Bidirectional) and
 *     direction/source-class schemas + ChannelTarget brand + binding
 *     interface types + channel factory functions (`./core.ts`)
 *   - Per-channel Context.Tag declarations + per-channel request/response
 *     schemas (one file per channel)
 *
 * Does NOT own:
 *   - ChannelInventory / makeChannelInventory / ChannelInventoryLive /
 *     findChannel (stay in host-sdk during the tf-kddg transition;
 *     deleted or narrowed to a thin MCP-edge string→capability adapter
 *     as the inventory bridge is unwound)
 *   - Live Layer bindings that touch RuntimeOutputTable / DurableTable /
 *     workflow engine / runtime control plane (those belong in
 *     host-sdk/runtime/app integration packages)
 */

export * from "./core.ts"
export * from "./session-agent-output.ts"
export * from "./session-permission.ts"
export * from "./host-sessions-create-or-load.ts"
