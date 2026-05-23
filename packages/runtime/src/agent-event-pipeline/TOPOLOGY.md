# Agent Event Pipeline — Topology Map

Doc-Class: internal-contract
Status: active
Date: 2026-05-22

This is the **production** path map for the runtime pipeline described in
[`docs/cannon/architecture/runtime-pipeline-type-boundaries.md`](../../../../docs/cannon/architecture/runtime-pipeline-type-boundaries.md).
It names where each role lives on disk so the Shape C cutover (and downstream
slices) land in the right place. The cutover baseline lines/modules table is in
[`docs/architecture/2026-05-22-shape-c-cutover-baseline.md`](../../../../docs/architecture/2026-05-22-shape-c-cutover-baseline.md).

```text
events -> DurableTable(events) -> transforms(rows) -> keyed subscribers(rows)
```

The folder layout already mirrors that shape; this map is what each folder owns
in role terms, and which capabilities a file in it is allowed (and not allowed)
to name in its requirements channel.

| Role | Folder | Owns | Capability `R` may contain | Capability `R` MUST NOT contain |
|---|---|---|---|---|
| Wire records / channel contracts | `@firegrid/protocol/{launch,runtime-ingress,channels}` | `RuntimeEventRow`, `RuntimeIngressInputRow`, `IngressChannel`/`EgressChannel`/`CallableChannel`/`BidirectionalChannel`, `ChannelTarget`, `ChannelRouteCompletion` | (protocol package) | runtime types — protocol must not import runtime |
| Runtime events / identity | `agent-event-pipeline/events/` | normalized runtime event union, branded identities, envelope encode/decode | imports protocol row schemas | redeclared protocol schemas |
| Durable state of record | `agent-event-pipeline/authorities/`, `workflow-engine/runtime-context-state.ts` | `RuntimeContextStateStore`, `RuntimeAgentOutputJournal`, `PerContextRuntimeOutputWriter` | `DurableTable` capability tags | side-effecting subscribers (those go to `subscribers/`) |
| Pure transforms | `agent-event-pipeline/transforms/` | pure `(state, event) → (state, actions)` reducers, decode helpers, trigger evaluation | nothing — pure functions | `Effect.gen`, `Effect.succeed`/`fail`/`sync`, `Layer.*`, `Workflow.make`, `Activity.make`, `Context.Tag`, `DurableDeferred.*` (gated by `firegrid-transforms-no-effect-shaped-exports`) |
| Live boundaries (Shape A) | `agent-event-pipeline/codecs/`, `agent-event-pipeline/sources/`, `agent-event-pipeline/session-byte-stream-adapter.ts` | `AgentSession`, `AgentByteStream`, codec sessions | transport / session / id tags, scoped resources | durable plane, runtime state, workflow machinery |
| Tool execution (claimed-work Shape D) | `agent-event-pipeline/tool-execution/`, `workflow-engine/workflows/tool-call.ts` | `ToolCallWorkflow`, executors | `WorkflowEngine.*`, `RuntimeToolUseExecutor` | RuntimeContext-lifetime body |
| Channels (wire-edge capability handles) | `channels/` (runtime), `@firegrid/protocol/channels/router` | host service tags typed by protocol channel contracts; `HostPlaneChannelRouter`, `RuntimeChannelRouter` | protocol channel contracts | runtime ownership of channel schemas |
| Streams / observation | `streams/`, `agent-event-pipeline/authorities/runtime-output-journal.ts` | `RuntimeAgentOutputAfterEvents` (initial / after / forContext) | typed read tags | write authority for the same table |
| **Shape C subscribers** | `agent-event-pipeline/subscribers/runtime-context/` (new) | per-event keyed RuntimeContext handler | state store, channel tags, narrow live capabilities | `WorkflowEngine.WorkflowEngine`, `WorkflowEngine.WorkflowInstance`, `Activity.make`, `Workflow.suspend`/`execute` (gated by `firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber`) |
| Shape B projection consumers | `agent-event-pipeline/subscribers/**` (other) | read-only typed source consumers | typed read tags only | state stores, write tags |
| Shape D workflow-shaped subscribers | `agent-event-pipeline/tool-execution/`, `workflow-engine/workflows/{wait-for,scheduled-prompt}.ts` | `Workflow.make` workflows with workflow-machinery justification | `WorkflowEngine.*` | RuntimeContext-lifetime body |
| Root layer composition | host-sdk host composition, app entry `run(...)` | `Layer.mergeAll`, `Layer.provide` | every capability | redeclaring capabilities |

## Cutover deletion targets (greenfield)

The Shape C cutover deletes the following bridge code (the cutover baseline
counts them):

| Path | Reason |
|---|---|
| `packages/runtime/src/workflow-engine/runtime-input-deferred.ts` | C4 — per-sequence `DurableDeferred` input mailbox bridge |
| `packages/runtime/src/workflow-engine/workflows/runtime-context.ts` (context-lifetime body) | C2 — parked long-lived body |
| `packages/runtime/src/workflow-engine/workflows/runtime-context-run.ts` | spawns the parked body |
| `packages/runtime/src/kernel/runtime-context-workflow-runtime.ts` (parts) | host-side parked-body wiring |

The pure transitions in `workflow-engine/workflows/runtime-context.ts` (`transitionInputEvent`,
`transitionOutputEvent`) move to `agent-event-pipeline/transforms/`. The
durable state lives at `tables/runtime-context-state.ts` per
`docs/architecture/2026-05-22-runtime-physical-target-tree.md`
(moved out of `workflow-engine/` in Wave A of the Shape C cutover). The body
itself is **deleted**, replaced by the per-event handler in
`agent-event-pipeline/subscribers/runtime-context/`.

## Why this matters for the gate

The gates in `.semgrep.yml` (tf-zchu) read these paths literally:

- `firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber` — paths:
  `agent-event-pipeline/subscribers/runtime-context/**/*.ts` — blocks
  `Activity.make`, `Workflow.suspend`, `Workflow.execute`,
  `WorkflowEngine.WorkflowEngine`, `WorkflowEngine.WorkflowInstance`.
- `firegrid-transforms-no-effect-shaped-exports` — **follow-up, NOT YET
  LANDED.** Intended paths: `agent-event-pipeline/transforms/**/*.ts`. Would
  block `Effect.gen`, `Effect.{succeed,fail,sync,tryPromise,promise,async}`,
  `Layer.*`, `Workflow.make`, `Activity.make`, `DurableDeferred.*`,
  `Context.{Tag,GenericTag}`. The rule pattern is drafted but did not land in
  this slice because `semgrep --test` against the existing fixture
  `semgrep-tests/dup-detection.ts` reports a phantom rule-id-mismatch
  whenever the rule is present in `.semgrep.yml`, regardless of
  `paths.include` configuration. Until landed, the purity rule is documented
  in [`transforms/README.md`](./transforms/README.md) and review-enforced.
  See the cannon doc's Executable Contract Follow-Ups for the deferred
  status.

Also note: the `tool-execution/` Shape D guard is not in this slice (it is
covered by the existing `firegrid-no-unclassified-workflow-make` and the
forthcoming Wave 2 lane that lands the tool-result/durable-completion plumbing).

Moving the Shape C handler elsewhere or making transforms construct effects
silently undoes the cutover invariants. If a cutover slice needs a different
path than this map names, update this map and the gate paths in lock step,
**not** the rule severities.
