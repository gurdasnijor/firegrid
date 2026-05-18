# tiny-firegrid

Executable toy model for Firegrid architecture reasoning.

This package is private and intentionally not a production dependency. It models
the post-#315 system as four channels:

1. namespace control: contexts and runtime input intents;
2. per-context workflow state: deferred input and workflow evidence;
3. per-context output: agent output rows;
4. host-process coordination: active engine registry and process-owned state.

The package mirrors the production package layout where that gives useful
architectural signal:

- `src/configurations/`: runnable or typechecked architectural configurations;
- `src/runtime/`: runtime-facing boundaries, matching `packages/runtime/src`;
- `src/host-sdk/`: host-sdk-facing boundaries, matching `packages/host-sdk/src`;
- `src/effect-durable-operators/`: single-process DurableTable facade;

The model imports real `Effect`, `Stream`, `Layer`, `Context`,
`@effect/workflow`, `@firegrid/runtime`, and `effect-durable-operators` types.
It does not implement the Firegrid runtime; it makes architectural boundaries
type-check against the same shapes the production system uses.

`src/effect-durable-operators/DurableTable.ts` is the in-memory adapter. It
implements the public DurableTable collection facade shape for single-process
checks, so toy writes still go through `insertOrGet`, `upsert`, `get`, `query`,
and `rows` instead of bespoke append helpers.

The current configuration wires the path end to end: a runtime input intent is
written to the namespace control plane, an owner-side workflow engine completes
the runtime-input deferred, `Workflow.make` invokes the runtime-context workflow
body, the body sends an `AgentInputEvent` through an `AgentSessionService`, and
sandbox stdout is projected into per-context runtime output observations.

There is intentionally no `simulation/transitions` layer. Tiny-firegrid should
drive examples through public boundaries: `Stream`, `DurableTable` collection
facades, `Workflow.make`, `WorkflowEngine`, runtime agent-event-pipeline
contracts, and host-sdk control-plane contracts. A transition that has to be
called directly is treated as production-internal machinery, not a model API.

See `FINDINGS.md` for the running tracker of architectural/API gaps surfaced
while keeping the toy model aligned with production boundaries. Sidecar agents
should update the stable `TFIND-*` status lines as they address findings.
