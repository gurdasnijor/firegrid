# Host SDK / Runtime Boundary Framing

Status: active

Date: 2026-05-22

Branch: `rearch/shape-c-cutover` (operating-plan Wave 1 = roadmap Waves A→E)

## Purpose

The 2026-05-20 version of this doc framed the package boundary as composition
vs. substrate. The Shape C cutover makes that boundary executable: the runtime
substrate is mapped onto the four subscriber shapes (`runtime-pipeline-type-boundaries.md`),
and the constraints doc (`runtime-design-constraints.md`) names which shapes
need workflow machinery and which do not.

This revision aligns the host-sdk / runtime boundary against today's
**greenfield + Shape C/D framing**. It is operational guidance for lane
dispatch on `rearch/shape-c-cutover`, not a new SDD.

Inputs:

- `docs/cannon/architecture/runtime-pipeline-type-boundaries.md` — Shape A/B/C/D, channels as wire-edge capability.
- `docs/cannon/architecture/runtime-design-constraints.md` — C1–C7 + SDD gate.
- `docs/architecture/2026-05-22-runtime-physical-target-tree.md` — **runtime-package physical target tree**: semantic folder names under `packages/runtime/src/` (`events/`, `tables/`, `producers/`, `transforms/`, `channels/`, `subscribers/`, `composition/`, plus `_archive/`). Numeric prefixes are forbidden at the runtime root and rejected by `scripts/runtime-public-surface-check.mjs`. This boundary doc does **not** recreate that tree; it references it.
- `docs/architecture/2026-05-22-shape-c-cutover-operating-plan.md` — greenfield rules, deletion-with-proof, test triage protocol.
- `docs/architecture/2026-05-22-shape-c-cutover-roadmap.md` — Wave A (placement) → B (runtime root assembly) → C (host-sdk cutover + turn proof) → D (paired deletion) → E (surface shrink + guard ratchet) dispatch waves.
- `docs/architecture/2026-05-22-shape-c-cutover-baseline.md` — line/module baseline groups.
- Landed scaffold + Wave A: #689 (semantic scaffold + Wave 1 forward-target exports + host-sdk import gate), #690 (input-facts read-side → `tables/`), #691 (RuntimeContextWorkflowSession → `subscribers/runtime-context-session/`), #692 (RuntimeContextStateStore → `tables/`), #693 (roadmap), #694 (Shape C handler → `subscribers/runtime-context/`), #695 (pure transitions/decoders → `transforms/`), #696 (folder-direction dep-cruiser + symbol-ban semgrep guards).

## Cannon (2026-05-22)

These statements settle ambiguities the Shape C cutover surfaced. They override
any 2026-05-20-era guidance in this document that conflicts.

1. **`AgentSession` is live codec/session-scoped — never ambient Shape C `R`.**
   `AgentSession` is built by `AcpSessionLive` / `StdioJsonlSessionLive` from
   an `AgentByteStream` and is **scoped inside the host's `runtime-context`
   session-command adapter** (the live half behind `RuntimeContextWorkflowSession`).
   It is Shape A by construction (scoped live transport). It must not appear
   in a Shape C subscriber's `R` channel, in the host root Layer's ambient
   context, or in any handler boundary signature. Code that needs to talk to
   the live agent does so by `send(context, attempt, command)` on the
   durable-side session-command sink — never by holding `AgentSession`
   directly.

2. **`RuntimeContextWorkflowSession` is the narrow session-command sink — despite the legacy "Workflow" in its name.**
   It is the durable-plane inversion seam between the Shape C handler boundary
   and the host-sdk-provided live session adapter (`startOrAttach` +
   `send(context, attempt, command)`). It is not a workflow surface, does not
   require workflow machinery in callers' `R`, and is the correct tag to thread
   through the handler. The name reflects history, not shape; renaming is a
   future cosmetic — the contract is already Shape C compatible (see PR #686
   `ce07139c8`, the AgentSession → RuntimeContextWorkflowSession swap).

3. **`@effect/workflow` imports inside `packages/host-sdk/` are bridge residue.**
   The only sanctioned home for `Workflow.make`, `Activity.make`,
   `DurableDeferred`, and `DurableClock` is a runtime-owned Shape D layer with
   a justified workflow-machinery rationale (per the SDD gate in
   `runtime-design-constraints.md`). A new host-sdk `@effect/workflow` import
   is not admissible without that justification; existing ones are residue to
   delete, not patterns to copy. Current residue lives in `commands.ts`,
   `agent-tool-host-live.ts`, `runtime-context-workflow-support.ts`, and
   `runtime-context-session/codec-adapter.ts`; each must move into a justified
   Shape D runtime layer or be deleted in roadmap Wave C (host-sdk cutover)
   or Wave D (paired deletion).

4. **Two composition tiers: runtime-internal `composition/` (Wave B) vs the outer host facade in `packages/host-sdk/src/host/` (Wave C).**
   The runtime tree's `packages/runtime/src/composition/` is **runtime-local
   topology wiring**: the assembled Layer graph over `tables/`, `producers/`,
   `channels/`, `subscribers/`, and justified Shape D Layers, plus topology
   checks. Its primary artifact is `composition/host-live.ts` (roadmap §Wave B).
   `packages/host-sdk/src/host/` is the **outer host facade** that installs
   the runtime root through a narrow tree-aligned subpath (e.g.
   `@firegrid/runtime/composition/host-live`, once Wave B exports it) and
   wires the host-bound pieces around it. It keeps its public entrypoint names
   (`FiregridRuntimeHostLive`, `layers.ts`, `types.ts`, `mcp-host.ts`, etc.)
   where they remain useful; contents that don't match the rebuilt target
   shape are deletion/move candidates per the operating plan, not legacy code
   to keep importing from. `host-sdk` owns clean composition and adapters —
   composing runtime-owned capability tags and channel Layers, presenting
   MCP/Effect-AI tool bindings over protocol schemas, selecting Node/
   local-process options, and providing live Layers for runtime-owned
   inversion seams (`RuntimeContextWorkflowSession`, `RuntimeToolUseExecutor`).
   It does not own workflow execution, durable tables, agent-event-pipeline
   subscribers, or per-event handler bodies. Host-sdk installs the runtime
   layer graph; it does not duplicate it.

5. **The clean-room host composition replaces PR #685 by nuke/scaffold/move within `host-sdk/`, not by repairing the legacy knot in place.**
   `[SUPERSEDED-BY-CLEAN-ROOM] shape-c: host-composition swap + input-facts
   fused prototype` (#685) attempted to repair the legacy
   `runtime-context-session` / codec-adapter knot in place. The cutover
   roadmap (Wave B `composition/host-live.ts` runtime root → Wave C host-sdk
   cutover + public turn proof) instead builds the target-shape runtime root
   in `packages/runtime/src/composition/`, retargets host-sdk entrypoints
   through the narrow public subpath, and deletes the wrong-shape files
   that the proof made unreachable in the same PR (roadmap §Wave C).
   Public entrypoint names in `packages/host-sdk/src/host/` are preserved
   where they are still useful; the wrong-shape internals are not.

6. **Rebuilt host files import only narrow runtime target subpaths — never mixed runtime barrels, never `_archive/`.**
   The runtime physical tree is governed by
   `docs/architecture/2026-05-22-runtime-physical-target-tree.md` with
   **semantic** folder names (`events/`, `tables/`, `producers/`, `transforms/`,
   `channels/`, `subscribers/`, `composition/`, plus `_archive/`). Numeric
   prefixes at the runtime root are forbidden and rejected by
   `scripts/runtime-public-surface-check.mjs`. Sanctioned imports from
   `host-sdk` are the narrow capability subpaths the tree exposes:
   - **Tree-aligned semantic subpaths** (preferred, post-Wave A):
     `@firegrid/runtime/tables/runtime-context-state`,
     `@firegrid/runtime/tables/runtime-context-input-facts`,
     `@firegrid/runtime/subscribers/runtime-context-session`, and any other
     tree-aligned subpath that Wave A/B exports.
   - **Existing flat subpaths** (kept until deliberately migrated):
     `@firegrid/runtime/channels`, `/tool-executor`, `/control-plane`,
     `/runtime-output`, `/per-context-output`, `/agent-adapters`,
     `/sources/sandbox`, `/codecs`, `/session-byte-stream-adapter`,
     `/verified-webhook-ingest`, `/events`, `/streams`, `/errors`, and
     `/workflows` **for installing already-defined Layers only** — not
     `Workflow.make` / `Activity.make`.
   Forbidden from `host-sdk`:
   - `@firegrid/runtime/kernel` — privileged durable execution core; the
     inversion-seam pattern exists specifically to keep it hidden. Existing
     kernel-barrel sites are baselined as legacy debt (#689); they shrink as
     host-sdk callers migrate to the tree-aligned subpaths above.
   - The `@firegrid/runtime` **root barrel** — widens the surface beyond
     what the boundary admits.
   - **Any "mixed runtime barrel"** (the tree doc's term) that pulls
     unrelated Shape D / kernel surfaces into one import.
   - **`@firegrid/runtime/_archive/`** — `_archive/` is a time-boxed
     deletion staging area, not a bridge surface (tree doc §"Archive Rule").
   - **Numeric `^N-` runtime subpaths** — the target tree is semantic; any
     `@firegrid/runtime/1-events` / `/2-tables` / etc. import is wrong shape.
   Dependency-cruiser + Semgrep guards land per #689 / #696:
   `packages/host-sdk/** -/-> @firegrid/runtime/kernel`,
   `packages/host-sdk/** -/-> @firegrid/runtime$`,
   `packages/host-sdk/** -/-> @firegrid/runtime/_archive`,
   `firegrid-no-numbered-runtime-subpath`.

7. **Greenfield: delete or replace wrong shape; do not build compatibility bridges.**
   Firegrid has no production user state to preserve. When a Shape C/D
   replacement lands, the wrong-shape code it makes unreachable is deleted in
   the same PR (operating plan §"Wave 2"). If deleting a wrong-shape module
   exposes a missing target capability, build the target capability directly —
   do not add a bridge layer to keep the old shape alive (operating plan
   §"Operating Rules For Lanes"). Bridge exceptions require the gate in
   `runtime-design-constraints.md` §"SDD Gate".

## Decision

The firewall is **schema catalog → bindings → execution substrate**, with
channels as the application/agent-facing firewall inside the binding layer:

```text
@firegrid/protocol
  schema catalog, operation contracts, row/projection schemas, channel
  capability contracts (IngressChannel/EgressChannel/CallableChannel/
  BidirectionalChannel + ChannelTarget + ChannelRouteCompletion).
  no runtime execution, no workflow definitions.

bindings
  @firegrid/client-sdk   browser/app-safe client over protocol
  @firegrid/agent-tools  MCP / Effect-AI tool projection over protocol
  future @firegrid/cli / @firegrid/rest / @firegrid/grpc / @firegrid/jsonrpc
  @firegrid/host-sdk     host composition facade (Cannon §4)

@firegrid/runtime
  execution substrate: Shape A live boundaries (codec/sandbox), Shape B
  projections, Shape C keyed handlers (e.g. RuntimeContext), Shape D
  justified workflow subscribers (ToolCall, WaitFor, ScheduledPrompt).
```

Channels (`runtime-pipeline-type-boundaries.md` §"Channels As The Wire-Edge
Capability Boundary") are the typed capability handles between the durable
substrate and ACP / MCP / CLI / HTTP edges. The host SDK may compose channel
Layers; it must not make workflow handles, workflow execution ids, stream
URLs, table CDC details, durable wait stores, or engine services part of the
application model.

## Boundary Rule Under Shape C/D

The 2026-05-20 "composition boundary, not substrate owner" rule still holds.
The Shape framing makes the test mechanical via the subscriber's `R` channel:

| Subscriber shape | Where it lives | Why |
|---|---|---|
| Shape A (codec-bound: `AgentSession`, `AcpSessionLive`, `AgentByteStream`, sandbox providers) | `runtime` (implementation), `host-sdk` (composition only) | scoped live transport; `AgentSession` is never ambient (Cannon §1) |
| Shape B (projection consumers reading typed observation sources) | wherever the consumer lives; the source belongs in `runtime` | read-only, owns no state |
| Shape C (stateful keyed subscriber, no workflow machinery — `RuntimeContext`) | `runtime` (handler + state store); `host-sdk` provides the live session adapter Layer via `RuntimeContextWorkflowSession` | the handler's `R` must not contain `WorkflowEngine` |
| Shape D (workflow-shaped — `ToolCallWorkflow`, `WaitForWorkflow`, `ScheduledPromptWorkflow`) | `runtime` (workflow definition + register Layer); `host-sdk` may install via composition | needs the SDD's workflow-machinery justification (Cannon §3) |

**Decision test:**

- If `R` mentions `WorkflowEngine` / `WorkflowInstance`, the module is Shape D
  and lives in `runtime` with a workflow-machinery justification. Host-sdk
  installs its Layer; host-sdk does not define it.
- If a module owns durable state, agent-event-pipeline subscribers,
  table/stream authority, replay behavior, runtime output/session adapters,
  or control-plane dispatch, it belongs in `runtime`.
- If a module defines a semantic binding, channel, MCP/tool projection, host
  config DTO, or public host Layer entrypoint — and does not touch the
  substrate categories above — it can live in `host-sdk`.

## Package Roles

### `@firegrid/protocol`

Owns operation / channel / row / observation schemas, channel capability
contracts, `ChannelTarget`, and `ChannelRouteCompletion`. Does not own live
Layers, workflow definitions, MCP server construction, Effect-AI `Tool` values,
runtime adapter sessions, or host topology.

### `@firegrid/host-sdk`

Owns binding and composition. Concretely:

- public host construction (e.g. `FiregridRuntimeHostLive`, config-to-Layer adapters);
- host-author composition of channel Layers;
- channel binding modules whose public surface is a semantic channel
  (`event-channel`, `state-changes-channel`, `human-channel`, `session-log`,
  `channels/session-self/*`);
- MCP server exposure and metadata projection (`mcp-host`);
- Effect-AI tool binding (protocol schemas → `Tool`/`Toolkit`);
- Node/local-process topology selection;
- **live Layers for runtime-owned inversion seams**: `RuntimeContextWorkflowSession`
  (`RawRuntimeContextWorkflowSessionLive`, `CodecRuntimeContextWorkflowSessionLive`),
  `RuntimeToolUseExecutor`. These are host-bound implementations of runtime-owned
  tags; they do not import `@effect/workflow` (Cannon §3).

It does not own as stable architecture (any current instances are residue per
Cannon §3 or knot per Cannon §5):

- `Workflow.make` / `Activity.make` / `DurableDeferred` / `DurableClock`;
- workflow-engine lifecycle caches or execution registries;
- agent-event-pipeline subscribers that implement runtime behavior;
- direct table CDC handling except inside a channel binding adapter whose
  public surface stays semantic;
- common operation execution that multiple bindings could share (moves to
  runtime).

### `@firegrid/runtime`

Owns the execution substrate, organized by Shape A/B/C/D
(`runtime-pipeline-type-boundaries.md` §"Physical Tree Guidance"):

- workflow engine implementation;
- Shape D workflow definitions: `ToolCallWorkflow`, `WaitForWorkflow`,
  `ScheduledPromptWorkflow`, and any others that justify the workflow-machinery
  gate;
- Shape C subscribers (target `RuntimeContext` keyed handler + state store);
- Shape B projection sources (`RuntimeAgentOutputAfterEvents`, channel
  ingress factories like `sessionAgentOutputChannel`);
- Shape A internals (`AcpSessionLive`, `StdioJsonlSessionLive`,
  sandbox providers, byte-stream codecs);
- runtime event pipeline, authorities, verified-webhook ingestion.

It does not own user-facing SDK methods, MCP tool descriptions, CLI commands,
app-specific channel inventory decisions, or host-author convenience wrappers.

### `@firegrid/client-sdk`

Browser/app-safe client over protocol schemas + normalized observations.
Runtime-source-free. Depends only on protocol + supplied transport.

### Projection Packages

`@firegrid/client-sdk`, `@firegrid/agent-tools`, future
`@firegrid/cli|rest|grpc|jsonrpc`. They own transport glue and surface-specific
ergonomics over protocol contracts, never independent schemas or operation
catalogs.

Dependency guardrails (enforced by dependency-cruiser):

```text
projection package -> @firegrid/protocol
projection package -/-> another projection package
projection package -/-> @firegrid/runtime
@firegrid/runtime -> @firegrid/protocol
@firegrid/runtime -/-> projection packages
@firegrid/host-sdk -/-> @effect/workflow            (Cannon §3)
@firegrid/host-sdk -/-> @firegrid/runtime/kernel    (Cannon §6)
@firegrid/host-sdk -/-> @firegrid/runtime$          (Cannon §6 — root barrel forbidden)
@firegrid/host-sdk -/-> @firegrid/runtime/_archive  (Cannon §6 — archive is not a bridge)
```

Sanctioned subpaths are governed by the runtime tree doc
(`docs/architecture/2026-05-22-runtime-physical-target-tree.md`).
`@firegrid/runtime/workflows` is allowed **for installing Layers only**
(no `Workflow.make` / `Activity.make` from `host-sdk`).

## Runtime → Host Inversion (Shape C-Compatible)

When runtime execution needs something host-bound, invert the dependency with a
**runtime-owned capability tag** and a **host-sdk-provided live Layer**. This is
`RuntimeToolUseExecutor` and `RuntimeContextWorkflowSession` today.

```text
runtime Shape C / Shape D subscriber
  -> requires RuntimeOwned* Tag (runtime-owned)
  -> host-sdk provides RuntimeOwned*Live (host-bound implementation)
```

Forbidden recoveries: moving host composition into runtime, letting runtime
import `host-sdk`, or making `AgentSession` ambient in the Shape C handler's
`R` (Cannon §1). The inversion is the only sanctioned shape.

## Wave Dispatch Guidance (per roadmap #693)

The cutover roadmap subdivides operating-plan Wave 1 into:

- **Wave A — artifact placement** into the semantic target tree
  (`tables/`, `producers/`, `transforms/`, `channels/`, `subscribers/`).
  Landed: #690, #691, #692, #694, #695. Guards landed: #696.
- **Wave B — runtime root assembly** at
  `packages/runtime/src/composition/host-live.ts`. Open.
- **Wave C — host-sdk cutover + public turn proof**: retarget host-sdk
  entrypoints through the runtime root's public subpath, prove
  `start context → send input → observe output → terminate` end-to-end,
  delete the old host-sdk RuntimeContext body launch path. Open.
- **Wave D — behavior proofs with paired deletion** for input delivery,
  tool calls, permissions, wait/child-output, restart/idempotency. Open.
- **Wave E — public surface shrink + guard ratchet**.

For lanes touching this boundary:

1. **Shape C `RuntimeContext` handler reshape (Wave A)** — runtime owns the
   handler under `subscribers/runtime-context/` (#694); host-sdk provides only
   the `RuntimeContextWorkflowSession` live adapter via the inversion seam.
   Old `RuntimeContextWorkflowNative` body deleted with the proof that makes
   it unreachable (Wave C).
2. **Runtime root assembly (Wave B)** — assemble the runtime Layer graph at
   `packages/runtime/src/composition/host-live.ts` over `tables/`,
   `producers/`, `channels/`, `subscribers/`, and justified Shape D Layers.
   Do not define schemas, transitions, handlers, workflow bodies, session
   behavior, or table operations in `composition/` (roadmap §Wave B).
3. **Host composition (Wave C)** — rebuild `packages/host-sdk/src/host/`
   around the new runtime root subpath; preserve public entrypoint names
   where useful; delete what the turn proof makes unreachable in the same
   PR. Replaces #685 (Cannon §4 + §5).
4. **Workflow definitions stay in runtime** — `ToolCallWorkflow`,
   `WaitForWorkflow`, `ScheduledPromptWorkflow` keep their runtime homes and
   workflow-machinery justifications. Shape D paired-deletion lanes land in
   Wave D.
5. **Channel bindings reviewed per Shape** — if a host-sdk channel module wraps
   a runtime tag/table into a semantic channel, it stays host-sdk; if it
   implements durable execution, the implementation moves to runtime.
6. **Dependency / Semgrep guards land with the change** — the dep-cruiser
   `@firegrid/host-sdk -/-> @effect/workflow` rule lands with the slice that
   retires the last residue site (Cannon §3). Folder-direction +
   symbol-ban guards for the new tree landed in #696; new guards extend
   that file as Wave C/D shrinks the legacy import surface.

Do not dispatch "move all of `packages/host-sdk/src/host/` into runtime." That
mixes composition, channel bindings, MCP edge, and workflow substrate in one
unsafe change. Per-lane Shape C/D classification is the safer cut.

## Specific Placements

| Surface | Shape / tier | Decision |
|---|---|---|
| `RuntimeContextWorkflowSession` (tag) + live Layers | runtime tag, host-sdk live | Cannon §2. Threaded into Shape C handler `R`; live adapters in host-sdk. |
| `AgentSession`, `AcpSessionLive`, `StdioJsonlSessionLive`, `AgentByteStream` | Shape A, runtime | Cannon §1. Scoped live; never ambient in host root. |
| `RuntimeContext` handler (replacing `RuntimeContextWorkflowNative` body) | Shape C, runtime | Per-event keyed subscriber over `RuntimeContextStateStore`. No `WorkflowEngine` in `R`. |
| `ToolCallWorkflow`, `WaitForWorkflow`, `ScheduledPromptWorkflow` | Shape D, runtime | Workflow-machinery justified per SDD gate. |
| `sessionAgentOutputChannel`, `sessionAgentOutputObservationRoute`, `makeRuntimeChannelRouter` | runtime (substrate), host-sdk composes | C6 typed source + cursor + match. No parallel `ChildOutput*` / `session_read`. |
| `RuntimeToolUseExecutor` | runtime tag, host-sdk live | Existing inversion seam; pattern for future host-bound needs. |
| `host-sdk/src/host/commands.ts`, `agent-tool-host-live.ts`, `runtime-context-workflow-support.ts`, `runtime-context-session/codec-adapter.ts` | bridge residue | Cannon §3. Move each `@effect/workflow` import into a justified Shape D runtime layer or delete in the slice that retires its consumer. |
| MCP server / Effect-AI toolkit | host-sdk | Pure binding/projection over protocol. |
| Durable Streams substrate access | runtime | Provider internals; consumers go through narrow tags or channel bindings. |
| Verified webhook ingestion | runtime impl; host-sdk channel binding | Signature verification + durable insert in runtime; semantic `Channel<…>` in host-sdk. |

## Risk Surface — Anti-Patterns To Reject

- Adding any new `@effect/workflow` import in `packages/host-sdk/src/` (Cannon §3).
- Threading `AgentSession` through a Shape C handler `R` (Cannon §1).
- Repairing the legacy `runtime-context-session` / codec-adapter knot in place rather than replacing it clean-room (Cannon §5).
- Adding a bridge layer "to keep the old shape working" instead of deleting the wrong shape with its replacement (Cannon §7 + operating plan §"Wave 2").
- Importing `@firegrid/runtime/kernel` from `host-sdk`, importing the `@firegrid/runtime` root barrel, or importing any mixed runtime barrel (Cannon §6).
- Importing `@firegrid/runtime/_archive/` from `host-sdk` — `_archive/` is a time-boxed deletion staging area, not a bridge (Cannon §6 + tree doc §"Archive Rule").
- Treating `host-sdk/src/host/` as a legacy import target — its current contents are deletion/move candidates, not stable substrate to depend on (Cannon §4).
- Recreating the runtime numbered tree inside `host-sdk/` — the runtime physical layout is owned by the tree doc; host-sdk consumes the published subpaths, it does not mirror the tree.
- Introducing a parallel `ChildOutput*` / `session_read` / `DurableOutputCursor` family for child observation (already blocked by tf-zchu Semgrep C6 guard).
- Synthesizing terminal completion at an edge from raw `TurnComplete` (already blocked by tf-zchu Semgrep C7 guard).

## Non-Goals

- No file-by-file move list.
- No compatibility shims for workflow handles or registries.
- No new SDD. This is operational guidance; the SDD gate lives in
  `runtime-design-constraints.md`.
- No renaming pass for `RuntimeContextWorkflowSession` in the current cutover
  branch (Cannon §2 notes the cosmetic; the shape is already correct).
