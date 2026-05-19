# Architecture Archaeology — Leaf Findings (Phase 1, ast-grep)

_Generated 2026-05-19T05:27:20Z · 269 findings · syntactic inventory only._
_Findings are **information, not defects**. No grading: the footprint is the point._

## Totals by rule

| rule | count | files |
|---|--:|--:|
| double-launder-cast | 1 | 1 |
| effect-context-in-layer-builder | 4 | 4 |
| manual-scope-buildwithscope | 2 | 2 |
| tfind-anchor-comment | 255 | 71 |
| type-safety-eslint-disable | 7 | 7 |

## double-launder-cast (1)

> `x as unknown as T` erases the source type then asserts the target. Inventory only — some are legitimate boundary adapters; the question is how many, and clustered where. 

| file | n | lines |
|---|--:|---|
| `packages/tiny-firegrid/src/effect-durable-operators/DurableTable.ts` | 1 | 11 |

## effect-context-in-layer-builder (4)

> Marks where a layer build closes over the ambient context. Whether that capture is re-provided into a deferred handler is the load-bearing question — see finding 2 (ts-morph capture-replay), not resolvable here. 

| file | n | lines |
|---|--:|---|
| `packages/host-sdk/src/host/agent-tool-host-live.ts` | 1 | 218 |
| `packages/host-sdk/src/host/commands.ts` | 1 | 156 |
| `packages/host-sdk/src/host/mcp-host.ts` | 1 | 115 |
| `packages/host-sdk/src/host/runtime-substrate.ts` | 1 | 94 |

## manual-scope-buildwithscope (2)

> Every site that materializes a layer against an explicit Scope by hand. Inventory only — legitimate in adapters/tests; clustering in substrate composition is the interesting signal. 

| file | n | lines |
|---|--:|---|
| `packages/host-sdk/src/host/runtime-context-engine-registry.ts` | 1 | 152 |
| `packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts` | 1 | 271 |

## tfind-anchor-comment (255)

> Anchors marking historical pain / decisions. Their per-file density is the heat map — read counts-by-file, not individual lines. 

| file | n | lines |
|---|--:|---|
| `packages/client-sdk/src/firegrid.ts` | 14 | 1, 2, 3, 4, 5, 476, 736, 737, 789, 790, 796, 797, 804, 842 |
| `packages/host-sdk/src/agent-tools/bindings/index.ts` | 1 | 1 |
| `packages/host-sdk/src/agent-tools/bindings/tool-error.ts` | 1 | 1 |
| `packages/host-sdk/src/agent-tools/bindings/tools.ts` | 1 | 1 |
| `packages/host-sdk/src/agent-tools/execution/index.ts` | 1 | 1 |
| `packages/host-sdk/src/agent-tools/execution/tool-host.ts` | 1 | 1 |
| `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` | 4 | 1, 216, 323, 552 |
| `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts` | 3 | 1, 101, 118 |
| `packages/host-sdk/src/agent-tools/index.ts` | 1 | 1 |
| `packages/host-sdk/src/host/agent-tool-host-live.ts` | 7 | 43, 79, 96, 97, 120, 133, 215 |
| `packages/host-sdk/src/host/commands.ts` | 3 | 134, 135, 152 |
| `packages/host-sdk/src/host/config-live.ts` | 2 | 6, 8 |
| `packages/host-sdk/src/host/control-request-reconciler.ts` | 3 | 44, 47, 53 |
| `packages/host-sdk/src/host/index.ts` | 1 | 1 |
| `packages/host-sdk/src/host/internal/run-context-workflow.ts` | 2 | 1, 2 |
| `packages/host-sdk/src/host/internal/runtime-context-helpers.ts` | 4 | 17, 21, 24, 56 |
| `packages/host-sdk/src/host/internal/runtime-context-workflow-run.ts` | 1 | 9 |
| `packages/host-sdk/src/host/layers.ts` | 8 | 89, 90, 96, 130, 151, 266, 282, 283 |
| `packages/host-sdk/src/host/mcp-host.ts` | 6 | 1, 119, 120, 160, 193, 207 |
| `packages/host-sdk/src/host/per-context-runtime-output.ts` | 1 | 156 |
| `packages/host-sdk/src/host/runtime-context-mcp-base-url.ts` | 1 | 1 |
| `packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts` | 3 | 145, 178, 188 |
| `packages/host-sdk/src/host/runtime-context-session/common.ts` | 1 | 44 |
| `packages/host-sdk/src/host/runtime-context-workflow-core.ts` | 5 | 291, 292, 293, 325, 456 |
| `packages/host-sdk/src/host/runtime-context-workflow-support.ts` | 1 | 17 |
| `packages/host-sdk/src/host/runtime-substrate.ts` | 6 | 42, 58, 73, 74, 75, 88 |
| `packages/host-sdk/src/host/sync-run.ts` | 2 | 40, 41 |
| `packages/host-sdk/src/host/types.ts` | 1 | 25 |
| `packages/host-sdk/src/index.ts` | 3 | 1, 29, 54 |
| `packages/protocol/src/agent-output/schema.ts` | 2 | 1, 62 |
| `packages/protocol/src/agent-tools/schema.ts` | 2 | 1, 92 |
| `packages/protocol/src/launch/authority.ts` | 3 | 1, 2, 3 |
| `packages/protocol/src/launch/control-request.ts` | 5 | 1, 2, 6, 63, 86 |
| `packages/protocol/src/launch/host-context-authority.ts` | 14 | 1, 2, 3, 4, 5, 6, 7, 24, 41, 69, 100, 151, 189, 218 |
| `packages/protocol/src/launch/schema.ts` | 15 | 141, 199, 273, 316, 346, 352, 355, 357, 366, 403, 404, 405, 412, 413, 414 |
| `packages/protocol/src/launch/table.ts` | 2 | 153, 154 |
| `packages/protocol/src/session-facade/index.ts` | 1 | 1 |
| `packages/protocol/src/session-facade/schema.ts` | 3 | 216, 427, 441 |
| `packages/runtime/src/agent-adapters/AgentAdapter.ts` | 5 | 15, 16, 20, 21, 36 |
| `packages/runtime/src/agent-adapters/LanguageModelAdapter.ts` | 4 | 19, 21, 22, 27 |
| `packages/runtime/src/agent-adapters/acp/adapter.ts` | 20 | 32, 76, 77, 117, 168, 184, 185, 227, 228, 294, 325, 326, 346, 430, 451, 455, 456, 457, 498, 499 |
| `packages/runtime/src/agent-adapters/acp/mapping.ts` | 5 | 10, 13, 14, 73, 99 |
| `packages/runtime/src/agent-adapters/current-turn.ts` | 2 | 8, 9 |
| `packages/runtime/src/agent-adapters/errors.ts` | 7 | 3, 15, 25, 33, 39, 45, 56 |
| `packages/runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts` | 1 | 25 |
| `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts` | 2 | 332, 333 |
| `packages/runtime/src/agent-event-pipeline/codecs/acp/mapping.ts` | 1 | 12 |
| `packages/runtime/src/agent-event-pipeline/codecs/contract.ts` | 2 | 15, 41 |
| `packages/runtime/src/agent-event-pipeline/events/contract.ts` | 4 | 1, 54, 61, 79 |
| `packages/runtime/src/agent-event-pipeline/events/stage-contracts.ts` | 3 | 3, 10, 17 |
| `packages/runtime/src/agent-event-pipeline/sources/sandbox/effect-ai.ts` | 5 | 77, 122, 146, 150, 151 |
| `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process.ts` | 4 | 219, 292, 293, 294 |
| `packages/runtime/src/agent-event-pipeline/subscribers/runtime-tool-use-executor.ts` | 3 | 27, 28, 29 |
| `packages/runtime/src/durable-tools/DurableToolsWaitFor.ts` | 1 | 1 |
| `packages/runtime/src/durable-tools/internal/durable-wait-store.ts` | 4 | 10, 11, 12, 13 |
| `packages/runtime/src/durable-tools/internal/keys.ts` | 1 | 1 |
| `packages/runtime/src/durable-tools/internal/runtime-wait-streams.ts` | 2 | 1, 58 |
| `packages/runtime/src/durable-tools/internal/table.ts` | 3 | 1, 40, 63 |
| `packages/runtime/src/durable-tools/internal/types.ts` | 6 | 1, 11, 31, 66, 82, 118 |
| `packages/runtime/src/durable-tools/internal/wait-for.ts` | 13 | 1, 88, 95, 100, 107, 115, 152, 260, 295, 369, 370, 392, 407 |
| `packages/runtime/src/durable-tools/internal/wait-router.ts` | 11 | 1, 46, 74, 108, 125, 136, 156, 186, 245, 282, 345 |
| `packages/runtime/src/index.ts` | 1 | 28 |
| `packages/runtime/src/verified-webhook-ingest/adapter.ts` | 1 | 1 |
| `packages/runtime/src/verified-webhook-ingest/keys.ts` | 1 | 1 |
| `packages/runtime/src/verified-webhook-ingest/table.ts` | 1 | 1 |
| `packages/tiny-firegrid/src/configurations/codex-acp-tool-call-pipeline.ts` | 2 | 24, 61 |
| `packages/tiny-firegrid/src/configurations/durable-streams-backed-pipeline.ts` | 1 | 22 |
| `packages/tiny-firegrid/src/configurations/multi-context-production-consuming-pipeline.ts` | 1 | 21 |
| `packages/tiny-firegrid/src/configurations/output-journal-pipeline.ts` | 1 | 21 |
| `packages/tiny-firegrid/src/configurations/permission-flow-pipeline.ts` | 1 | 21 |
| `packages/tiny-firegrid/src/configurations/stdio-jsonl-tool-execution-pipeline.ts` | 1 | 21 |

## type-safety-eslint-disable (7)

> Counts eslint-disable of no-unsafe-* and @ts-expect-error/@ts-ignore. Not a defect per comment — the footprint and its clustering are the signal (where does type debt concentrate?). 

| file | n | lines |
|---|--:|---|
| `packages/runtime/src/verified-webhook-ingest/adapter.ts` | 1 | 332 |
| `packages/tiny-firegrid/src/configurations/codex-acp-tool-call-pipeline.ts` | 1 | 63 |
| `packages/tiny-firegrid/src/configurations/durable-streams-backed-pipeline.ts` | 1 | 24 |
| `packages/tiny-firegrid/src/configurations/multi-context-production-consuming-pipeline.ts` | 1 | 23 |
| `packages/tiny-firegrid/src/configurations/output-journal-pipeline.ts` | 1 | 23 |
| `packages/tiny-firegrid/src/configurations/permission-flow-pipeline.ts` | 1 | 23 |
| `packages/tiny-firegrid/src/configurations/stdio-jsonl-tool-execution-pipeline.ts` | 1 | 23 |

