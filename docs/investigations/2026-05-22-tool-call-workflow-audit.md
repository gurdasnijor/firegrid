# Tool-call workflow audit — de-workflowing the runtime tool-call boundary (2026-05-22)

**Bead:** `tf-phk7` (P1). **Prompted by:** `tf-7kq8` + the discovery that runtime tool calls are modeled as workflows.
**Status:** source-level semantic audit. **This is not a production patch** — it maps the surface, classifies each workflow, and names cutover candidates + STOP conditions with file:line evidence.

Builds on the Phase 0C migration map (`docs/investigations/2026-05-21-phase0c-migration-map.md`, S9/S10) and the `WORKFLOW_ADMISSION` rule (`features/firegrid/firegrid-workflow-driven-runtime.feature.yaml:168-173`, #611): a `Workflow.make` is legitimate only for an owned durable resource / long-running process; tool calls and waits are not workflow identities.

## The live tool-call path (two lowerings, one executor)

There is **one** tool-lowering switch — `RuntimeToolUseExecutor.execute` / `makeRuntimeAgentToolExecutionService` (`runtime-agent-tool-execution.ts:186-230`) — reached by **two** paths:

1. **Codec / agent-output path (NO per-call workflow).** The agent emits a `ToolUse` output event; the owning `RuntimeContextWorkflowNative` body lowers it through `runToolUseActivity` (`runtime-context.ts:438-448`, a memoized `Activity` calling `executor.execute({ contextId }, event)`), driven by the workflow's own `RunToolUse` event (`runtime-context.ts:378`). The result is appended back as a runtime input. This is already the "owning-workflow lowering" the target wants.

2. **MCP toolkit-handler path (per-call workflow).** An MCP `tools/call` HTTP request hits `FiregridAgentToolkitLayer`'s handler (`toolkit-layer.ts:142-180`) → `handleTool` (`:58-109`) → `ToolCallWorkflow.execute({ contextId, toolUseId, toolName, input })` (`:76`) run on the host-scoped engine via `RuntimeContextWorkflowRuntime.run({ workflowName: ToolCallWorkflow.name, … })` (`:90-98`). `ToolCallWorkflow`'s body (`runtime-tool-call-workflow.ts:10-27`) calls the **same** `executor.execute`.

**The asymmetry is the whole finding:** the codec path lowers tool calls with no per-call workflow identity; the MCP path spawns one (`ToolCallWorkflow`) per call. Both reach the identical executor. The per-call workflow is therefore not intrinsic to tool execution — it is the MCP handler's request/response wrapper.

## Workflow identities on the path — classification

| Identity | File:line | Role on tool path | Owns a durable resource? | Multi-event state machine? | Classification |
| --- | --- | --- | --- | --- | --- |
| `RuntimeContextWorkflowNative` | `runtime-context.ts:927` | owns the context; lowers `ToolUse` via `runToolUseActivity:438`; hosts `DurableClock`/`DurableDeferred` (`:3,203,211`) | **yes** (the context) | **yes** (merged event loop) | **TRUE durable workflow — KEEP** |
| `ToolCallWorkflow` | def `tool-call.ts:16`; body `runtime-tool-call-workflow.ts:10`; driver `toolkit-layer.ts:76` | one execution **per MCP tool call**, `idempotencyKey = toolUseId`, `success = ToolResultEvent` | **no** (no table/rows of its own) | **no** (request → `executor.execute` → response) | **ACCIDENTAL request/response mailbox — DELETE-AFTER** (= map S9) |
| `WaitForWorkflow` | def `wait-for.ts:46`; driver `runtime-agent-tool-execution.ts:198` | one execution **per `wait_for`**, nested inside `ToolCallWorkflow` | **no** | **no** (single `matchOrTimeoutActivity`, `wait-for.ts:73-115`) | **ACCIDENTAL single-activity wrapper — DELETE-AFTER** (= map S10) |
| `RuntimeContextProvision/Start/Lifecycle` | `runtime-control-request.ts:50/59/68` | control-plane, **not** the tool-call path | n/a | n/a | out of scope (STOP-AND-RE-EVALUATE, map S11) |

`RuntimeContextWorkflowRuntime` (the engine handle, `runtime-context-workflow-runtime.ts:46`) and the shared host-scoped `WorkflowEngine` are substrate — **KEEP**. The per-call workflow runs on that shared engine; only the *identity* is per-call.

## Per-tool durability — what actually needs durable suspension

`ToolCallWorkflow` wraps **every** tool, but the executor shows only a few tools suspend durably (`runtime-agent-tool-execution.ts`):

| Tool | Lowering | Durable suspension? |
| --- | --- | --- |
| `sleep` | `DurableClock.sleep` (`:188-196`) | **yes** |
| `schedule_me` | `DurableClock.sleep` + append (`:219-229`) | **yes** |
| `wait_for` | `WaitForWorkflow.execute` (`:197-208`) → `Stream.runHead` raced w/ timeout (`wait-for.ts:84-103`) | **yes** (blocks on external events) |
| `wait_for_any` | `Effect.raceAll` + `Effect.timeoutTo` (`:163-177`) | **no — in-memory race** (see gap below) |
| `send` | plain `append` Effect (`:210-214`) | no |
| `call` | plain `call` Effect (`:215-218`) | no |
| `execute`, `session_*` | `AgentToolHost` seams via `handleTool` | no (in the workflow body) |

Two consequences:

- For `send`/`call`/`execute`/`session_*` the `ToolCallWorkflow` wrapper adds **no durable value** — it is a pure request/response mailbox.
- For `sleep`/`schedule_me`/`wait_for` the durable suspension is real, but it is hostable by the **owning** `RuntimeContextWorkflowNative` (which already hosts `DurableClock`/`DurableDeferred` and already runs `runToolUseActivity`). A *per-call* workflow identity is not required by `WORKFLOW_ADMISSION` for any tool.

**Latent gap (independent of de-workflowing):** `wait_for_any` uses `Effect.raceAll` + `Effect.timeoutTo` (`:163-177`) — an **in-memory** race, not a durable primitive. A `wait_for_any` in flight does not survive host restart even today, inside the workflow. Worth a separate bead.

## De-workflowing target & cutover candidates

Target boundary (no per-call workflow identities):

```
MCP tools/call  ─┐
                 ├─> deliver RunToolUse to the OWNING RuntimeContextWorkflow
codec ToolUse  ──┘     └─> runToolUseActivity -> RuntimeToolUseExecutor.execute  (KEEP)
                            └─> sleep/schedule/wait lower to the owning workflow's
                                DurableClock / durable observation primitives
                       MCP handler awaits the ToolResult (durable deferred keyed by toolUseId)
```

- **DELETE-AFTER `ToolCallWorkflow`** (`tool-call.ts`, `runtime-tool-call-workflow.ts`, and its drive from `toolkit-layer.ts:76-98`). Replacement: the MCP handler delivers the tool invocation as a `RunToolUse` event/input to the owning `RuntimeContextWorkflowNative` (the codec path already does this, `runtime-context.ts:378,438`) and awaits the resulting `ToolResult` via a durable deferred keyed by `toolUseId`. The executor (`RuntimeToolUseExecutor` / `makeRuntimeAgentToolExecutionService`) is **KEPT** — it is the legitimate per-tool lowering, just invoked from the owning workflow rather than a per-call workflow.
- **DELETE-AFTER `WaitForWorkflow`** (`wait-for.ts`). Replacement: lower `wait_for` to a durable observation/wait primitive owned by the owning workflow (the `matchOrTimeoutActivity` body is already replay-memoized; preserve that). `PHASE_6_AGENT_TOOLS.10-1` requires `wait_for` to lower through the owning workflow's observation surface, not a standalone workflow.

## STOP conditions (do not delete before these hold)

1. **Owning-workflow tool-input seam exists.** The MCP handler must be able to deliver a tool invocation as a `RunToolUse` input to the owning `RuntimeContextWorkflowNative` and receive its `ToolResult`. This is the Phase 0C input-delivery seam (map F1 workflow-owned input table, F3 `engine.signal`/table-write wakeup). Until then the MCP path has no non-workflow way to reach the owning workflow. **Gate.**
2. **At-most-once tool execution preserved.** `ToolCallWorkflow`'s `idempotencyKey = toolUseId` (`tool-call.ts:20`) dedups retried calls. The replacement must preserve at-most-once via the owning workflow's input identity or a durable idempotency record — not silently drop it.
3. **Durable suspension preserved for `sleep`/`schedule_me`/`wait_for`.** These must keep surviving host restart after the wrapper is removed; they can only move once they run inside the owning workflow's durable context.
4. **`wait_for` replay-memoization preserved.** Today the wait result is journaled (the `matchOrTimeoutActivity` is an `Activity`, `wait-for.ts:79`). Collapsing must keep the wait from re-running on owning-workflow replay (the `tf-7kq8` class).
5. **Control-request workflows are out of scope.** `runtime-control-request.ts:50/59/68` is the HostKernelWorkflow control-plane track (map S11/F4) — a separate SDD, not this audit.

## Static guardrail (no production behavior change)

The `Workflow.make` inventory already exists (#611: `tooling/ast-grep/rules/workflow-make-inventory.yml` + `.semgrep.yml`), and `WORKFLOW_ADMISSION` already fails new unclassified `Workflow.make` sites. No new exporter/guard is needed for this audit. Recommended (cheap, additive): record `ToolCallWorkflow` and `WaitForWorkflow` as **classified migration-debt** inventory entries that link to their deletion beads, so the guard's note points at the cutover work rather than just flagging the sites. This is a doc/tooling note, not a behavior change; deferred to a bead rather than done here to keep this audit read-only.

## Recommended beads

1. **`tf-vfq9` (P1, blocked) Cutover: route MCP tool calls into the owning RuntimeContextWorkflow; delete `ToolCallWorkflow`.** Deliver `RunToolUse` to the owning workflow + await `ToolResult` (durable deferred keyed by `toolUseId`); keep `RuntimeToolUseExecutor`. Blocked on the Phase 0C tool-input/result seam (`tf-b1jm` F1/F3) and STOP conditions 2–4.
2. **`tf-hpr0` (P1, blocked) Collapse `WaitForWorkflow` into the owning-workflow durable observation/wait primitive.** Preserve replay memoization + timeout (`PHASE_6_AGENT_TOOLS.10-1`). Blocked on / after `tf-vfq9`.
3. **`tf-0xe4` (P2) `wait_for_any` durability gap.** `Effect.raceAll` + `Effect.timeoutTo` (`runtime-agent-tool-execution.ts:163-177`) is in-memory; a `wait_for_any` in flight is lost on host restart. Design a durable race over the owning workflow's observation primitives.
4. **`tf-8lte` (P3) Inventory note linkage.** Tag the `Workflow.make` inventory entries for `ToolCallWorkflow`/`WaitForWorkflow` with their deletion beads (`tf-vfq9`/`tf-hpr0`).

## Sources

Source-verified against this branch (fresh off `origin/main`):
`packages/runtime/src/workflow-engine/workflows/tool-call.ts`, `.../wait-for.ts`, `.../runtime-context.ts`, `.../runtime-control-request.ts`, `packages/runtime/src/agent-event-pipeline/tool-execution/runtime-tool-call-workflow.ts`, `.../runtime-agent-tool-execution.ts`, `packages/runtime/src/workflow-engine/tool-execution/runtime-tool-use-executor.ts`, `packages/runtime/src/kernel/runtime-context-workflow-runtime.ts`, `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts`; `docs/investigations/2026-05-21-phase0c-migration-map.md` (S9/S10/S11, F1/F3); `features/firegrid/firegrid-workflow-driven-runtime.feature.yaml` (`WORKFLOW_ADMISSION`, `PHASE_6_AGENT_TOOLS`).
