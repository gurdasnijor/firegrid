# tiny-firegrid Public Surface Migration Notes

Date: 2026-05-18

Scope:

- `durable-streams-backed-pipeline.test.ts`
- `stdio-jsonl-tool-execution-pipeline.test.ts`
- `multi-context-production-consuming-pipeline.test.ts`
- `output-journal-pipeline.test.ts`

## Reach-Pasts Removed Cleanly

- Host-bound context construction was removed. The test now calls `sessions.createOrLoad`, which records the durable runtime context request that the production host reconciler consumes.
- Manual host reconciliation was removed. The production `tinyDurableStreamsBackedPipeline` host runs with its default reconciler daemon and materializes client-authored requests.
- Direct runtime start capability access was removed. The test now calls `session.start()` and observes terminal run state through `session.snapshot()`.
- Manual per-context output layer construction was removed. Output assertions use `session.wait.forAgentOutput()` and `session.snapshot()`, which resolve the context/output stream through the client surface.
- Snapshot polling was removed from wait paths. Context materialization and terminal run waits now subscribe to `FiregridRuntimeTables.ControlPlane` rows and filter the live stream.
- The stdio-jsonl tool-execution test no longer extracts host context, constructs a host-bound `RuntimeContext`, writes `contexts.upsert`, calls `RuntimeStartCapability.start`, opens `RuntimeOutputTable`, or decodes runtime output rows directly. It now drives create/start/prompt through the session facade and observes the tool loop through `session.wait.forAgentOutput`.
- The multi-context production-consuming test uses two distinct `sessions.createOrLoad` external keys, two `session.start()` calls, interleaved `session.prompt()` calls, live `FiregridRuntimeTables.ControlPlane` waits, and per-session `session.wait.forAgentOutput()`. No host context extraction or host-bound row construction was needed to prove registry/dispatcher demux and output isolation.
- The output-journal test no longer constructs a host-bound `RuntimeContext`, writes `contexts.upsert`, calls `RuntimeStartCapability.start`, reads the host-ambient `RuntimeOutputTable`, composes a per-context output table, or casts snapshot output rows. It now drives create/start/prompt through the session facade and proves `AgentOutputAfter` behavior through repeated `session.wait.forAgentOutput({ afterSequence })` calls.

## Reach-Pasts Not Removable / Public Gaps

- None blocking for `durable-streams-backed-pipeline`.
- The old test asserted a direct host-internal replay result from `RuntimeStartCapability.start`. The consumer surface does not expose that synchronous host result. The migrated test asserts the same restart property through durable client-visible state instead: `session.start()` is idempotent after restart and the completed snapshot contains no duplicate outputs.
- The test composes `FiregridRuntimeTables.ControlPlane` from the client SDK, but still imports `runtimeControlPlaneStreamUrl` from `@firegrid/protocol/launch` to build the table layer. This is public and not host-bound, but it is a candidate for a client SDK re-export so consumer-shaped tests do not need to import protocol URL helpers directly.
- Codex ACP migration is paused on TFIND-048. Its runtime intent needs a route-scoped MCP URL before `sessions.createOrLoad`, but the context-id / MCP-route URL lifecycle is still an architectural framing issue. Migrating Codex without a new reach-past is blocked until that lifecycle is decided and exposed through the public surface.

## Repeating Code Patterns

- Live durable-table waits repeat the same shape: filter `rows()`, `Stream.runHead`, and race a timeout. This is the Effect equivalent of Flamecast's `useDurableTable(FiregridRuntimeTables.ControlPlane)` plus live query pattern.
- Session-output waits repeat the `waitForAgentOutputMatching` shape listed below.
- Multi-context public-surface assertions repeat pairwise scenario setup: create two sessions, start both, subscribe to both context/run rows, interleave prompts, then assert per-session snapshots.
- Output-journal assertions repeat a stricter session-output wait shape: wait for the first output, then use each returned `sequence` as the next `afterSequence` cursor to prove ordered journal advancement.
- Production-consuming tests repeatedly launch a host layer in a scoped background fiber while driving the scenario through a separate client SDK surface.

## Layer / Scoped Infrastructure Primitive Candidates

- `firstWithinOrFail`: a generic stream-first-emission-with-timeout helper for public table subscriptions.
- `waitForAgentOutputMatching`: a session-scoped typed observation helper built on `session.wait.forAgentOutput` and `afterSequence`.
- Per-scenario control-plane layer scope: one public `FiregridRuntimeTables.ControlPlane` materialization should be shared by all waits in a scenario.
- A tiny test harness could launch a production host layer in the background while exposing only the client SDK to scenario code.
