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
- Rebaseline the checklist against the landed target tree before adding final
  tests. The most important files to inspect next are
  `packages/runtime/src/authorities/registry.ts`,
  `packages/runtime/src/pipeline/codec-runtime.ts`,
  `packages/runtime/src/subscribers/tool-router.ts`, and the renamed codec and
  host tests.

## ACID Checklist

| ACID | Requirement | Code proof needed | Likely test location |
| --- | --- | --- | --- |
| `firegrid-runtime-agent-event-pipeline.VALIDATION.1` | The cutover proves existing raw local-process runtime behavior still journals stdout and stderr correctly. | Existing raw process regression should stay green after target-tree move. | Current: `packages/runtime/src/runtime-host/start-runtime.test.ts`; target: `packages/runtime/src/host/start-runtime.test.ts` or `packages/runtime/src/pipeline/runtime-execution.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.VALIDATION.2` | The cutover proves stdio-jsonl codec runtime execution advertises client_result_roundtrip and still handles Prompt, ToolUse, ToolResult, and Terminated events. | Add `toolUseMode === "client_result_roundtrip"` proof once the codec contract lands; preserve prompt/tool/termination tests. | Current: `packages/runtime/src/agent-codecs/stdio-jsonl/index.test.ts`; target: `packages/runtime/src/codecs/stdio-jsonl/index.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.STAGES.3-7` | The codec contract exposes a toolUseMode capability flag used by the tool router subscription gate. | Contract/schema/unit test for the mode field and router gate consumption. | Target: `packages/runtime/src/events/contract.test.ts` or `packages/runtime/src/codecs/runtime.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.STAGES.3-8` | Active codec sessions report a per-session toolUseMode after protocol negotiation or fixed construction; runtime does not infer the mode from codec class and the tool router gates only client_result_roundtrip sessions. | Session-level mode fixture, not static codec-kind switch. | Target: `packages/runtime/src/codecs/runtime.test.ts` plus `packages/runtime/src/subscribers/tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.STAGES.3-9` | The SDD classifies agent wire modes as observation_only, client_result_roundtrip, and control_channel_request_response; control-channel request/response is not subscriber-produced ToolResult ingress. | Exact mode-name test or type-level assertion, plus router exclusion test. | Target: `packages/runtime/src/events/contract.test.ts` and `packages/runtime/src/subscribers/tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.1` | ToolUse dispatch is driven from durable RuntimeOutput ToolUse observations rather than inline taps on the live codec output stream. | Required durable replay/reconstruction test. | Target: `packages/runtime/src/subscribers/tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.2` | The tool router deduplicates dispatch by durable tool-use identity and does not append duplicate ToolResult rows for already-completed tool uses. | Seed duplicate committed `ToolUse` rows or completed result evidence; assert one `ToolResult` ingress. | Target: `packages/runtime/src/subscribers/tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.3` | ToolResult ingress rows produced by tool dispatch use deterministic idempotency keys of shape agent-tool-result:<contextId>:<activityAttempt>:<toolUseId>. | Assert appended ingress idempotency key exactly. | Target: `packages/runtime/src/subscribers/tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.4` | Tool dispatch writes explicit result, interruption, or error evidence for each dispatched ToolUse. | Success/error/interruption branches produce durable evidence. | Target: `packages/runtime/src/subscribers/tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.5` | Tool dispatch is single-flight per contextId and activityAttempt in v1. | Concurrent subscriber startup/reconstruction produces one dispatch. | Target: `packages/runtime/src/subscribers/tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.5-1` | The tool router watches only the current running activityAttempt for a context and does not redispatch ToolUse rows from prior terminal attempts. | Seed prior terminal attempt plus current attempt; assert only current attempt dispatches. | Target: `packages/runtime/src/subscribers/tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.6` | The v1 transactional cutover implements subscriber-based ToolUse to ToolResult round-trip for active stdio-jsonl sessions whose per-session toolUseMode is client_result_roundtrip. | End-to-end stdio-jsonl round trip through subscriber, not inline tap. | Target: `packages/runtime/src/pipeline/stdio-jsonl-tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.7` | ACP sessionUpdate.tool_call and tool_call_update rows are durable observations, not dispatch candidates, and the tool router must not claim them. | ACP journaling plus router non-claim assertion. | Target: `packages/runtime/src/pipeline/acp-observation.test.ts` and `packages/runtime/src/subscribers/tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.8` | ToolUse rows are decoded through a protocol/runtime event-output envelope helper shared by RuntimeOutputJournal and subscribers; subscribers do not parse RuntimeEventRow.raw ad hoc. | Unit test shared helper; review grep for no subscriber-local raw parsing. | Target: `packages/runtime/src/events/runtime-output-envelope.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.9` | ACP MCP delegation and ACP Client capability methods are request/response control-channel paths; additional filesystem or terminal handlers require separate SDD/spec ACIDs for authority, journaling, idempotency, and sandbox policy. | Router exclusion for control-channel modes; no `ToolResult` injection for ACP client capabilities. | Target: `packages/runtime/src/subscribers/tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.INGREDIENTS.4` | RuntimeOutput PermissionRequest observations remain durable observations that are resumed by PermissionResponse ingress rows. | Keep ACP permission journaling/resume proof. | Current: `packages/runtime/src/runtime-host/runtime-codec-event-plane.test.ts`; target: `packages/runtime/src/pipeline/acp-permission.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.INGREDIENTS.4-1` | Permission waits observe RuntimeOutputJournal source-collection handles through wait_for or session.wait APIs rather than subscribing to codec internals. | `wait_for` resolves from decoded output-journal source. | Current: `packages/runtime/src/runtime-host/runtime-observation-sources.test.ts`; target: `packages/runtime/src/authorities/runtime-output-journal.test.ts` or `packages/runtime/src/subscribers/permission-wait.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.INGREDIENTS.4-2` | PermissionResponse rows are appended only through RuntimeIngressAppender and delivered to the active codec by the ingress-delivery subscriber. | Assert authority append path and delivery evidence. | Target: `packages/runtime/src/authorities/runtime-ingress-appender.test.ts` and `packages/runtime/src/subscribers/ingress-delivery.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.INGREDIENTS.4-3` | AcpCodec resolves pending ACP requestPermission promises from delivered PermissionResponse rows without making the tool router responsible for permission flow. | ACP live-session promise resolution test remains codec/ingress-owned. | Current: `packages/runtime/src/agent-codecs/acp/index.test.ts`; target: `packages/runtime/src/codecs/acp/index.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.INGREDIENTS.4-4` | The permission-wait bridge is the v1 instance of the general control_channel_request_response capability bridge pattern. | Permission bridge test should use the same observation/wait/append/deliver substrate as other control-channel modes. | Target: `packages/runtime/src/subscribers/permission-wait.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.INGREDIENTS.4-5` | Capability bridges compose only when they fit the substrate guarantee of RuntimeOutputJournal observation, DurableWaitStore wait, RuntimeIngressAppender evidence append, and ingress delivery to the active codec; other shapes require a new SDD. | Negative coverage for non-fitting ACP client capabilities, or review assertion if no such handlers are present. | Target: `packages/runtime/src/subscribers/tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.INGREDIENTS.6` | RuntimeOutputJournal commits the Terminated event row before returning terminal exit evidence to host workflow handling. | Journal-first terminal test. | Target: `packages/runtime/src/authorities/runtime-output-journal.test.ts` or `packages/runtime/src/host/workflow-handler.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.VALIDATION.3` | The cutover proves ACP PermissionRequest remains durably observable and resumable through RuntimeIngress PermissionResponse. | End-to-end ACP permission runtime test. | Current: `packages/runtime/src/runtime-host/runtime-codec-event-plane.test.ts`; target: `packages/runtime/src/pipeline/acp-permission.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.VALIDATION.3-1` | The cutover proves a wait_for or session.wait permission query resolves from RuntimeOutputJournal's decoded source-collection surface after a PermissionRequest row commits. | Existing wait_for observation source test should be moved to authority/source surface. | Current: `packages/runtime/src/runtime-host/runtime-observation-sources.test.ts`; target: `packages/runtime/src/authorities/runtime-output-journal.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.VALIDATION.3-2` | The cutover proves PermissionResponse ingress delivery resolves the pending ACP requestPermission promise for a live session. | Live ACP session with delivered `PermissionResponse`. | Current: `packages/runtime/src/runtime-host/runtime-codec-event-plane.test.ts`; target: `packages/runtime/src/subscribers/ingress-delivery.test.ts` plus `packages/runtime/src/codecs/acp/index.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.VALIDATION.4` | The cutover proves duplicate startRuntime calls do not duplicate external runtime execution. | Existing duplicate-start proof should remain. | Current: `packages/runtime/src/runtime-host/start-runtime.test.ts`; target: `packages/runtime/src/host/start-runtime.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.VALIDATION.5` | A test named firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.1 firegrid-runtime-agent-event-pipeline.VALIDATION.5 proves durable subscriber tool dispatch replays from committed RuntimeOutput ToolUse rows after restart or reconstruction. | Add exact-name test after subscriber/router lands. | Target: `packages/runtime/src/subscribers/tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.VALIDATION.6` | The cutover proves ACP tool_call and tool_call_update observations are journaled and not claimed by the tool router, while ACP PermissionRequest remains durably observable and resumable. | Combined ACP observation/router/permission regression. | Target: `packages/runtime/src/pipeline/acp-observation.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.VALIDATION.7` | The cutover proves control_channel_request_response modes are not routed through subscriber-produced ToolResult ingress. | Router mode gate negative test. | Target: `packages/runtime/src/subscribers/tool-dispatch.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.ENFORCEMENT.1` | A canonical authority registry maps each runtime-written DurableTable collection family to its owning authority module. | Registry unit test and PR description table. | Target: `packages/runtime/src/authorities/registry.test.ts`. |
| `firegrid-runtime-agent-event-pipeline.ENFORCEMENT.2` | Semgrep rejects direct insert, upsert, and delete calls against runtime-owned DurableTable collection facades outside the owning authority module and tests. | New scoped semgrep rule plus fixture. | `.semgrep.yml` and `semgrep-tests/dup-detection.ts` or a dedicated fixture. |
| `firegrid-runtime-agent-event-pipeline.ENFORCEMENT.2-1` | Semgrep allows calls to authority module methods and explicit test harness allowlist entries. | Positive fixture coverage for authority APIs and test allowlist. | `.semgrep.yml` and semgrep fixture. |
| `firegrid-runtime-agent-event-pipeline.ENFORCEMENT.3` | Subscribers consume durable seams through SourceCollections handles exposed by authority modules rather than directly calling DurableTable.rows on runtime-owned tables. | Subscriber tests plus semgrep/review grep for direct `rows()` calls. | Target: subscriber tests and optional semgrep rule. |
| `firegrid-runtime-agent-event-pipeline.TRANSACTIONAL_CUTOVER.4` | The implementing PR description presents the target tree and ACID list as the review artifact. | PR description checklist item. | PR description, optionally `packages/runtime/src/pipeline/README.md`. |
| `firegrid-runtime-agent-event-pipeline.TRANSACTIONAL_CUTOVER.5` | The implementing PR description lists the SourceCollectionHandle read surfaces exposed by each authority. | PR description checklist item. | PR description and `packages/runtime/src/authorities/registry.ts`. |

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

1. `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.1` and
   `firegrid-runtime-agent-event-pipeline.VALIDATION.5` are currently
   untestable on this checkout because tool dispatch is still inline from live
   codec output.
2. `firegrid-runtime-agent-event-pipeline.VALIDATION.2`,
   `firegrid-runtime-agent-event-pipeline.STAGES.3-7`, and
   `firegrid-runtime-agent-event-pipeline.STAGES.3-8` need the `toolUseMode`
   contract/session patch before final proof.
3. Semgrep enforcement should wait until authority file paths are stable, then
   land as a scoped `.insert`/`.upsert`/`.delete` rule with explicit authority
   and test allowlists.
4. Existing tests already provide useful migration anchors for raw journaling,
   stdio-jsonl prompt/tool/termination behavior, ACP permission resume, decoded
   permission observation via `wait_for`, and duplicate `startRuntime` starts.
