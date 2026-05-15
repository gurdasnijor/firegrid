# Runtime Agent Event Pipeline Validation Support Review

Date: 2026-05-15

Scope: validation support for `firegrid-runtime-agent-event-pipeline` after
`4481a0e66` / PR #245 base. This note is read-only analysis for the codebase
state before CA/CA2/CA3 target-tree patches land.

## Read First Inputs

- `docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md`, especially Review
  Guidance and validation sections.
- `features/firegrid/firegrid-runtime-agent-event-pipeline.feature.yaml`,
  especially `VALIDATION.*`, `ENFORCEMENT.*`, `TOOL_DISPATCH.*`, and
  `INGREDIENTS.4-*`.
- `docs/reviews/REVIEW_FIREGRID_CODEBASE_INVENTORY_RUNTIME_AGENT_PIPELINE_2026-05-15.md`,
  especially the implementation risk register and first PR review checklist.
- `repos/effect/AGENTS.md` before any Effect test edits.

## Current State

- Branch observed: `coding/runtime-authorities-source-surfaces`.
- Initial read-only snapshot found the pre-cutover layout still active and
  `ToolUse -> ToolResult` handling inline from live codec output.
- A concurrent target-tree patch appeared in the shared worktree after the
  initial snapshot. New paths now include `packages/runtime/src/authorities/`,
  `packages/runtime/src/pipeline/`, `packages/runtime/src/subscribers/`,
  `packages/runtime/src/codecs/`, `packages/runtime/src/events/`,
  `packages/runtime/src/host/`, `packages/runtime/src/sources/`, and
  `packages/runtime/src/waits/`.
- Validation lane note: SDD/spec now explicitly separates pipeline sources,
  authority write/Sink ownership, and authority read/observation
  `SourceCollectionHandle` surfaces. Keep semgrep enforcement behind stable
  authority paths in the implementation PR; docs/spec checks are reported
  passing in the lane.
- PR #248 merged to `main` at `2c9a15bc9`; treat `toolUseMode` and shared
  runtime output envelope support as landed baseline for the main cutover.
- Rebaseline the checklist against the landed target tree before adding final
  tests. The most important files to inspect next are
  `packages/runtime/src/authorities/registry.ts`,
  `packages/runtime/src/pipeline/codec-runtime.ts`,
  `packages/runtime/src/subscribers/tool-router.ts`, and the renamed codec and
  host tests.

## Readiness Checklist

Classification:

- `Current gate`: must have code proof before the implementation PR is ready.
- `Review checklist`: must be explicitly reviewed or listed in the PR, but is
  not a standalone gate when covered by a current gate.
- `Follow-up`: do not add to this PR unless already in scope; track only if it
  remains after the implementation PR.

| Classification | Finding | ACIDs | Required proof or review action |
| --- | --- | --- | --- |
| Current gate | Durable `ToolUse` replay from committed output rows. | `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.1`, `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.2`, `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.3`, `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.4`, `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.5`, `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.5-1`, `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.6`, `firegrid-runtime-agent-event-pipeline.VALIDATION.5` | Add the exact-name replay/reconstruction test in `packages/runtime/src/subscribers/tool-dispatch.test.ts`. It should seed or retain committed `RuntimeOutput` `ToolUse` rows, reconstruct the subscriber/router, assert dispatch comes from the durable observation, assert one deterministic `agent-tool-result:<contextId>:<activityAttempt>:<toolUseId>` ingress result, and assert prior terminal attempts are not redispatched. |
| Current gate | ACP observation-only gating for `tool_call` and `tool_call_update`. | `firegrid-runtime-agent-event-pipeline.STAGES.3-8`, `firegrid-runtime-agent-event-pipeline.STAGES.3-9`, `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.7`, `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.9`, `firegrid-runtime-agent-event-pipeline.VALIDATION.6`, `firegrid-runtime-agent-event-pipeline.VALIDATION.7` | Prove ACP `sessionUpdate.tool_call` and `tool_call_update` rows are journaled as observations and not claimed by the tool router. Router gating must read the active session `toolUseMode`, not infer from codec class or protocol string. `control_channel_request_response` must not append subscriber-produced `ToolResult` ingress. |
| Current gate | Terminal row-before-lifecycle evidence. | `firegrid-runtime-agent-event-pipeline.INGREDIENTS.2`, `firegrid-runtime-agent-event-pipeline.INGREDIENTS.6` | Add or preserve a journal-first terminal test: the `RuntimeOutput` `Terminated` row is committed before host workflow handling records exited/failed lifecycle evidence. Likely home: `packages/runtime/src/authorities/runtime-output-journal.test.ts` or host workflow handler tests. |
| Current gate | Permission wait/resume remains durable and separate from tool routing. | `firegrid-runtime-agent-event-pipeline.INGREDIENTS.4`, `firegrid-runtime-agent-event-pipeline.INGREDIENTS.4-1`, `firegrid-runtime-agent-event-pipeline.INGREDIENTS.4-2`, `firegrid-runtime-agent-event-pipeline.INGREDIENTS.4-3`, `firegrid-runtime-agent-event-pipeline.INGREDIENTS.4-4`, `firegrid-runtime-agent-event-pipeline.INGREDIENTS.4-5`, `firegrid-runtime-agent-event-pipeline.VALIDATION.3`, `firegrid-runtime-agent-event-pipeline.VALIDATION.3-1`, `firegrid-runtime-agent-event-pipeline.VALIDATION.3-2` | Prove `PermissionRequest` commits to `RuntimeOutputJournal`, `wait_for` or `session.wait` resolves from the decoded source-collection handle, `PermissionResponse` appends through `RuntimeIngressAppender`, ingress delivery sends it to the live ACP codec, and the pending ACP request resolves without tool-router involvement. |
| Current gate | Ingress delivery dedupe for raw and codec subscribers. | `firegrid-runtime-agent-event-pipeline.AUTHORITIES.4`, `firegrid-runtime-agent-event-pipeline.AUTHORITIES.4-1`, `firegrid-runtime-agent-event-pipeline.AUTHORITIES.4-2`, `firegrid-runtime-agent-event-pipeline.INGREDIENTS.1`, `firegrid-runtime-agent-event-pipeline.INGREDIENTS.4-2` | Preserve claim-before-send semantics with delivery key `(subscriberId, inputId)`. Test raw stdin and codec delivery subscribers independently, with subscriber ids shaped `runtime-ingress:<protocol>:<role>`. |
| Current gate | Authority write/read surface enforcement timing. | `firegrid-runtime-agent-event-pipeline.AUTHORITIES.1`, `firegrid-runtime-agent-event-pipeline.AUTHORITIES.2`, `firegrid-runtime-agent-event-pipeline.AUTHORITIES.3`, `firegrid-runtime-agent-event-pipeline.AUTHORITIES.4`, `firegrid-runtime-agent-event-pipeline.AUTHORITIES.5`, `firegrid-runtime-agent-event-pipeline.AUTHORITIES.5-1`, `firegrid-runtime-agent-event-pipeline.AUTHORITIES.6`, `firegrid-runtime-agent-event-pipeline.AUTHORITIES.8`, `firegrid-runtime-agent-event-pipeline.ENFORCEMENT.1`, `firegrid-runtime-agent-event-pipeline.ENFORCEMENT.2`, `firegrid-runtime-agent-event-pipeline.ENFORCEMENT.2-1`, `firegrid-runtime-agent-event-pipeline.ENFORCEMENT.3` | Before PR completion, confirm authority paths and registry are stable, then add the scoped semgrep rule. The rule should reject direct `.insert`, `.upsert`, and `.delete` against runtime-owned DurableTable facades outside owning authorities/tests, while allowing authority APIs and explicit test harnesses. Also confirm subscribers consume authority-exposed `SourceCollectionHandle` surfaces rather than direct runtime table `rows()` calls. Known residual: `packages/protocol/src/launch/host-context-authority.ts` exposes `insertLocalRuntimeContext`, which upserts `RuntimeControlPlaneTable.contexts`; shared cutover callers include `src/run.ts` and `packages/client/src/firegrid.ts`. Migrate that write path to `RuntimeControlPlaneRecorder` or add an explicit SDD carve-out/deletion ACID before final acceptance. |
| Review checklist | Existing raw local-process behavior is preserved. | `firegrid-runtime-agent-event-pipeline.VALIDATION.1` | Keep the raw stdout/stderr journaling regression green after the target-tree move. Likely home: `packages/runtime/src/host/start-runtime.test.ts` or `packages/runtime/src/pipeline/runtime-execution.test.ts`. |
| Review checklist | Stdio-jsonl advertises and exercises `client_result_roundtrip`. | `firegrid-runtime-agent-event-pipeline.STAGES.3-7`, `firegrid-runtime-agent-event-pipeline.STAGES.3-8`, `firegrid-runtime-agent-event-pipeline.VALIDATION.2` | Landed baseline via #248; keep codec/session tests green and continue covering `Prompt`, `ToolUse`, `ToolResult`, and `Terminated`. |
| Review checklist | Shared runtime output envelope helper is used by journal and subscribers. | `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.8` | Landed baseline via #248; review that journal and subscribers keep using the shared helper and do not reintroduce ad hoc `RuntimeEventRow.raw` parsing. |
| Review checklist | Duplicate `startRuntime` still does not duplicate external execution. | `firegrid-runtime-agent-event-pipeline.VALIDATION.4` | Keep the existing duplicate-start regression green after host/pipeline extraction. |
| Review checklist | PR description is review-ready. | `firegrid-runtime-agent-event-pipeline.TRANSACTIONAL_CUTOVER.4`, `firegrid-runtime-agent-event-pipeline.TRANSACTIONAL_CUTOVER.5` | PR body must include target tree, satisfied ACID list, authority registry table, `SourceCollectionHandle` read surfaces, validation commands, exact mode-name consistency, and compatibility export/deletion status. |
| Follow-up | Compatibility export cleanup. | `firegrid-runtime-agent-event-pipeline.TRANSACTIONAL_CUTOVER.3`, `firegrid-runtime-agent-event-pipeline.TRANSACTIONAL_CUTOVER.3-1` | If old package subpaths or compatibility barrels remain, either remove them in the implementation PR or add a deletion ACID. Do not broaden the validation lane to solve unrelated app import cleanup. |
| Follow-up | Language-model projection rebuild over codec sessions. | `firegrid-runtime-agent-event-pipeline.STAGES.5` | Keep ACP adapter turn-locking, cancellation, and aggregation semantics if moved to `projections/language-model`. Do not let this block the current validation gates unless the implementation PR touches projections. |
| Follow-up | Resource-plane or ACP filesystem/terminal capability handling. | `firegrid-runtime-agent-event-pipeline.BOUNDARIES.6`, `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.9` | Out of scope for this PR. Additional capability handlers require separate SDD/spec ACIDs for authority, journaling, idempotency, and sandbox policy. |

## Required Exact Test Name

Use this exact test name after the durable tool-dispatch subscriber exists:

```txt
firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.1 firegrid-runtime-agent-event-pipeline.VALIDATION.5
```

The test should seed or retain committed `RuntimeOutput` `ToolUse` rows,
construct/reconstruct the subscriber, and assert the router dispatches from the
durable observation rather than from a live codec output tap.

## Semgrep Support Plan

Add the runtime authority write rule only after authority module paths are
stable. The rule should reject direct `.insert`, `.upsert`, and `.delete` calls
on runtime-owned DurableTable collection facades for:

- `RuntimeOutputTable.events`
- `RuntimeOutputTable.logs`
- `RuntimeIngressTable.inputs`
- `RuntimeIngressTable.deliveries`
- `RuntimeControlPlaneTable.contexts`
- `RuntimeControlPlaneTable.runs`
- durable wait rows and completions

Treat `packages/protocol/src/launch/host-context-authority.ts`
`insertLocalRuntimeContext` as the known residual write-capable API for
`RuntimeControlPlaneTable.contexts`; it needs migration to
`RuntimeControlPlaneRecorder` or an explicit SDD carve-out/deletion ACID before
final acceptance.

Expected allowlist:

- owning authority modules under `packages/runtime/src/authorities/**`;
- explicit tests under `packages/runtime/src/**/*.test.ts`;
- semgrep fixture files;
- calls to authority APIs such as `RuntimeIngressAppender.append(...)` and
  `RuntimeOutputJournal.writeEvent(...)`.

## PR Description Checklist

The implementation PR should include:

- full target tree;
- every satisfied `firegrid-runtime-agent-event-pipeline` ACID;
- authority registry table;
- `SourceCollectionHandle` read surfaces exposed by each authority;
- validation commands;
- exact mode-name consistency for `observation_only`,
  `client_result_roundtrip`, and `control_channel_request_response`;
- confirmation that no temporary compatibility export bridge remains, or the
  deletion ACID that gates completion.

## Coordinator Findings

1. Remaining current gates are durable `ToolUse` replay, journal-first terminal
   ordering, ACP observation-only not claimed, permission resume, ingress
   delivery dedupe, and authority write/read enforcement.
2. `toolUseMode` and shared runtime output envelope support are landed baseline
   after #248; keep them as review checks, not active scope expansion.
3. Semgrep enforcement should wait until authority file paths are stable, then
   land as a scoped `.insert`/`.upsert`/`.delete` rule with explicit authority
   and test allowlists. Include the residual protocol
   `insertLocalRuntimeContext` control-plane write in the acceptance decision.
4. Existing tests already provide useful migration anchors for raw journaling,
   stdio-jsonl prompt/tool/termination behavior, ACP permission resume, decoded
   permission observation via `wait_for`, and duplicate `startRuntime` starts.
