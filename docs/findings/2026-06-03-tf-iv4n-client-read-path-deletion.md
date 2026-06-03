# tf-iv4n client direct-table read deletion

## Finding

The client SDK no longer exports or composes host durable-table facades as a caller-facing read path. `packages/client-sdk/src/firegrid.ts` now builds `FiregridLive` from protocol channel Tags only; the old `RuntimeControlPlaneTable` / `RuntimeOutputTable` imports, table escape-hatch exports, snapshot/watch projection helpers, and standalone table layers were removed.

Session output waits remain on the direct session handle, but they now read the configured `session.agent_output` ingress channel instead of opening `RuntimeOutputTable`. Snapshot/watch/list observations live on the MCP client path (`packages/client-sdk/src/mcp.ts`).

## Guard

`.dependency-cruiser.cjs` now has `client-sdk-no-runtime-or-durable-substrate`, which forbids `packages/client-sdk/src` from depending on `packages/runtime/src` or `effect-durable-operators`. `effect-durable-streams` wire imports remain allowed for the MCP transport.

## Consumer Updates

The stale runtime misuse-resistance proof was updated to prove the direct client control/write surface. Tiny-firegrid sims that used direct snapshots now derive evidence from session output waits or record that arbitrary child-context projection reads moved to MCP observation coverage.
