# Runtime Physical Target Tree

Status: dispatchable architecture aid
Date: 2026-05-22
Owner: Firegrid Architecture

This document pins the target physical shape for `packages/runtime/src/`.
It operationalizes the canonical pipeline from
`docs/cannon/architecture/runtime-design-constraints.md` and
`docs/cannon/architecture/runtime-pipeline-type-boundaries.md`:

```text
events -> DurableTable(events) -> transforms(rows) -> keyed subscribers(rows)
```

The directory tree is the data flow. The ordering is logical, but directory
names are semantic. Do **not** encode ordering numbers or subscriber shape
letters into physical folder names.

This is a runtime-package target. It does not replace
`docs/architecture/host-sdk-runtime-boundary.md`: host-sdk remains the outer
host composition and public host facade. The `composition/` folder below is
runtime-local topology wiring and CI topology checks, not an excuse for
host-sdk to import mixed runtime barrels or workflow-era host internals.

## Target Tree

```text
packages/runtime/src/
│
├── README.md                         # pipeline diagram + folder pointers
│
├── engine/                           # 0. SUBSTRATE: durable workflow-execution infrastructure
│   ├── README.md                     # what the substrate is + what may import it
│   ├── durable-streams-workflow-engine.ts  # DurableStreamsWorkflowEngine.{make,layer}
│   └── internal/                     # substrate-private implementation
│       ├── engine-runtime.ts         # makeWorkflowEngine
│       ├── table.ts                  # WorkflowEngineTable + row schemas
│       ├── codec.ts                  # workflow-result codec
│       └── contract-activity.ts      # withActivityContract / annotateActivityContractSpan
│
├── events/                           # 1. WHAT crosses boundaries
│   ├── README.md                     # event vocabulary; no I/O, state, behavior
│   ├── agent-input.ts                # AgentInputEvent union + schema
│   ├── agent-output.ts               # AgentOutputEvent union + schema
│   ├── runtime-ingress.ts            # RuntimeIngressInputRow schema
│   ├── runtime-output.ts             # RuntimeEventRow / RuntimeLogLineRow schemas
│   └── runtime-context-state.ts      # RuntimeContextEventState schema
│
├── capabilities/                     # 1b. Context.Tag declarations for producer write capabilities
│   ├── README.md                     # SDD #761 — Tag-only; no Layer, no Effect bodies
│   └── (Tag declarations land in PR-M2 / PR-M3)
│
├── tables/                           # 2. WHERE durable state lives ("topics")
│   ├── README.md                     # DurableTable definitions; one table family per file
│   ├── runtime-control-plane.ts      # RuntimeControlPlaneTable
│   ├── runtime-output.ts             # RuntimeOutputTable
│   └── runtime-context-state.ts      # RuntimeContextStateStore
│
├── sources/                          # 3a. Kafka-Connect "Source" emitters (post-SDD #761)
│   ├── README.md                     # emitters; expose Stream/session — no row authority
│   ├── sandbox/                      # live process/byte/AI boundaries
│   │   ├── byte-stream.ts            # AgentByteStream
│   │   ├── local-process.ts          # LocalProcessSandboxProvider
│   │   ├── effect-ai.ts              # EffectAiSandboxProvider
│   │   └── SandboxProvider.ts        # provider contract
│   └── codecs/                       # protocol byte→event normalization
│       ├── contract.ts               # AgentSession live codec boundary
│       ├── acp/                      # ACP wire-protocol translator
│       │   ├── index.ts              #   outbound: decode bytes from spawned ACP agent
│       │   ├── mapping.ts            #   shared ACP↔runtime mapping helpers
│       │   └── stdio-edge.ts         #   inbound: translate inbound ACP stdio requests
│       │                             #     into host-plane channel-router dispatches
│       └── stdio-jsonl/
│
├── producers/                        # 3b. Kafka-broker "Producer" topic writers (post-SDD #761)
│   ├── README.md                     # journals streams into tables; behind capabilities/ Tags
│   └── (writer modules land in PR-M2 scheduled-prompt-append / PR-M3 runtime-input-append)
│
├── transforms/                       # 4. HOW rows shape into facts/actions; PURE
│   ├── README.md                     # no Effect, no R channel, no I/O
│   ├── decode-ingress-row.ts         # agentInputEventFromRuntimeIngressRow
│   ├── decode-output-row.ts          # runtimeAgentOutputObservationFromRow
│   ├── field-equals.ts               # evaluateFieldEquals + FieldEqualsTrigger
│   └── runtime-context-transition.ts # transitionInputEvent / transitionOutputEvent
│
├── channels/                         # 5. WIRE-EDGE capability boundary
│   ├── README.md                     # Ingress/Egress/Callable/Bidirectional channel rules
│   ├── host-control/
│   ├── session/
│   ├── routes/                       # channel registrations -> route projections
│   ├── runtime-host-config.ts        # RuntimeHostConfig Tag for channel live bindings
│   └── router.ts                     # HostPlaneChannelRouter / RuntimeChannelRouter
│
├── subscribers/                      # 6. WHO reacts; Shape B / C / D
│   ├── README.md                     # shape table + R-channel rules
│   ├── projections/                  # Shape B: read-only, no state
│   ├── runtime-context/              # Shape C: stateful per-event RuntimeContext handler
│   │   ├── README.md
│   │   ├── handler.ts
│   │   ├── state-ops.ts
│   │   └── action-dispatch.ts
│   ├── runtime-context-session/      # Shape C: codec-session command sink
│   │   ├── README.md
│   │   └── handler.ts
│   ├── tool-dispatch/                # Shape D: Activity memoization justified
│   │   ├── README.md
│   │   └── workflow.ts
│   ├── wait-router/                  # Shape D: durable wait/timeout justified
│   │   ├── README.md
│   │   └── workflow.ts
│   ├── scheduled-prompt/             # Shape D: DurableClock justified
│   │   ├── README.md
│   │   └── workflow.ts
│   └── runtime-control/              # Shape D: host-control request workflows
│       ├── README.md
│       ├── control-request-side-effects.ts
│       └── workflows.ts
│
├── composition/                      # 7. runtime-local topology wiring
│   ├── README.md                     # Layer graph; topology = Layer.mergeAll
│   ├── mcp-host.ts                   # host-owned localhost MCP HTTP server
│   ├── mcp-channel-metadata.ts       # MCP tools/list channel-inventory enrichment
│   ├── runtime-context-mcp-base-url.ts # late-bind of bound MCP address
│   ├── host-workflow-engine.ts       # HostWorkflowEngineLive (host-scoped engine binding)
│   ├── host-live.ts                  # runtime-owned layer graph for host-sdk to install
│   └── topology-checks.ts            # CI: shape, ownership, cycle checks
│
└── _archive/                         # wrong-shape code pending deletion
    └── workflow-engine/               # legacy folder is empty after Wave 2 and removed
        └── DEPRECATED.md             # names deletion bead/wave
```

Two non-canonical legacy folders that exist in the current tree but are
NOT part of the target shape:

- `workflow-engine/` — pending dissolution into `engine/` (substrate) +
  Shape D `subscribers/` (workflows) + per-call tool-execution Tag move
  (`tool-execution/runtime-tool-use-executor.ts` → `subscribers/tool-dispatch/`
  per existing `tf-up1v` carve-out). Once the dissolution lands, the
  folder is removed (NOT relocated to `_archive/` — `_archive/` is for
  wrong-shape code pending deletion, not for emptied directories).
- `kernel/` — pending dissolution into named leaf homes (see
  §Kernel Retirement). The `@firegrid/runtime/kernel` public subpath is
  retired in the same slice that empties the folder.

## Logical Order And Import Direction

The tree has two leaf-tier groups (no internal-to-runtime dependencies of
their own) and a single pipeline above them:

```text
SUBSTRATE     engine/
VOCABULARY    events/
PIPELINE      tables < producers / transforms / channels < subscribers < composition
```

That order is semantic and enforceable; it is not encoded with numeric folder
names. The two leaf-tier groups are sibling, not stacked: `engine/` does not
import `events/`, and `events/` does not import `engine/`. Both are
importable by pipeline tiers that need them.

- `engine/` is **substrate**: the durable workflow-execution machinery
  (`DurableStreamsWorkflowEngine` + the table/row schemas, engine runtime,
  result codec, and activity-contract span helpers that compose it). It
  imports only base libraries (`effect`), `@effect/workflow`,
  `effect-durable-operators`, and `@firegrid/protocol/otel`. It does **not**
  import any other runtime folder. It is importable by **Shape D**
  `subscribers/` folders (under their workflow-machinery README
  justification) and by `composition/`. It is **not** importable by
  `events/`, `tables/`, `producers/`, `transforms/`, `channels/`, or by
  non-Shape-D `subscribers/` folders. The substrate is `internal/`-scoped
  inside `engine/`: only `engine/durable-streams-workflow-engine.ts` is
  importable from outside `engine/`.
- `events/` imports protocol schemas and base libraries only. It does not
  import runtime state, Effects, Layers, channels, subscribers, workflow
  machinery, or `engine/`.
- `tables/` imports `events/` and protocol row schemas. It owns
  DurableTable-backed state and event tables.
- `producers/` imports `events/` and `tables/`. It owns live scoped producers
  and table append authority.
- `transforms/` imports `events/` only. Every exported transform is pure; no
  `Effect`, `Layer`, `Context.Tag`, `Workflow.make`, `Activity.make`, or
  `DurableDeferred`.
- `channels/` imports `events/` and `tables/` as needed to implement channel
  bindings and route projections. It does not own subscriber logic.
- `subscribers/` imports lower-order folders. Shape D subscribers may import
  `engine/` and `@effect/workflow` machinery only inside their own
  subfolders with a README justification.
- `composition/` imports the lower-order folders and `engine/` to build the
  runtime layer graph. It does not define business logic, durable row
  schemas, or transition behavior.

Imports from an earlier pipeline folder to a later pipeline folder are
structure violations. For example, `transforms/` must not import
`subscribers/`, and `events/` must not import `tables/`. Importing `engine/`
from outside `subscribers/` Shape D folders or `composition/` is the
substrate equivalent — disallowed at the same enforcement tier.

## Shape Rule

Subscriber shape is recorded in `subscribers/README.md` and each subscriber
folder README. It is not encoded in folder names.

```text
subscribers/projections/              Shape B: read-only projection consumer
subscribers/runtime-context/          Shape C: stateful keyed subscriber
subscribers/runtime-context-session/  Shape C: session-command sink
subscribers/tool-dispatch/            Shape D: workflow-shaped
subscribers/wait-router/              Shape D: workflow-shaped
subscribers/scheduled-prompt/         Shape D: workflow-shaped
subscribers/runtime-control/          Shape D: workflow-shaped
```

Review rules:

- Shape B: no state store, no write authority.
- Shape C: state/read/write tags allowed; no `WorkflowEngine`, no
  `WorkflowInstance`, no `Activity.make`, no parked body.
- Shape D: workflow machinery is allowed only if the README names the
  load-bearing reason: Activity memoization, durable timer, cross-execution
  handoff, or restart-safe live side effect.

## Public Package Subpaths

The semantic source tree does not mean every source folder becomes a public
package API. External consumers, including host-sdk, import only explicitly
exported narrow semantic subpaths.

When a runtime capability must be consumed outside `packages/runtime/src/`, its
public subpath should align with the semantic tree, not with historical barrels
and not with ad hoc flat names.

Preferred new public subpath shape:

```text
@firegrid/runtime/tables/runtime-context-state
@firegrid/runtime/producers/runtime-context-input-facts
@firegrid/runtime/subscribers/runtime-context
@firegrid/runtime/subscribers/runtime-context-session
@firegrid/runtime/composition/host-live
@firegrid/runtime/composition/host-workflow-engine
@firegrid/runtime/composition/mcp-host
@firegrid/runtime/composition/runtime-context-mcp-base-url
@firegrid/runtime/channels/runtime-host-config
```

`engine/` is **NOT a public subpath**. The substrate is composition-private;
host-sdk and other external consumers reach the engine through
`@firegrid/runtime/composition/host-workflow-engine`'s `HostWorkflowEngineLive`
Layer. Surfacing `engine/` as a public subpath would re-create the host-sdk
"reach into substrate" failure mode that the kernel-retirement and the
host-sdk-runtime-boundary doc (Cannon §3, §6) explicitly forbid.

Existing flat subpaths such as `@firegrid/runtime/runtime-output` may remain
until deliberately migrated, but new Shape C clean-room exports should prefer
the tree-aligned semantic shape above. Do not create public exports that expose
ordering numbers. Do not use `@firegrid/runtime/kernel` as a convenience
import for host-sdk or clean-room code; the subpath is retired in the
Kernel Retirement slice below.

## Channels And Routes

`channels/` is the runtime wire-edge capability boundary:

- channel folders define typed `IngressChannel`, `EgressChannel`,
  `CallableChannel`, or `BidirectionalChannel` services;
- `routes/` projects typed channel registrations to router routes;
- `router.ts` owns wire-edge dispatch, schema parsing, direction/verb checks,
  and route invocation.

Channels are not subscribers. Subscribers consume channel tags through their
`R` channel.

### Wire-Protocol Codecs And Process Edges

`producers/codecs/<protocol>/` houses process-owned wire-protocol translators
whose primary job is to turn external agent subprocess bytes into runtime rows
or host-plane dispatches:

- **Outbound codec** — the runtime spawned an external agent process and
  decodes its wire frames into runtime rows. Existing example:
  `producers/codecs/acp/index.ts` (decodes bytes from an ACP child agent
  into `AgentSession.outputs`).
- **Inbound edge** — an external client (Zed for ACP, an MCP-capable LLM
  client for ACP) sends wire frames into our process, and we translate them
  into `HostPlaneChannelRouter.dispatch` calls. Per PR #702, public
  clients/tools interact through the channel router only; the edge is the
  thin wire translator that turns inbound ACP/MCP/HTTP frames into typed
  router dispatches. Examples: `producers/codecs/acp/stdio-edge.ts`,
  `composition/mcp-host.ts`.

Host-owned listening surfaces that bind the channel router into an HTTP/MCP
server live in `composition/` because they assemble channel metadata, host
topology config, and server lifecycle. The MCP host is therefore
`composition/mcp-host.ts`; the ACP stdio edge remains under
`producers/codecs/acp/stdio-edge.ts` because it is a protocol subprocess edge.

Inbound edges may NOT define their own channel registrations — they project
public-router targets onto the inbound protocol shape. Adding a new
publicly-routable surface still requires a channel registration under
`channels/<family>/`. The edge translates wire frames to/from the existing
router targets.

## Composition Boundary

`composition/` is runtime-local topology wiring. It is where the runtime Layer
graph is assembled from lower-order runtime parts.

Host-sdk remains the host composition package. It may install runtime-owned
layers through narrow target subpaths, but it must not import mixed runtime
barrels such as `@firegrid/runtime/kernel` or reach into `_archive/`.

If host-sdk needs a runtime capability that is only available through a mixed
barrel today, first add a narrow semantic target subpath under runtime. Do not
import the mixed barrel from host-sdk to keep a cutover moving.

## Archive Rule

`_archive/` is not a bridge surface. It is a time-boxed holding pen for
wrong-shape code while the greenfield cutover deletes it.

Files under `_archive/`:

- are not imported by target code;
- carry a `DEPRECATED.md` naming their deletion wave or bead;
- are not elaborated with new behavior;
- are removed mechanically once the target path lands.

If a target file imports `_archive/`, the clean-room cutover has failed.

## README Contract

Each top-level folder has a `README.md` with:

1. what the folder owns;
2. which earlier folders it may import;
3. what it must not do;
4. one `DO` and one `DO NOT` example for the most common drift.

The READMEs are operational guards. They are not explanatory prose to be kept
separate from implementation.

## Topology Checks

`composition/topology-checks.ts` should grow CI checks for:

- no Shape C subscriber `R` channel mentioning `WorkflowEngine` or
  `WorkflowInstance`;
- no `transforms/` export whose type includes `Effect.Effect`;
- no two subscribers owning the same state store tag;
- no read/write feedback cycle for the same table family unless explicitly
  approved as a durable operator;
- every Shape D folder has a README with a workflow-machinery justification;
- no target code imports `_archive/`;
- host-sdk imports runtime only through narrow target subpaths.

These can start as Semgrep/AST checks. They do not require new runtime
abstractions.

## Wave 1 Application

For the current Shape C cutover:

- `RuntimeContextInputFacts` is created under `tables/` or `producers/`
  depending on whether the file defines durable read/table state or append
  authority.
- `RuntimeContextStateStore` moves under `tables/runtime-context-state.ts`.
- `transitionInputEvent` and `transitionOutputEvent` move under
  `transforms/runtime-context-transition.ts`.
- `handleRuntimeContextEvent` moves under
  `subscribers/runtime-context/handler.ts`.
- the session-command sink moves under
  `subscribers/runtime-context-session/handler.ts`.
- `ToolCallWorkflow`, `WaitForWorkflow`, and `ScheduledPromptWorkflow` move or
  remain only under Shape D subscriber folders with README justification.
- `RuntimeContextWorkflowNative`, `runtime-input-deferred`, and body-driver
  helpers move to `_archive/` only if they cannot be deleted immediately.

The preferred greenfield endpoint is deletion, not indefinite archival.
`_archive/` is a staging area for deletion, not a compatibility layer.

## Kernel Retirement

The `kernel/` folder and the `@firegrid/runtime/kernel` public subpath are
retired in a follow-up mechanical slice. After the body+kernel deletion wave
(PR #726), only four leaf symbols remain in `kernel/` and each gets a named
canonical home:

| Symbol | Current location | Canonical target home | Reason |
|---|---|---|---|
| `RuntimeHostConfig` (Tag + `RuntimeHostConfigValue` type) | `kernel/runtime-host-config.ts` | `channels/runtime-host-config.ts` | Host topology Tag consumed by channel Lives and installed by composition. `composition/` wires it but lower tiers must not import from `composition/`; `kernel/` is not part of the target tree. |
| `runtimeExecutionClock` (`Clock.make()` instance) | `kernel/runtime-context-helpers.ts` | `composition/runtime-execution-clock.ts` *(or inline at the single composition call site)* | A trivial Clock instance used only when composing host effects. Composition-private. |
| `requireLocalRuntimeContextWithHostSession` | `kernel/runtime-context-helpers.ts` | `subscribers/runtime-context/host-lookup.ts` | A `readRuntimeContext`-then-host-locality-check helper. The Shape C subscriber folder is the natural home for `RuntimeContextRead`-coupled helpers; host-sdk consumes it through a narrow target subpath (no kernel barrel). |
| `readRuntimeContext`, `runtimeContextWorkflowExecutionId` (already re-exports) | `kernel/runtime-context-helpers.ts` (re-exports from `workflow-engine/workflows/runtime-context-run.ts`) | follow their source: `subscribers/runtime-context/lookup.ts` for `readRuntimeContext`; `transforms/runtime-context-ids.ts` for `runtimeContextWorkflowExecutionId` (pure deterministic id derivation, no Effect — fits `transforms/`) | The body-driver `runtime-context-run.ts` is deleted in #726; the surviving helper functions move to the canonical home of their behavior. |

The remaining `kernel/index.ts` re-exports (`RuntimeContextWorkflowSession`,
`RuntimeContextSessionCommand*`, `makePerContextRuntimeContextStateStore`,
`RuntimeContextStateStore`, etc.) are already pure re-exports from
sanctioned target subpaths (`subscribers/runtime-context-session/` and
`tables/runtime-context-state/`). The mechanical slice deletes those
re-exports; callers migrate to the target subpaths directly (the kernel
barrel already documents the migration in its header comment).

Retirement acceptance:

1. `packages/runtime/src/kernel/` directory removed.
2. `@firegrid/runtime/kernel` public subpath removed from
   `packages/runtime/package.json` `exports`.
3. The dep-cruiser carve-out at `.dependency-cruiser.cjs:40`
   (`composition/host-workflow-engine\.ts$` exact-file allow for the
   `runtime-composition-no-legacy-tree-import` rule) shrinks to a
   deletion (engine substrate is no longer in `workflow-engine/`).
4. The `firegrid-host-sdk-no-runtime-kernel-import` Semgrep rule's
   baseline shrinks to zero on the host-sdk side as callers migrate to
   the target subpaths named above.

## Wave 2 Application

The follow-up mechanical slice — strictly file moves + import rewrites +
carve-out deletions, no behavior changes — does:

**Substrate move** (closed dep set, 5 files, sourced from PR #721 substrate
map):

```
workflow-engine/DurableStreamsWorkflowEngine.ts → engine/durable-streams-workflow-engine.ts
workflow-engine/internal/engine-runtime.ts      → engine/internal/engine-runtime.ts
workflow-engine/internal/table.ts               → engine/internal/table.ts
workflow-engine/internal/codec.ts               → engine/internal/codec.ts
workflow-engine/internal/contract-activity.ts   → engine/internal/contract-activity.ts
```

**Composition leaves**:

```
kernel/runtime-host-config.ts                   → channels/runtime-host-config.ts
kernel/runtime-context-helpers.ts:runtimeExecutionClock → composition/runtime-execution-clock.ts (or inlined)
```

**Subscriber/transforms leaves**:

```
kernel/runtime-context-helpers.ts:requireLocalRuntimeContextWithHostSession → subscribers/runtime-context/host-lookup.ts
workflow-engine/workflows/runtime-context-run.ts:readRuntimeContext         → subscribers/runtime-context/lookup.ts
workflow-engine/workflows/runtime-context-run.ts:runtimeContextWorkflowExecutionId → transforms/runtime-context-ids.ts
```

**Shape D workflow placement** (already prescribed by Wave 1 §"ToolCallWorkflow,
WaitForWorkflow, and ScheduledPromptWorkflow move or remain only under Shape D
subscriber folders"):

```
workflow-engine/workflows/tool-call.ts          → subscribers/tool-dispatch/workflow.ts (or merged into existing handler file)
workflow-engine/workflows/wait-for.ts           → subscribers/wait-router/workflow.ts
workflow-engine/workflows/scheduled-prompt.ts   → subscribers/scheduled-prompt/workflow.ts
workflow-engine/workflows/runtime-control-request.ts → subscribers/runtime-control/workflows.ts
workflow-engine/workflows/runtime-ingress-transform.ts → transforms/runtime-ingress-transform.ts (it's already a pure transform; check no Workflow imports)
workflow-engine/tool-execution/runtime-tool-use-executor.ts → subscribers/tool-dispatch/runtime-tool-use-executor.ts (per existing tf-up1v carve-out)
```

After the Shape D moves, the substrate move, and the kernel-leaf moves,
`workflow-engine/` and `kernel/` are both empty. They are removed (not
relocated to `_archive/`; `_archive/` exists for wrong-shape code pending
deletion, not for emptied directories).

**Carve-outs that shrink to deletions**:

- `.dependency-cruiser.cjs:40` — `composition/host-workflow-engine\.ts$`
  exact-file allow in `runtime-composition-no-legacy-tree-import`.
- `.dependency-cruiser.cjs:106, 220, 233, 246, 259` — the
  `^packages/runtime/src/workflow-engine/` regex hits in the per-tier
  `runtime-{tables,producers,channels,subscribers}-no-legacy-tree-import`
  rules (each was bead-owned: `tf-up1v`, `tf-hpr0`, `tf-6hqx`, `tf-vfq9`,
  `tf-6cdy`).
- `host-sdk-runtime-import-baseline.json` — kernel-import entries on
  host-sdk side reach zero as host-sdk callers retarget to the new
  target subpaths.

The slice is mechanical because every move is straight `git mv` + import-string
rewrite. No behavior change; no Layer composition change; no schema change.

Dispatch order within Wave 2: substrate move first (lowest tier, no
internal-runtime deps); composition leaves second (RuntimeHostConfig +
runtimeExecutionClock); Shape D workflow moves third (one-at-a-time per
bead); kernel-helper moves last; kernel/ and workflow-engine/ folder removals
+ public-subpath removal last.
