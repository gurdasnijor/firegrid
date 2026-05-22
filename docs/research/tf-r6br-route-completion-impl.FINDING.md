# tf-r6br — Route completion metadata + receipt schema (production follow-on to tf-nioy)

Status: PARTIAL implementation landed; ACP terminal prompt-completion projection
**STOP/reported as boundary-gated** on tf-aseo (production DurableOutputCursor).
Date: 2026-05-22 · Predecessor: tf-nioy / #595 (SDD amendment) ·
SDD: `docs/sdds/SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md` §"Completion Contracts".

## What landed (clean, boundary-respecting)

The boundary-respecting half of the SDD's completion contract:

1. **Protocol-owned completion contract** (`packages/protocol/src/channels/core.ts`):
   - `ChannelRouteCompletion` = `{ mode: "acknowledgement" } | { mode: "terminal"; receiptSchema }`.
     Route-owned descriptor metadata, **not** a call-site sync flag / `isComplete`
     boolean / await-mode enum (the SDD rejects caller flags — a caller can diverge
     and router metadata can't inspect a caller flag).
   - `RouteCompletionReceipt` = transport-neutral `Done | Rejected` terminal receipt
     schema (SDD point 2). Edges project it to wire responses (e.g. ACP `PromptResponse`
     + stop reason); protocol does not encode transport-specific reason vocab.
   - Threaded an optional `completion` through the four channel registration
     interfaces/factories and into `ChannelRouteMetadata` / `ChannelRouteDescriptor`
     (`router.ts`). Defaults to `acknowledgement`, so every route now carries an
     edge-inspectable completion classification.
2. **ACP-edge immediate-receipt use** (`packages/host-sdk/src/host/acp-stdio-edge.ts`):
   the `host.sessions.createOrLoad` call result is now decoded against its
   protocol-owned response schema (`HostSessionsCreateOrLoadResponseSchema`) — the
   `acknowledgement` completion contract — instead of an unchecked `as` cast.

This realizes the finding's "viable now" half: *descriptor-owned receipt schemas fit
the current router mechanically; egress/call routes can carry a schema and dispatch
can decode the returned append/call receipt before returning to host edges.*

## What is STOP/reported (boundary-gated — NOT implemented)

**ACP terminal prompt-completion route metadata + receipt projection.** Declaring
`session.prompt`/prompt-like routes as `terminal` and having the ACP edge map a
returned `Done`/`Rejected` receipt to `PromptResponse` + `stopReason` **crosses the
channel/router architecture boundary on current `main`** and is deferred:

- `prompt()` dispatches `session.prompt` as a `send` (returns the input-intent
  append row, an acknowledgement). Terminal completion is produced *later* by
  output-stream observation of `TurnComplete` in `waitForTurnCompleteEffect`, mapped
  by the edge-local `acpStopReason` switch.
- To drive terminal completion from route metadata now, the edge would have to
  **synthesize a `Done` receipt after `TurnComplete`** and decode it through route
  metadata — *edge-local completion projection layered over the existing output
  plumbing*, exactly what the prior tf-r6br STOP/REDIRECT (2026-05-21) and the
  coordinator disposition rejected.
- That output observation still rides the **tf-7kq8 memoized-bridge scan**
  (`runtime-context.ts`, annotated `bridge_debt`, "to be replaced by
  DurableOutputCursor"). The durable workflow-owned output/result row that terminal
  completion must bind to is **tf-aseo** ("Implement production DurableOutputCursor
  output arm cutover"), which is **IN_PROGRESS / not merged**. Only the #612 storm
  hotfix landed; the cursor cutover the coordinator gated on is not in place.

**Remaining work (a follow-on, after tf-aseo lands):** declare the prompt-like
route `terminal` with `RouteCompletionReceipt` (or a durable terminal output/result
row schema), and project the durable terminal row → ACP `PromptResponse`/`stopReason`
through that receipt — replacing the edge-local `acpStopReason` switch. This binds
completion to workflow-owned output/result state, not to `session.prompt` dispatch.

## Verification

`turbo typecheck` (protocol+runtime+host-sdk) green; protocol router test (incl. 3
new completion tests) green; runtime `host-control-router` + host-sdk
`acp-stdio-edge` tests green (the edge test exercises the createOrLoad receipt
decode); `lint:dead` (knip) `current=0`; eslint clean; semgrep baseline `11=11`.
