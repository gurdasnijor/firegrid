# Firegrid Cannon

Doc-Class: dispatchable
Status: active
Date: 2026-05-21

`docs/cannon/` is the compact canonical reading set for the current Firegrid
architecture. Older docs elsewhere in `docs/` remain useful evidence and
history, but they are not canonical unless listed here.

**This index is the dispatch allowlist.** Per
`docs/contributing/docs-taxonomy-and-lifecycle.md`, a doc is `dispatchable` (or
an active `internal-contract`) only if it is linked here. Everything else under
`docs/` is `historical-reference` by default, even when it looks current.
Coordinators and lanes dispatch only from documents reachable through this file.

The misspelled directory name `cannon` is intentional because that is the
requested path for this curation pass.

## What Shipped (2026-05-21)

This session closed the channel surface that earlier curation passes were
waiting on. The following are now landed on `main` and are the architecture this
index anchors to:

- **Host-plane channel router** — `tf-9x11`/#591 (router cutover), SDD
  `tf-rd3d`/#590. Channels bind to contracts through a typed router; edge
  surfaces (ACP/MCP/CLI/HTTP) dispatch over its derived string view.
- **ACP edge router cutover** — `tf-csr0`/#596, `tf-p1aw`/#597. The ACP edge is
  a router edge, not a bespoke transport.
- **Durable sync/async production semantics** — `tf-1r3h`/#587. Synchronous and
  asynchronous channel calls are closed under the durable engine.
- **Channel-boundary enforcement** — `tf-bffo`/#589. Public surface narrowed;
  host-sdk durable wiring relocated into the runtime; channels are the only
  above-box doorway.
- **Phase 0 target firelab reference** — `tf-3w1e`/#604 (framing),
  reconciled `tf-qnq9`/#588. The clean-room, API-compatible specimen of the
  target host/runtime shape: edge → channel router → host kernel workflow →
  workflow-owned durable resources → child session workflows. It is the review
  oracle production migrations compare against, not a parallel API. Phase 0A is
  the host/session resource + router baseline; **Phase 0B** identified the
  replay-amplification failure class and shipped a dense-stream cursor bridge.
  The target replacement is a sparse workflow-owned output transition log: the
  runtime body consumes only semantic transition triggers, not raw text chunks.
- **Workflow-identity admission guard** — `tf-gomx`/#611. A static `Workflow.make`
  inventory plus a CI gate (the `firegrid-no-unclassified-workflow-make` rule in
  `.semgrep.yml`): new production workflow identities must be owner-shaped and
  SDD-justified. Operation-shaped workflows already in production are migration
  debt, not precedent (feature `firegrid-workflow-driven-runtime.WORKFLOW_ADMISSION`).

Docs that contradict this shipped state are historical (see the "Explicitly
Non-Canonical Or Historical" section below). The canonical
`architecture/current-convergence-assessment-2026-05-20.md` still holds for the
host-sdk substrate-debt scoreboard, but its convergence narrative predates this
session's channel-router/ACP-edge close; read it together with the shipped list
above.

## How To Read This Tree

Read in this order:

1. `../contributing/docs-taxonomy-and-lifecycle.md` — how to read every other
   doc: which are dispatchable, which are historical.
2. `architecture/host-sdk-runtime-boundary.md`
3. `architecture/transactional-cutover-rule.md`
4. `architecture/current-convergence-assessment-2026-05-20.md`
5. `sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md`
6. `architecture/runtime-design-constraints.md` — the active runtime
   stop-condition applying the Stream-First Agent Substrate RFC to the runtime
   shrink: keyed durable state, event/state handlers, durable completions /
   externally resolved waits, typed source observations, and strict bridge
   exceptions. This document has priority when older workflow-engine-centered
   cannon would otherwise justify adding replay/cursor/mailbox surface area.
7. `architecture/fluent/architecture.md` — the canonical high-level boundary
   map for the fluent workstream: deployment topology, fluent-firegrid vs
   fluent-runtime, stream read/write ownership, schema ownership, and the rule
   that authored code and raw harnesses do not write Durable Streams directly.
8. `../sdds/SDD_FLUENT_HARNESS_ADAPTER_CONTRACT.md` — the active adapter
   boundary contract: external harness owns the native loop; adapter records
   Layer 1 observation and native protocol fidelity; fluent-runtime records
   Layer 2 coordination commitments.
9. `architecture/runtime-pipeline-type-boundaries.md` — the Effect type-boundary
   companion to the runtime constraints: codec-only sessions, typed durable
   output observation, stateful RuntimeContext subscribers, and
   workflow-shaped tool subscribers.
10. `sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md`
11. `../sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md` — the channel router that
   shipped this session (router/ACP-edge cutover).
12. `../sdds/SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md` — the Phase 0
   target host/runtime shape the migrations converge toward.
13. `architecture/kernel-owned-write-arm.md` — the empirically grounded
   write+arm ownership rule. Important: `HostKernelWorkflow` is a target role,
   not an existing implementation symbol.
14. `sdds/SDD_FIREGRID_RUNTIME_CONTEXT_INPUT_WRITE_ARM_MIGRATION.md` — the
   migration frame: the production DurableDeferred mailbox is a transitional
   bridge, not target architecture.
15. `../sdds/SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE.md` — the tf-7kq8
   replay-amplification bridge, now superseded as target architecture by sparse
   workflow-owned output transition logs.
16. `sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`
17. `research/workflow-body-single-suspension-rule.md`
18. `vision/factory-vision.md`

## Canonical Documents

### Process / Lifecycle

- `../contributing/docs-taxonomy-and-lifecycle.md` — the doc taxonomy
  (`public-narrative` / `internal-contract` / `historical-reference` /
  `dispatchable`), lifecycle status values, and the rule that this cannon index
  is the dispatch allowlist.

### Architecture

- `architecture/host-sdk-runtime-boundary.md` — package firewall:
  protocol schema catalog -> bindings -> runtime execution substrate.
- `architecture/host-sdk-runtime-boundary-open-questions-framing.md` —
  decisions on no `@firegrid/host-runtime` split yet, metadata projection
  gates, verified-webhook schema threshold, and `FiregridRuntimeHostLive`
  naming.
- `architecture/current-convergence-assessment-2026-05-20.md` — current
  convergence and next-phase work sequencing.
- `architecture/transactional-cutover-rule.md` — replacement work outside
  `packages/firelab/` must ship transactionally; firelab remains the
  allowed sandbox for partial spikes.
- `architecture/runtime-design-constraints.md` — canonical Firegrid runtime
  stop-condition: the operational application of the Stream-First Agent
  Substrate RFC to current runtime shrink work. New runtime SDDs must include a
  constraint check against C1-C7. This doc has priority over older
  engine-centered cannon when the conflict is whether to add another
  replay/cursor/mailbox/operation-wrapper primitive.
- `architecture/fluent/architecture.md` — canonical fluent boundary map:
  deployment topology, package/process/schema ownership, Durable Streams
  read/write ownership, and the distinction between raw harness, adapter/bridge,
  fluent host, and projection/read-model layers.
- `architecture/runtime-pipeline-type-boundaries.md` — companion to
  `runtime-design-constraints.md`: maps the canonical pipeline to concrete
  Effect type boundaries (`AgentByteStream`, `AgentSession`, typed output
  observation, `RuntimeContextStateStore`, and `ToolCallWorkflow`) so reviewers
  can distinguish plain keyed subscribers from workflow-shaped subscribers.
- `architecture/kernel-owned-write-arm.md` — canonical wake/durability rule for
  workflow-owned table writes: a host kernel/controller command owns both the
  durable write and the wake. A generic restart sweep over suspended engine rows
  is unsafe under the current engine model, and `HostKernelWorkflow` is a target
  role, not an existing implementation symbol.
- `architecture/sdd-alignment-sanity-check-2026-05-20.md` — alignment of the
  two high-load-bearing SDDs with current `main`.

### SDDs

- `sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md` — canonical agent/application surface:
  channels above workflows, fixed verb set, no substrate handles in agent code.
- `sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md` — canonical substrate
  direction: workflow engine owns durable suspension; `durable-tools` is gone.
- `../sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md` — canonical channel
  binding: a typed host-plane router maps channel contracts to runtime route
  implementations; edges (ACP/MCP/CLI/HTTP) dispatch over its derived
  string-keyed view. The router/ACP-edge cutover landed this session
  (`tf-9x11`/#591, `tf-csr0`/#596, `tf-p1aw`/#597); treat this SDD as the active
  contract for channel routing rather than a draft.
- `../sdds/SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md` — **dispatchable
  (draft architecture).** The Phase 0 target: an API-compatible clean-room
  reference (edge → router → `HostKernelWorkflow` → workflow-owned durable
  host/session resources → child session workflows) that production migrations
  compare against. Defines the state model (one resource record per aggregate,
  *not* request/claim/completion table families per operation) and the
  `HostKernelWorkflow` control-plane ownership. As of 2026-05-22,
  `HostKernelWorkflow` is a target ownership role, not an implemented symbol;
  lanes building the wake/durability path must also read
  `architecture/kernel-owned-write-arm.md`. Lanes building Phase 0A/0B dispatch
  from this; production PRs touching host-control routes, kernel workflows, or
  control-plane rows use it as the review oracle.
- `sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` — protocol owns shared
  schemas; TypeScript SDK, CLI, MCP/tool, and future REST/gRPC/JSON-RPC
  bindings project from protocol; runtime executes.
- `../sdds/SDD_FLUENT_HARNESS_ADAPTER_CONTRACT.md` — canonical adapter boundary:
  the external harness owns the native model loop; the adapter records Layer 1
  observation and preserves native protocol fidelity; fluent-runtime owns Layer
  2 durable coordination commitments and committed tool outcomes.
- `sdds/SDD_FIREGRID_ENGINE_NATIVE_PRIMITIVES_ESCAPE_HATCH.md` — canonical
  contingency/performance track for `streamWait`, `streamWaitAny`, reducers,
  and signal primitives.
- `sdds/SDD_FIREGRID_RUNTIME_CONTEXT_INPUT_WRITE_ARM_MIGRATION.md` — canonical
  migration frame from the current production DurableDeferred input mailbox to
  workflow-owned table input plus host-kernel/controller-owned write+arm. The
  mailbox is a bridge to retire, not a target invariant.

### Research / Evidence

- `research/workflow-body-single-suspension-rule.md` — current workflow body
  authoring rule.
- `../sdds/SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE.md` — **bridge reference, not the
  target.** Defines the `tf-7kq8` replay-amplification failure class and the
  dense-stream cursor bridge that prevented O(resumes × history). Its 2026-05-22
  addendum reclassifies the target as a sparse workflow-owned output transition
  log.
- `../investigations/2026-05-21-phase0b-output-replay-oracle.md` — historical
  evidence for the replay-amplification failure and O(outputs) gate.
- `research/tf-2y01-import-guardrails-baseline.md` — guardrail baseline.
- `research/tf-ygz3-shim-retirement-iteration-4.FINDING.md` — why the remaining
  carveouts need real moves or consumer migration.

### RFCs / Proposals

- `rfcs/tf-lwqm-session-new-all-delegation.PROPOSAL.md` — delegation
  background. Treat `session_new_all` as optional ergonomics, not a private-beta
  blocker; repeated `session_new` calls are sufficient unless evidence proves a
  batch primitive is needed.

### Vision

- `vision/factory-vision.md` — private-beta product target and §6/§7 capability
  north star.

## Explicitly Non-Canonical Or Historical

- `docs/sdds/_archive/SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER.md` is historical:
  useful as the cutover plan, but superseded by the landed state and current
  convergence assessment.
- `docs/research/canonical-convergence-assessment-2026-05-20.md` is historical:
  its 65% estimate was correct when written, but stale after PRs #518-#528.
- Older wait-router/durable-tools SDDs are historical. `durable-tools` has been
  deleted and must not be reintroduced as a compatibility surface.
- Bespoke per-edge transport SDDs are historical now that the ACP edge is a
  router edge (`tf-csr0`/#596, `tf-p1aw`/#597). New edge surfaces are router
  dispatch views, not standalone transports.
- Docs presenting `ChannelRegistry`/`ChannelInventory` as the channel binding
  mechanism are historical; the host-plane channel router replaced the broad
  registry as the canonical binding object.
- Docs that present per-operation / per-verb workflow identities, or
  request/claim/completion table families per CRUD operation, as the design
  model are historical. The target reference models these as one resource record
  per aggregate owned by the `HostKernelWorkflow` target role; there is no
  existing implementation symbol with that name. Existing operation-shaped
  workflows are migration debt (see the `WORKFLOW_ADMISSION` invariant above).
  Do not cite them as precedent for new surfaces.

## Current Hard Invariants

- Runtime must not import host-sdk.
- Client SDK must not import runtime.
- Agent/app code must not receive workflow handles, execution ids, stream URLs,
  table names, CDC/subscription handles, engine services, or durable wait
  stores.
- Channels are the semantic application surface, bound to runtime route
  implementations through the host-plane channel router; edge surfaces
  (ACP/MCP/CLI/HTTP) are dispatch views over the router, not bespoke transports.
- Runtime owns workflow definitions, engine integration, event pipeline,
  provider adapters, durable authorities, channel route implementations, and
  common operation execution.
- Host SDK owns host-author composition, channel router composition
  (`FiregridHostChannelRouterLive` + edges), MCP/Effect AI binding, and topology
  options. It must not own durable route bodies; those live in the runtime.
- Protocol owns shared schemas and wire contracts.
- Client SDK, CLI, MCP, and future RPC surfaces are projections over
  protocol-owned operation and channel contracts. Client methods such as
  `sessions.createOrLoad`, `session.start`, and `permissions.respond` are
  ergonomic projections, not independent substrate APIs.
- Agents see only `wait_for`, `send`, and `call` over opaque semantic channel
  targets; they do not receive durable table, workflow, stream, or provider
  coordinates.
- Product-specific webhook semantics live in route/app/adaptor layers. The
  canonical Firegrid channel for verified webhooks is the generic
  `firegrid.verifiedWebhooks` fact channel.
- Runtime design is constrained by
  `architecture/runtime-design-constraints.md`: keyed durable state,
  event/state handlers, durable result identity, durable completions /
  externally resolved waits, no permanent parked entity bodies, typed
  source+cursored observations, and first-class schemas. Any bridge exception
  must name its deletion path.
- `packages/runtime/src/durable-tools/` stays deleted.
- A production `Workflow.make` identity is only for an owned durable resource or
  long-running process state machine. One-shot commands, CRUD/lifecycle
  requests, tool calls, waits, and routing/request-claim bridges are operation
  wrappers — lower them through the owning workflow state machine
  (`HostKernelWorkflow` as a target role, not an existing implementation) or an
  explicitly named engine primitive, not a new workflow identity. New
  `Workflow.make` sites need SDD-backed owner
  justification and a deliberate static-inventory entry; operation-shaped
  workflows already in production are **migration debt, not precedent** (feature
  `firegrid-workflow-driven-runtime.WORKFLOW_ADMISSION`, `tf-gomx`/#611).
- Output observation inside a workflow body must not read the dense raw output
  stream as target architecture. The landed durable cursor bridge prevents the
  `tf-7kq8` O(resumes × history) replay storm, but the target is a sparse
  workflow-owned transition log containing only body-relevant semantic triggers
  such as permission requests, non-ACP tool uses, and termination.
- Half-ships are allowed only in `packages/firelab/`. Production package
  work must either complete the replacement, declare a temporary bridge with a
  blocking deletion/reconciliation bead, or remain explicitly open.

## Current Scoreboard

The finish-line metric is the `currentHostSdkSubstrateDebt` list in
`.dependency-cruiser.cjs`. As of this curation pass it has 8 files. Future
boundary work should reduce that list or produce a finding explaining why it
cannot yet be reduced.
