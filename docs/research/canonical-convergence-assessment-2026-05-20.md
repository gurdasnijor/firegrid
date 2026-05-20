# Canonical Boundary Convergence Assessment

Status: assessment for `tf-k4uo`
Date: 2026-05-20
Assessed main: `4bdd667ad` (`tf-gw43: dark-factory §6 live-run readiness audit`)
Canonical source: `docs/architecture/host-sdk-runtime-boundary.md`

This assesses current `main` against the canonical host-sdk/runtime firewall
document. PR state is used as evidence when it is newer than bead status; several
beads still show `IN_PROGRESS` even after their PRs merged.

## Executive Summary

Approximate convergence: **65%**.

- Fully landed: canonical document, Q1-Q4 framing, runtime-no-host-sdk guardrail,
  client-sdk-no-runtime guardrail, ChannelRegistry removal, major workflow
  definition moves, first tool-execution runtime seam, dark-factory app-channel
  ownership, and first schema-projection moves.
- In progress: agent-tool execution split, remaining workflow/runtime-support
  relocation, channel metadata protocol ownership, durable-tools deletion, and
  guardrail carveout ratcheting.
- Not started or intentionally deferred: verified-webhook fact schema projection
  to protocol and public webhook channel binding.

The next wave should prioritize finishing the execution/substrate cleanup before
opening broad new channel surface work: complete Lane B, complete Lane C
residual host-sdk substrate moves, then land `tf-6d4y` durable-tools deletion.

## Package Roles Audit

### `@firegrid/protocol`

| Canonical role | Current main state | Evidence |
| --- | --- | --- |
| Operation input/output schemas | DONE | `packages/protocol/src/operations/`, `agent-tools/`, `session-facade/`; schema-projection inventory landed in #500 (`676027e08`). |
| Channel target wire schemas and channel metadata schemas | IN-PROGRESS | Channel target/metadata still lives in `packages/host-sdk/src/host/channel.ts` and `mcp-channel-metadata.ts`; `tf-kddg` #502 removed the old registry but did not move metadata to protocol. |
| Durable row schemas shared by packages | PARTIAL | Launch/runtime-ingress/agent-output rows are in protocol; verified-webhook fact rows remain runtime-owned in `packages/runtime/src/verified-webhook-ingest/`. |
| Normalized observations for client/agent reads | IN-PROGRESS | Agent-output projection already exists; #506 (`50f5482a5`) moved agent-output observation projection; #511 is open/draft and green to add `@firegrid/protocol/observations`. |
| Protocol authority tags such as `RuntimeStartCapability` | DONE | `packages/protocol/src/launch/runtime-start.ts`; host/runtime implement live Layers. |
| No live Layers / workflow definitions / MCP server / adapter sessions | DONE | `rg` found no `@firegrid/host-sdk` or `@firegrid/runtime` imports under `packages/protocol/src`; `.dependency-cruiser.cjs` has `protocol-no-client-or-runtime`. |

### `@firegrid/host-sdk`

| Canonical role | Current main state | Evidence |
| --- | --- | --- |
| Public host construction helpers | DONE | `FiregridRuntimeHostLive` remains exported through `packages/host-sdk/src/host/layers.ts` and host barrels; Q4 in #501 keeps this stable. |
| Host-author channel Layer composition | IN-PROGRESS | `ChannelInventory` / channel factories landed in #502; dark-factory app-owned channels moved out of host-sdk in #505 (`d5dd621bd`). |
| Presentation-level channel bindings | PARTIAL | Generic session/human/state/log channels remain in host-sdk, which fits the doc; app-specific dark-factory channels moved. Metadata still host-sdk-local. |
| MCP server exposure and metadata projection | DONE | `packages/host-sdk/src/host/mcp-host.ts`, `mcp-channel-metadata.ts`; channel metadata surfaced without substrate names. |
| Effect AI `Tool` / `Toolkit` binding | DONE | `packages/host-sdk/src/agent-tools/bindings/`; execution split is separate. |
| Node/local-process topology and host-author options | DONE | `packages/host-sdk/src/host/config*.ts`, `layers.ts`, `types.ts`. |
| Narrow live Layers for runtime-owned tags | PARTIAL | `RuntimeAgentToolExecutionLive` is host-provided for a runtime-owned tag (#504), but host-sdk still owns broad runtime substrate composition. |
| Should not own workflow definitions | IN-PROGRESS | Main workflow definitions moved to runtime: control workflows #499, `WaitForWorkflow` #503, runtime-context/tool-call #507. Host wrappers remain; `control-request-reconciler.ts` still has an `Activity.make` body. |
| Should not own workflow-engine caches/registries | IN-PROGRESS | `RuntimeContextEngineRegistry` was deleted by #494 (`a89c3658b`), but `RuntimeContextWorkflowRuntime` remains in host-sdk and still owns host-scoped engine lifecycle. |
| Should not own durable wait stores/routers | NOT DONE | `packages/runtime/src/durable-tools/` and `packages/host-sdk/src/host/host-owned-durable-tools.ts` still exist; deletion PR #475 remains open/failing. |
| Should not own runtime behavior subscribers | PARTIAL | `RuntimeAgentToolExecution` tag/service moved to runtime (#504), but host-sdk still provides live execution and much tool lowering. |
| Should not own common operation execution | IN-PROGRESS | `tool-use-to-effect.ts` still performs many arms in host-sdk; only the first runtime execution service slice landed in #504. |

### `@firegrid/runtime`

| Canonical role | Current main state | Evidence |
| --- | --- | --- |
| Workflow engine implementation and primitives | DONE for current engine; primitives deferred | `packages/runtime/src/workflow-engine/`; engine-native primitives remain `tf-0mt5` contingency. |
| Workflow definitions | MOSTLY DONE | `packages/runtime/src/workflow-engine/workflows/` owns runtime-context, control, tool-call, and wait-for workflows after #499/#503/#507. Residual execution support remains host-sdk-side. |
| Runtime event pipeline and authorities | DONE | `packages/runtime/src/agent-event-pipeline/` and `packages/runtime/src/authorities/`. |
| Runtime output/input durable authorities | DONE/PARTIAL | Runtime owns output authorities; host-sdk still has substrate support files such as `runtime-substrate.ts`, `runtime-input-deferred.ts`, and `per-context-runtime-output.ts`. |
| Verified webhook ingestion implementation and tables | DONE | `packages/runtime/src/verified-webhook-ingest/`. Protocol projection is still deferred until public observer pressure. |
| Local process / ACP / provider internals | DONE | `packages/runtime/src/agent-adapters/` and sandbox sources. |
| Runtime operation execution core | IN-PROGRESS | `RuntimeAgentToolExecution` service exists in `packages/runtime/src/agent-event-pipeline/subscribers/runtime-tool-use-executor.ts`; only sleep-arm style has moved through #504. |
| Should not import host-sdk | DONE | `rg` found no runtime -> host-sdk imports; `.dependency-cruiser.cjs` has hard `runtime-no-host-sdk`. |
| Should not own MCP tool descriptions / Tool bindings / CLI commands | DONE | Tool/Toolkit remains in host-sdk bindings; CLI is separate. |
| Should not export broad table facades as app surfaces | PARTIAL | Runtime still exports `./durable-tools`, `./streams`, `./runtime-output`, and verified webhook table types. Some are sanctioned capability surfaces; others are transitional. |

### `@firegrid/client-sdk`

| Canonical role | Current main state | Evidence |
| --- | --- | --- |
| Browser/app-safe binding over protocol schemas | DONE for boundary direction | `.dependency-cruiser.cjs` has hard `client-sdk-no-runtime` and `client-sdk-no-host-sdk-or-cli`. |
| No runtime-source imports | DONE | Guardrail #509 (`64cd0ac11`) flipped client/runtime rules to hard error. |
| Normalized observation schemas through protocol | IN-PROGRESS | #506 landed first projection; #511 is the next open schema-projection move. |

## Specific Surface Placement

| Surface | Status | Evidence |
| --- | --- | --- |
| `RuntimeContextWorkflow`, `WaitForWorkflow`, scheduled/tool-call workflows | DONE with residual host wrappers | `packages/runtime/src/workflow-engine/workflows/runtime-context.ts`, `wait-for.ts`, `tool-call.ts`; #503 and #507. Host-sdk `runtime-context-workflow-core.ts` is now a compatibility re-export. |
| `RuntimeContextProvisionWorkflow`, `RuntimeStartWorkflow`, `RuntimeLifecycleWorkflow` | DONE for definitions; IN-PROGRESS for execution shell | Definitions live in `packages/runtime/src/workflow-engine/workflows/runtime-control-request.ts` from #499; host-sdk `control-request-reconciler.ts` still owns dispatch/reconcile shell. |
| Channel Layers (`LinearWebhookLive`, `session.self.lifecycle`, `state.changes`) | IN-PROGRESS | #502 replaced `ChannelRegistry` with `ChannelInventory`/Tags; #505 moved dark-factory app-channel instances out of host-sdk; metadata still host-sdk-local. |
| `channel-registry.ts` | DONE | No `packages/host-sdk/src/host/channel-registry.ts`; `rg ChannelRegistry` has no host-sdk product hits. Replaced by MCP-edge `ChannelInventory`. |
| `tool-use-to-effect.ts` | IN-PROGRESS | #497 is the carve proposal; #504 introduced runtime `RuntimeAgentToolExecution`; file still imports workflow/durable surfaces and dispatches most arms. |
| MCP server / Effect AI toolkit | DONE | Host-sdk owns `mcp-host.ts` and `agent-tools/bindings/*`; `toolkit-layer.ts` remains host execution adapter. |
| Session-handle / client facade helpers | PARTIAL | Protocol session-facade exists; client-sdk boundary is guarded. Some runtime observation/source names are still being projected (#511). |
| Durable Streams substrate access | IN-PROGRESS | Runtime owns engine/authorities; host-sdk still has `runtime-substrate.ts`, `host-owned-durable-tools.ts`, and workflow runtime support carveouts. |
| Verified webhook ingestion | PARTIAL | Runtime implementation exists; no protocol-owned stable fact schema or public webhook channel yet. |
| Webhook route installation | NOT STARTED | No canonical host/app public webhook channel route has landed in this wave. |
| `RuntimeStartCapability` | DONE | Protocol tag in `packages/protocol/src/launch/runtime-start.ts`; host/runtime composition supplies live behavior. |

## Implementation Sequence Status

| Step | Status | Evidence |
| --- | --- | --- |
| 1. Finish `tf-kddg`: registry to per-channel Tags/Layers | LANDED FIRST CUT | #502 merged (`917295334`): ChannelRegistry removed; ChannelInventory remains as binding/MCP-edge inventory. |
| 2. Split agent-tool binding from execution | IN-PROGRESS | #497 proposal merged; #504 first runtime execution service/sleep arm merged; remaining arms still in `tool-use-to-effect.ts`. |
| 3. Move workflow definitions below binding line | MOSTLY LANDED | #499 control workflows, #503 WaitForWorkflow, #507 runtime-context/tool-call workflows. Residual support/runtime shell still host-sdk. |
| 4. Review channel bindings one by one | IN-PROGRESS | #505 moved dark-factory app-owned channels; generic session/human/state/log channels remain to review as host-sdk presentation adapters. |
| 5. Add static dependency guardrails | LANDED WITH CARVEOUTS | #498 warning scan, #508 diagnostics baseline, #509 hard-error flip. `.dependency-cruiser.cjs` still carries explicit `currentHostSdkSubstrateDebt` carveouts. |

## Dispatch Guidance Lanes

| Lane | Status | Evidence |
| --- | --- | --- |
| Lane A: `tf-kddg` channel Tags/Layers and delete registry service | DONE for registry deletion; follow-up remains | #502 merged. Remaining work is metadata-to-protocol and reducing `ChannelInventory` to edge inventory only. |
| Lane B: agent-tool execution boundary | IN-PROGRESS | #497 proposal and #504 sleep-arm implementation merged. Continue arm-by-arm migration from host-sdk `tool-use-to-effect.ts` to runtime service. |
| Lane C: workflow definitions below runtime-owned subpaths | IN-PROGRESS but high progress | #499, #503, #507 merged. Next cleanup is host-sdk runtime support files and durable-tools composition. |
| Lane D: dependency guardrails | DONE for hard direction rules; ongoing ratchet | #498/#508/#509 merged. Guardrails are hard error, but host-sdk carveouts encode remaining debt. |

## Remaining Work, Ordered

1. **Finish Lane B execution split.** Move `wait_for`, `wait_for_any`, `send`,
   `call`, session, schedule, and spawn execution into runtime-owned services.
   Leave host-sdk with protocol decode, Tool/Toolkit binding, and ToolResult
   adaptation only. This clears the biggest remaining boundary leak.
2. **Finish Lane C host-sdk substrate cleanup.** Move or narrow
   `runtime-context-workflow-runtime.ts`, `runtime-substrate.ts`,
   `runtime-input-deferred.ts`, `runtime-context-workflow-support.ts`, and the
   remaining control-request execution shell so host-sdk installs Layers rather
   than owning engine lifecycle/substrate mechanics.
3. **Land `tf-6d4y` durable-tools deletion.** Delete
   `packages/runtime/src/durable-tools/` and
   `packages/host-sdk/src/host/host-owned-durable-tools.ts` after Lane B/C
   clear remaining imports. PR #475 is still open and red.
4. **Continue schema projection.** Merge #511 if accepted; then move stable
   channel metadata schemas to protocol after the `tf-kddg` shape is declared
   stable. Keep `ChannelInventory` as an edge inventory, not a registry model.
5. **Project verified-webhook fact schemas when public observer pressure
   appears.** Runtime implementation is fine today; protocol ownership begins
   when an agent/client/CLI observes webhook facts.
6. **Ratchet guardrail carveouts.** Shrink `currentHostSdkSubstrateDebt` in
   `.dependency-cruiser.cjs` after each migrated file. This should be the
   convergence scoreboard for the next wave.

## Recommended Next-Wave Dispatch

Dispatch the next wave as three coordinated implementation tracks plus one
watcher:

1. **Lane B continuation:** migrate one non-sleep `tool-use-to-effect.ts` arm
   to `RuntimeAgentToolExecution`, preferably `wait_for` because it blocks
   durable-tools deletion.
2. **Lane C cleanup:** move the runtime workflow support/substrate shell below
   runtime-owned subpaths or reduce host-sdk files to narrow Live Layer
   providers.
3. **Deletion lane:** rebase #475 after B/C clears imports; delete
   durable-tools with no compatibility shim.
4. **Guardrail watcher:** after each merge, remove the corresponding
   `currentHostSdkSubstrateDebt` carveout and keep `pnpm run lint:deps` hard
   green.

Do not dispatch another broad architecture doc or a broad "move host-sdk/host"
task. The remaining work is now specific, file-bounded implementation against
the existing canonical doc.
