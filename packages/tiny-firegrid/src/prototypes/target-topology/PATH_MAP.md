# Production rewrite path map (tf-1r0o)

Concrete mapping from each prototype module to the production path the rewrite
should land in. Production already has `packages/runtime/src/agent-event-pipeline/`
with `authorities/ codecs/ events/ sources/ subscribers/ transforms/` — the
target topology is largely **renaming and re-homing existing code**, not net-new
structure. The cannon doc's "Current Code Mapping" table is the type-level
source; this is the path-level source.

Legend: **move** = relocate existing code; **rename** = same code, shape-named
folder; **keep** = already in the right place; **delete** = bridge code retired.

## events/

| Prototype | Production target | Action |
|---|---|---|
| `events/index.ts` (`RuntimeContext`, `RuntimeContextTargetEvent`) | `packages/runtime/src/agent-event-pipeline/events/` | keep/extend — event union is the C2 reducer input; identity stays runtime-owned |
| (imported) `RuntimeEventRow` | `@firegrid/protocol/launch` | keep in protocol — **must not move into runtime** |
| (imported) `RuntimeIngressInputRow` | `@firegrid/protocol/runtime-ingress` | keep in protocol — **must not move into runtime** |

## tables/

| Prototype | Production target | Action |
|---|---|---|
| `tables/runtime-context-state-store.ts` | `packages/runtime/src/workflow-engine/runtime-context-state.ts` → re-home under `agent-event-pipeline/authorities/` | move — this is the Shape C state-of-record |
| `tables/runtime-output-table.ts` (`*Read`/`*Write`) | `tables/runtime-output.ts` (read) + `producers/ingress-writers/per-context-output-writer` (write) | keep — already split by polarity in prod |

## producers/

| Prototype | Production target | Action |
|---|---|---|
| `producers/agent-session.ts` | `agent-event-pipeline/codecs/contract.ts` (`AgentSession`) + `sources/byte-stream.ts` | keep — Shape A live boundary |
| `producers/tool-use-executor.ts` | `packages/runtime/src/workflow-engine/tool-execution/` + `subscribers/tool-dispatch/` | keep |

## transforms/

| Prototype | Production target | Action |
|---|---|---|
| `transforms/transitions.ts` (`transitionInputEvent`, `transitionOutputEvent`, …) | `packages/runtime/src/workflow-engine/workflows/runtime-context.ts` (the pure transition fns) → re-home under `agent-event-pipeline/transforms/` | move — extract the pure reducers out of the workflow body file |
| (also) `field-equals`, `runtime-ingress-transform` | `workflows/field-equals.ts`, `workflows/runtime-ingress-transform.ts` → `transforms/` | move — already pure |

## channels/

| Prototype | Production target | Action |
|---|---|---|
| `channels/index.ts` contracts (`IngressChannel`/`EgressChannel`/`ChannelTarget`/`ChannelRouteCompletion`) | `packages/protocol/src/channels/core.ts` | keep in protocol — **must not move into runtime** |
| `HostPromptChannel`, `SessionAgentOutputChannel` service tags | `packages/runtime/src/channels/` (`session-agent-output.ts`, host-control routes) | keep — host wiring of protocol contracts |
| (router) | `packages/runtime/src/channels/router.ts` + `@firegrid/protocol/channels/router` | keep |

## subscribers/

| Prototype | Production target | Action |
|---|---|---|
| `subscribers/shape-b/projection-consumer.ts` | `agent-event-pipeline/subscribers/` (consumers of `RuntimeAgentOutputAfterEvents`) | keep |
| `subscribers/shape-c/runtime-context-subscriber.ts` | `packages/runtime/src/workflow-engine/workflows/runtime-context.ts` (`RuntimeContextWorkflowNative`) → **rewrite** as per-event keyed handler under `agent-event-pipeline/subscribers/runtime-context/` | **rewrite** — the one wrong-shape D→C move; tracked by `tf-tvg1`/`tf-vrz6`/`tf-w6qj` |
| `subscribers/shape-d/tool-call-workflow.ts` | `packages/runtime/src/workflow-engine/workflows/tool-call.ts` (`ToolCallWorkflow`) | keep — already correctly shaped D |

### Deletions the rewrite enables (bridge code, not target)

| Production path | Action | Why |
|---|---|---|
| `packages/runtime/src/workflow-engine/runtime-input-deferred.ts` | delete | per-sequence `DurableDeferred` input mailbox (C4 bridge) |
| `RuntimeContextWorkflowNative` context-lifetime body in `workflows/runtime-context.ts` | delete the loop, keep the transitions | parked entity body (C2/C5 bridge) |
| any engine-level suspended-workflow recovery sweep / write+arm bridge | delete | C5 — no parked body to re-arm in target |

## composition/

| Prototype | Production target | Action |
|---|---|---|
| `composition/host-live.ts` (`Layer.mergeAll`) | the host app's root layer (e.g. `packages/host-sdk` host composition / `run(...)` wiring) | keep — topology stays a Layer graph |
| `composition/negative-examples.ts` | becomes the C2/C6 drift guards under `tf-zchu` (CI-enforced) | promote — the `@ts-expect-error` shape proofs become executable contract tests |

## Net

The production rewrite is: **(1)** re-home the pure transitions and the state
store from `workflow-engine/` into `agent-event-pipeline/transforms/` +
`authorities/`; **(2)** rewrite the single wrong-shape D body
(`RuntimeContextWorkflowNative`) as a Shape C per-event subscriber that loads
state, runs the transition, saves, and dispatches via channel tags; **(3)**
delete the input mailbox / parked-body / write+arm bridge code the rewrite
obsoletes. Protocol-owned schemas and the correctly-shaped D workflows
(`ToolCallWorkflow`, `WaitForWorkflow`, `ScheduledPromptWorkflow`) stay put.
