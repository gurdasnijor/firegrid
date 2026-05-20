# tf-krts schema-projection inventory finding

## Verdict

**FIRST-SLICE INVENTORY COMPLETE.** The current package graph is close to the canonical direction in some places, but the protocol -> bindings -> runtime firewall is not yet mechanically visible. The main mismatch pattern is that product contracts and execution substrate are still co-exported through convenience barrels and protocol table facades.

Canonical target:

- `@firegrid/protocol` owns schemas, operation contracts, row/projection schemas, and normalized observations.
- `@firegrid/host-sdk` owns host binding and composition, including MCP/Effect AI projection.
- `@firegrid/client-sdk` owns runtime-source-free app/browser binding over protocol schemas.
- `@firegrid/runtime` owns workflow definitions, runtime event pipeline, durable authorities, adapters, and runtime operation execution.

References: [docs/architecture/host-sdk-runtime-boundary.md:31](../architecture/host-sdk-runtime-boundary.md), [docs/architecture/host-sdk-runtime-boundary.md:95](../architecture/host-sdk-runtime-boundary.md), [docs/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md:53](../sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md), [docs/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md:141](../sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md).

## Mismatches

1. **Protocol still exposes a bespoke operation wrapper as production contract.**
   Evidence: `FiregridOperationEntry` and `defineFiregridOperation` live in [packages/protocol/src/operations/schema.ts:3](../../packages/protocol/src/operations/schema.ts) and [packages/protocol/src/operations/schema.ts:53](../../packages/protocol/src/operations/schema.ts). The SDD says Effect Schema annotations already cover most metadata and the schema entry should be the thing bindings serialize from.
   Recommendation: **move/project** to plain protocol schema exports plus a small projection annotation helper; delete `FiregridOperationEntry` / `defineFiregridOperation` during the transactional cutover unless a binding demonstrably needs the wrapper.

2. **Agent-tool schema re-exports the operation wrapper and mixes runtime observation source names into the tool schema module.**
   Evidence: [packages/protocol/src/agent-tools/schema.ts:31](../../packages/protocol/src/agent-tools/schema.ts) re-exports the wrapper helpers/types, while [packages/protocol/src/agent-tools/schema.ts:40](../../packages/protocol/src/agent-tools/schema.ts) defines `FiregridRuntimeObservationSourceNames`. Tool inputs such as `wait_for` are correctly schema-owned at [packages/protocol/src/agent-tools/schema.ts:103](../../packages/protocol/src/agent-tools/schema.ts).
   Recommendation: **move/project** operation metadata to a neutral protocol catalog and move observation source names to a protocol observation/session module; leave tool input/output schemas here.

3. **Protocol exports live DurableTable classes, not just row/projection schemas.**
   Evidence: [packages/protocol/src/launch/index.ts:155](../../packages/protocol/src/launch/index.ts) exports `RuntimeControlPlaneTable` and `RuntimeOutputTable`; [packages/protocol/src/launch/table.ts:1](../../packages/protocol/src/launch/table.ts) imports `DurableTable`; [packages/protocol/src/launch/table.ts:211](../../packages/protocol/src/launch/table.ts) defines table classes. Canonical protocol should not own live Layers that touch Durable Streams.
   Recommendation: **move/project** row schemas through protocol, move table facades/layers to runtime or a transport binding, and expose only protocol-level capability/service contracts when those are genuine product contracts.

4. **Client-sdk is package-manifest runtime-source-free, but its implementation still consumes durable table facades directly.**
   Evidence: the manifest depends only on protocol/effect at [packages/client-sdk/package.json:38](../../packages/client-sdk/package.json), but [packages/client-sdk/src/firegrid.ts:12](../../packages/client-sdk/src/firegrid.ts) imports `RuntimeControlPlaneTable` / `RuntimeOutputTable`, [packages/client-sdk/src/firegrid.ts:341](../../packages/client-sdk/src/firegrid.ts) materializes `RuntimeOutputTable.layer`, and [packages/client-sdk/src/firegrid.ts:1053](../../packages/client-sdk/src/firegrid.ts) materializes `RuntimeControlPlaneTable.layer`. The canonical client rule forbids direct durable table facade calls.
   Recommendation: **move/project** to an explicitly supplied protocol-safe transport/read capability; keep the current direct table use only as a transitional internal transport adapter, not as the client binding model.

5. **Host-sdk's public agent-tools barrel combines binding and execution surfaces.**
   Evidence: [packages/host-sdk/src/agent-tools/index.ts:12](../../packages/host-sdk/src/agent-tools/index.ts) exports both `bindings` and `execution`; [packages/host-sdk/package.json:20](../../packages/host-sdk/package.json) publishes `./agent-tools/execution`; [packages/host-sdk/src/agent-tools/execution/index.ts:24](../../packages/host-sdk/src/agent-tools/execution/index.ts) exports `toolUseToEffect` and `ToolCallWorkflow`.
   Recommendation: **move/project** execution to runtime operation services or mark it transitional/internal; keep `@firegrid/host-sdk/agent-tools/bindings` as the stable binding surface.

6. **`tool-use-to-effect.ts` mixes binding decode/ToolResult adaptation with runtime substrate execution.**
   Evidence: the file imports protocol schemas at [packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:34](../../packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts), but also imports `@effect/workflow` at [packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:32](../../packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts), runtime events/durable-tools at [packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:86](../../packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts), and performs channel wait execution at [packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:293](../../packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts).
   Recommendation: **move/project** validated operation execution arms to runtime services where they use workflow engine, durable streams, provider adapters, or runtime authorities; leave decode and `ToolResult` adaptation at the host binding edge.

7. **Host-sdk defines the tool-call workflow body.**
   Evidence: [packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:12](../../packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts) imports `@effect/workflow`, [packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:23](../../packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts) imports runtime event schema, and [packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:53](../../packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts) defines `ToolCallWorkflow`. The canonical placement table says scheduled/tool-call workflow definitions are runtime substrate.
   Recommendation: **move/project** `ToolCallWorkflow` and its workflow body to runtime; host-sdk should install the layer and supply host-bound capabilities.

8. **Host-sdk host barrel exposes runtime substrate internals as public host API.**
   Evidence: [packages/host-sdk/src/host/index.ts:64](../../packages/host-sdk/src/host/index.ts) re-exports `RuntimeAgentOutputObservation` from runtime, [packages/host-sdk/src/host/index.ts:67](../../packages/host-sdk/src/host/index.ts) re-exports runtime errors, [packages/host-sdk/src/host/index.ts:73](../../packages/host-sdk/src/host/index.ts) re-exports `CallerOwnedFactStreams`, and [packages/host-sdk/src/host/index.ts:130](../../packages/host-sdk/src/host/index.ts) re-exports runtime control workflow/reconciler symbols.
   Recommendation: **move/project** broad runtime symbols behind narrow host composition helpers; stable observation shapes should come from protocol, and workflow/reconciler definitions should be runtime-owned exports.

9. **Runtime-context workflow definitions are still in host-sdk.**
   Evidence: [packages/host-sdk/src/host/runtime-context-workflow-core.ts:1](../../packages/host-sdk/src/host/runtime-context-workflow-core.ts) imports `Activity`, `DurableDeferred`, `Workflow`, and `WorkflowEngine`; [packages/host-sdk/src/host/runtime-context-workflow-core.ts:113](../../packages/host-sdk/src/host/runtime-context-workflow-core.ts) defines `RuntimeContextWorkflowSession`; [packages/host-sdk/src/host/runtime-context-workflow-core.ts:827](../../packages/host-sdk/src/host/runtime-context-workflow-core.ts) defines `RuntimeContextWorkflowNative`. The boundary doc explicitly lists this file as leaked below the line.
   Recommendation: **move/project** runtime-context workflow definitions and Activity bodies to runtime; host-sdk should keep the host composition layer that provides runtime-owned capability tags.

10. **Runtime still exports normalized agent-output observation contracts directly even though protocol now owns the normalized observation projection.**
    Evidence: [packages/runtime/src/index.ts:61](../../packages/runtime/src/index.ts) exports `RuntimeAgentOutputEnvelopeSchema`, decoders, and `RuntimeAgentOutputObservation`; [packages/runtime/src/agent-event-pipeline/events/output.ts:5](../../packages/runtime/src/agent-event-pipeline/events/output.ts) defines the runtime copy. Protocol defines the same product-level envelope/decoder at [packages/protocol/src/session-facade/schema.ts:214](../../packages/protocol/src/session-facade/schema.ts) and [packages/protocol/src/session-facade/schema.ts:430](../../packages/protocol/src/session-facade/schema.ts).
    Recommendation: **project** the public product contract through protocol; runtime may keep internal envelopes/authority tags but public consumers should import protocol/client observation types.

11. **Runtime verified-webhook-ingest co-exports public fact schemas and table implementation.**
    Evidence: [packages/runtime/src/verified-webhook-ingest/index.ts:1](../../packages/runtime/src/verified-webhook-ingest/index.ts) exports the ingestion adapter, while [packages/runtime/src/verified-webhook-ingest/index.ts:14](../../packages/runtime/src/verified-webhook-ingest/index.ts) also exports `VerifiedWebhookFactSchema` and `VerifiedWebhookFactTable`; the runtime root re-exports both at [packages/runtime/src/index.ts:89](../../packages/runtime/src/index.ts). The boundary doc says ingestion implementation/table belongs in runtime, but stable fact schema needed by multiple bindings should be protocol-owned.
    Recommendation: **move/project** stable webhook fact schema/key through protocol if it is binding-facing; leave signature verification, durable insert, table implementation, and table layer in runtime.

12. **Protocol currently depends on `@effect/ai` for agent-output wire schemas.**
    Evidence: [packages/protocol/package.json:55](../../packages/protocol/package.json) includes `@effect/ai`; [packages/protocol/src/agent-output/schema.ts:16](../../packages/protocol/src/agent-output/schema.ts) imports `Prompt` and `Response` and uses their part schemas at [packages/protocol/src/agent-output/schema.ts:19](../../packages/protocol/src/agent-output/schema.ts). This is not an Effect AI `Tool` / `Toolkit` value, so it is not the same violation as host binding, but it does couple protocol wire schemas to the binding library's prompt/response package.
    Recommendation: **leave-with-rationale for now**, because the comments state this preserves durable wire compatibility; revisit only if browser/app bundling or protocol minimality becomes a concrete problem.

## Coordination Notes

- Lanes B/C/D should treat this as inventory, not an implementation request. Several findings overlap the canonical dispatch guidance for runtime substrate, client binding, and host composition refactors.
- The strongest first mechanical guard after the transactional cutover is a dep rule that allows `client-sdk -> protocol/effect`, allows binding packages to import schema catalogs, and prevents binding barrels from importing runtime execution internals except through narrow capability tags.
