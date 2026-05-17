# Output-Path Runtime Substrate Spike

Date: 2026-05-16
Base inspected: `origin/main` / `main` at `aff581176`
Lane: Firegrid Lane C, read-only research converted to docs artifact

## Executive Verdict

**Converged model: Model C, Hybrid.**

Single-writer-per-context is not structurally available in the current runtime.
Runtime output rows, runtime run rows, ingress delivery rows, and workflow
engine rows are written by the host process that owns the context or by
host-local workflow/durable-tool fibers. Ingress input rows are different:
current production APIs deliberately allow a non-owning host/client process to
resolve the target context through the namespace control plane and write to the
owner host's ingress table.

The decisive path is `appendRuntimeIngress` resolving `RuntimeContext.host` and
opening the owner host's ingress stream from any caller host:
`packages/runtime/src/host/commands.ts:114`,
`packages/runtime/src/host/commands.ts:140`. The behavior is not accidental;
tests prove host B appending into host A ingress for prompts, scheduled prompts,
and `session_prompt`: `packages/runtime/test/host/prompt-routing.test.ts:120`,
`packages/runtime/test/host/prompt-routing.test.ts:166`,
`packages/runtime/test/host/prompt-routing.test.ts:217`.

Therefore:

- **Model A: Local cleanup** is too small. It can reduce tag/layer repetition,
  but it would leave cross-host command semantics hidden as direct table writes.
- **Model B: Context event log** is too broad right now. It fails the writer
  identity gate unless ingress is first inverted through a command stream or
  host RPC, and it fails the control-plane gate because context lookup is a
  namespace-scoped registry.
- **Model C: Hybrid** is the only model supported by current evidence:
  context-owned runtime history can move toward a per-context or owner-host log,
  while namespace control-plane context registry, external ingress commands,
  workflow durability, and durable wait infrastructure remain separate.

No direct Host SDK PR 1 blocker was found. The Host SDK seam can proceed as
long as the public SDK does not freeze direct runtime table append as the
long-term cross-host ingress abstraction. Host SDK and client SDK should remain
sibling projections over protocol, and runtime must not import host-sdk,
client-sdk, or CLI.

## Required Checkpoint

### Q1.1 Durable Write-Site Table

| Write site | Current table/collection | Row family | Context id source | Running process | Owning host source | Match? | Invertible? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `packages/runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts:43` | `RuntimeOutputTable.events` | output events | `RuntimeEventRow.contextId` | runtime activity / codec output loop | `startRuntime` gates local context before workflow execution at `packages/runtime/src/host/commands.ts:71` and `packages/runtime/src/host/internal/runtime-context-helpers.ts:57` | yes | n/a | Raw process writes through `RuntimeEventAppendAndGet` at `packages/runtime/src/host/raw-process-runtime.ts:147`; codec writes through `RuntimeAgentOutputRowSink` at `packages/runtime/src/agent-event-pipeline/session-runtime.ts:120`. |
| `packages/runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts:53` | `RuntimeOutputTable.logs` | output logs | `RuntimeLogLineRow.contextId` | runtime activity / codec stderr journal | same local context gate | yes | n/a | Raw process stderr/log writes at `packages/runtime/src/host/raw-process-runtime.ts:148`; codec stderr journal writes at `packages/runtime/src/agent-event-pipeline/subscribers/stderr-journal.ts:62`. |
| `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-appender.ts:33` | `RuntimeIngressTable.inputs` | ingress inputs | `RuntimeIngressRequest.contextId` | owner host or non-owning host/client caller | owner host is resolved from `RuntimeContext.host` in `packages/runtime/src/host/commands.ts:126` and used by `ownerIngressLayer` at `packages/runtime/src/host/commands.ts:41` | mixed | yes, through command stream or host RPC | This path does idempotency lookup at `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-appender.ts:49`, sequence allocation at `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-appender.ts:54`, then insert at `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-appender.ts:61`. Cross-host writes are covered behavior. |
| `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts:34` | `RuntimeIngressTable.deliveries` | ingress deliveries | claimed `RuntimeIngressInputRow.contextId` | runtime delivery subscriber in active host process | subscriber is started inside the active context runtime at `packages/runtime/src/agent-event-pipeline/session-runtime.ts:149` or raw stdin path at `packages/runtime/src/host/raw-process-runtime.ts:179` | yes | n/a | Claim lookup at `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts:46`; claim upsert at `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts:61`; completion upsert at `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts:74`. |
| `packages/runtime/src/authorities/runtime-control-plane-recorder.ts:53` | `RuntimeControlPlaneTable.contexts` | contexts | supplied `contextId` | host/client composition with `CurrentHostSession` | `makeLocalRuntimeContextForHostSession` binds row host from current host session at `packages/runtime/src/authorities/runtime-control-plane-recorder.ts:62` | yes for local insert | no, registry stays namespace-scoped | Context rows are explicitly self-sufficient for prompt routing in `packages/protocol/src/launch/table.ts:147`. |
| `packages/runtime/src/authorities/runtime-control-plane-recorder.ts:89` | `RuntimeControlPlaneTable.runs` | runs | `RuntimeContext.contextId` | runtime workflow host | workflow reads context then records started/exited/failed in `packages/runtime/src/host/runtime-context-workflow.ts:134` | yes | n/a | Activity attempt allocation queries runs by context at `packages/runtime/src/authorities/runtime-control-plane-recorder.ts:75`; started/exited/failed writes are at `packages/runtime/src/authorities/runtime-control-plane-recorder.ts:94`, `:115`, and `:142`. |
| `packages/runtime/src/durable-tools/internal/durable-wait-store.ts:53` | `DurableToolsTable.waits` | waits | workflow execution id, not context id | host durable-tools / workflow fibers | host-owned durable-tools stream | n/a | keep separate | `WaitFor.match` writes active waits at `packages/runtime/src/durable-tools/internal/wait-for.ts:123`; timeout updates at `packages/runtime/src/durable-tools/internal/wait-for.ts:152`; reconcile updates at `packages/runtime/src/durable-tools/internal/reconcile.ts:35`. |
| `packages/runtime/src/durable-tools/internal/durable-wait-store.ts:58` | `DurableToolsTable.completions` | wait completions | workflow execution id, not context id | wait router / timeout fiber | host-owned durable-tools stream | n/a | keep separate | Match completion writes at `packages/runtime/src/durable-tools/internal/wait-router.ts:111`; timeout completion writes at `packages/runtime/src/durable-tools/internal/wait-for.ts:195`. |
| `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:41` | workflow engine table | activity claims | workflow execution id | workflow engine adapter | host-owned workflow stream from `packages/runtime/src/host/layers.ts:166` | n/a | keep separate | The workflow gate says not to duplicate `@effect/workflow` durability. Activity claim uses `insertOrGet`; executions, activities, deferreds, and clock wakeups are workflow infrastructure. |
| `packages/runtime/src/verified-webhook-ingest/adapter.ts:340` | `VerifiedWebhookFactTable.verifiedWebhookFacts` | verified webhook facts | none | webhook ingest adapter | no runtime context owner | n/a | outside scope | This is adjacent integration ingest, not runtime context output/ingress/control-plane data. |

### Q1.3 Known Potential Violators

| Scenario | Verdict | Evidence |
| --- | --- | --- |
| External CLI ingress (`firegrid run --prompt`) | Single-writer-preservable for local `run`; cross-host prompt append requires inversion for Model B. | `src/run.ts:200` inserts the local context, appends optional prompt at `src/run.ts:214`, then starts runtime at `src/run.ts:222`. However `appendRuntimeIngress` can run in host B and write host A ingress by resolving the owner context at `packages/runtime/src/host/commands.ts:126`; test coverage at `packages/runtime/test/host/prompt-routing.test.ts:120` proves that behavior. |
| Context insert from non-owning host | Single-writer-preservable, but namespace registry remains. | `RuntimeContextInsert` reads `CurrentHostSession` and builds the host binding from that session at `packages/runtime/src/authorities/runtime-control-plane-recorder.ts:224`; tests enforce non-local start rejection before host-owned writes at `packages/runtime/test/host/two-host-isolation.test.ts:176`. |
| Tool router producing ingress | Single-writer-preservable for tool results; host-agent prompt helpers can cross-host append and need inversion under Model B. | Tool router filters output for the same context/activity and appends tool result ingress to that context at `packages/runtime/src/agent-event-pipeline/subscribers/tool-router.ts:50` and `:91`. Separately, `AgentToolHost.appendSessionPrompt` resolves any session context and routes to owner ingress at `packages/runtime/src/host/agent-tool-host-live.ts:181`; test at `packages/runtime/test/host/prompt-routing.test.ts:217`. |
| Permission response paths (ACP codec) | Requires inversion for Model B when caller is not owner host. | Client/session APIs create `PermissionResponse` ingress rows at `packages/client/src/firegrid.ts:445` and `packages/client/src/firegrid.ts:756`; ACP only consumes that response through the live continuation in `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:378`. |

### Q3.1 Point-Lookup Table

| Lookup site | Current table/collection | Key | Purpose | Hot/cold | Event-log replacement | Index needed? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-appender.ts:49` | `RuntimeIngressTable.inputs` | `inputId` | ingress idempotency before sequencing | hot | `InputSequenced` / `IngressAccepted` projection keyed by `inputId` | persistent | Required after restart; fold-only index would need warm replay before accepting prompts. |
| `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-appender.ts:65` | `RuntimeIngressTable.inputs` | `inputId` | tool-result dedupe / read | hot | same input index | persistent | Tool router checks before appending a result at `packages/runtime/src/agent-event-pipeline/subscribers/tool-router.ts:75`. |
| `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts:46` | `RuntimeIngressTable.deliveries` | `{ subscriberId, inputId }` | at-most-once delivery claim | hot | `IngressDeliveryClaimed` projection keyed by subscriber/input | persistent | Raw stdin delivery documents the durable claim-before-emit guarantee at `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process-stdin-delivery.ts:9`. |
| `packages/runtime/src/authorities/runtime-control-plane-recorder.ts:184` | `RuntimeControlPlaneTable.contexts` | `contextId` | context resolution for start, prompt routing, snapshots | hot | namespace registry / context index | persistent | `readRuntimeContext` maps missing rows to runtime errors at `packages/runtime/src/host/internal/runtime-context-helpers.ts:25`. |
| `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:58` | `WorkflowEngineTable.clockWakeups` | `clockKey` | clock firing guard | hot infrastructure | unchanged workflow table | existing table | Workflow durability is out of context-event-log scope. |
| `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:93` | `WorkflowEngineTable.executions` | `executionId` | workflow resume/poll/execute | hot infrastructure | unchanged workflow table | existing table | Execution row writes happen at `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:121` and `:150`. |
| `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:196` | `WorkflowEngineTable.activities` | `activityKey` | activity replay / result check | hot infrastructure | unchanged workflow table | existing table | Activity claim and completion are workflow-owned at `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:204` and `:232`. |
| `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:247` | `WorkflowEngineTable.deferreds` | deferred key | durable deferred result | hot infrastructure | unchanged workflow table | existing table | `deferredDone` guards by existing row at `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:255`. |

### Provisional Model

The provisional checkpoint model was **Model C: Hybrid**, and the final verdict
keeps that choice.

## DurableTable Semantics Relevant To The Spike

The current table surface is not just a convenience facade. It supplies:

- txid-coordinated `insert` / `upsert` / `delete` writes through
  `createStreamDB` actions: `packages/effect-durable-operators/src/DurableTable.ts:386`
  through `packages/effect-durable-operators/src/DurableTable.ts:454`;
- `insertOrGet` primary-key fencing through producer id / epoch / sequence:
  `packages/effect-durable-operators/src/DurableTable.ts:519` and
  `packages/effect-durable-operators/src/DurableTable.ts:596`;
- current rows plus live row changes via `rows()`:
  `packages/effect-durable-operators/src/DurableTable.ts:594`;
- read-only collection views for query/UI access:
  `packages/effect-durable-operators/src/DurableTable.ts:459`.

A context event log could use `DurableStream` directly, but the hot lookup
paths above would still need explicit persistent indexes or table-backed
projections. "Replay and hope" is not enough for ingress idempotency or
delivery claims.

## Model C Shape

The hybrid split should be explicit:

| Data / behavior | Model C home | Reason |
| --- | --- | --- |
| Runtime output events and logs | per-context or owner-host context event log candidate | Written by owning runtime activity and naturally ordered with codec/raw output. |
| Runtime ingress delivery claims/completions | per-context or owner-host context event log candidate, with persistent claim index | Written by owning runtime delivery subscriber; claim-before-emit semantics must survive. |
| Runtime run started/exited/failed | context event log candidate plus optional namespace/host run index | Written by owning workflow host, but cross-context run listing/waits currently use `RuntimeRuns` at `packages/runtime/src/authorities/runtime-control-plane-recorder.ts:220`. |
| Runtime ingress inputs from prompts/permissions/tool-host commands | command stream or host RPC into owner host, then owner appends to context log | Current direct cross-host writes make pure Model B invalid until inverted. |
| Runtime contexts registry | namespace-scoped control-plane table or derived namespace index | Context lookup by id is a hot cross-context operation and prompt routing depends on host binding. |
| Workflow engine lifecycle | unchanged workflow engine tables | `@effect/workflow` already owns executions, activities, deferreds, clocks, and claims. |
| Durable wait rows/completions | unchanged durable-tools boundary | Wait rows are workflow/operator infrastructure, not context history. |
| Verified webhook facts | integration/app boundary | No runtime context owner. |

## Host SDK Reconciliation

| Host SDK / Client SDK commitment | Current symbol/path | Model C fate | Migration note |
| --- | --- | --- | --- |
| Runtime remains execution substrate | `@firegrid/runtime` / host internals | survives | No runtime import of host-sdk/client-sdk/CLI is required by this verdict. |
| Host SDK owns host composition | `FiregridRuntimeHostLive`, `FiregridLocalHostLive` in `packages/runtime/src/host/layers.ts:201` | survives initially | Host SDK can wrap current hybrid substrate and later route ingress through command/RPC. |
| Client SDK owns session prompt/permission APIs | `packages/client/src/firegrid.ts:730`, `packages/client/src/firegrid.ts:756` | survives, but should not expose table append semantics | Client API can remain stable while transport changes from direct owner ingress table write to command/RPC. |
| Runtime ToolUse executor seam | `packages/runtime/src/agent-event-pipeline/subscribers/tool-router.ts:50` | no blocker | PR 1 can land; it does not commit the durable substrate shape. |
| Typed waits over runtime observations | `RuntimeAgentOutputEvents`, `RuntimeRuns`, `RuntimeWaitStreams` | survives with compatibility | `RuntimeRuns` may become an index/projection if run lifecycle moves into context logs. |
| Product apps do not import runtime internals | Host SDK SDD package-boundary rule | reinforced | A public SDK should hide whether ingress is direct table append, command stream, or host RPC. |

## Why The Other Models Are Wrong Right Now

### Model A: Local Cleanup

Local cleanup would be useful for reducing capability/tag repetition, and the
Host SDK SDD already allows small projection helpers for direct table-to-tag
layers. But Model A does not answer the structural problem uncovered by the
checkpoint: cross-host prompt/permission ingress is currently encoded as
direct writes to owner host tables. Cleaning tags around that path would make
the wrong primitive look neater.

### Model B: Context Event Log

Pure per-context event log fails today for two reasons:

1. The writer identity gate fails for ingress. `appendRuntimeIngress` and
   `AgentToolHost` can write to a context owned by another host, and tests
   prove that behavior.
2. The control-plane gate fails for context registration/lookup. Context rows
   are namespace-scoped, hot by `contextId`, and carry host binding for prompt
   routing.

Model B becomes possible only after external ingress is inverted through a
command stream or host RPC and after the namespace registry/index contract is
made explicit. That is a structural SDD, not a local refactor.

## Sequencing Recommendation

1. Do not block Host SDK PR 1. The `RuntimeToolUseExecutor` seam is compatible
   with all three substrate models and does not publish a durable storage
   contract.
2. In the SDK cutover, keep public session APIs transport-shaped, not
   table-shaped. Avoid exposing `RuntimeIngressTable` or owner-host stream
   construction as the app-facing ingress primitive.
3. Draft a Model C SDD before any runtime substrate rewrite. It should define:
   namespace control-plane registry, external ingress command/RPC path,
   context-owned event log candidate, persistent indexes, and compatibility
   projections for current waits/snapshots.
4. Only after the command/RPC path exists should a PR move context-owned output,
   delivery, and run lifecycle rows toward a context log.

## Open Questions

- Command stream vs host RPC is not decided. Both can restore
  single-writer-per-context for external ingress; the choice depends on
  multi-host availability and desired client/server topology.
- Run lifecycle placement needs a listing/wait decision. Runtime run rows are
  context-owned writes, but current wait streams and snapshots use the
  namespace control-plane `runs` stream.
- Per-context stream cost needs load testing before replacing host-owned
  output/ingress streams.
- Durable wait and workflow extraction should remain separate. Their writes
  are infrastructure lifecycle, not product/runtime context history.
