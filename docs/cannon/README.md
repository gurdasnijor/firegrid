# Firegrid Cannon

Status: canonical source-of-truth index
Date: 2026-05-20

`docs/cannon/` is the compact canonical reading set for the current Firegrid
architecture. Older docs elsewhere in `docs/` remain useful evidence and
history, but they are not canonical unless listed here.

The misspelled directory name `cannon` is intentional because that is the
requested path for this curation pass.

## How To Read This Tree

Read in this order:

1. `architecture/host-sdk-runtime-boundary.md`
2. `architecture/current-convergence-assessment-2026-05-20.md`
3. `sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md`
4. `sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md`
5. `sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`
6. `research/workflow-body-single-suspension-rule.md`
7. `vision/factory-vision.md`

## Canonical Documents

### Architecture

- `architecture/host-sdk-runtime-boundary.md` — package firewall:
  protocol schema catalog -> bindings -> runtime execution substrate.
- `architecture/host-sdk-runtime-boundary-open-questions-framing.md` —
  decisions on no `@firegrid/host-runtime` split yet, metadata projection
  gates, verified-webhook schema threshold, and `FiregridRuntimeHostLive`
  naming.
- `architecture/current-convergence-assessment-2026-05-20.md` — current
  convergence and next-phase work sequencing.
- `architecture/sdd-alignment-sanity-check-2026-05-20.md` — alignment of the
  two high-load-bearing SDDs with current `main`.

### SDDs

- `sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md` — canonical agent/application surface:
  channels above workflows, fixed verb set, no substrate handles in agent code.
- `sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md` — canonical substrate
  direction: workflow engine owns durable suspension; `durable-tools` is gone.
- `sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` — protocol owns shared
  schemas; TypeScript SDK, CLI, MCP/tool, and future REST/gRPC/JSON-RPC
  bindings project from protocol; runtime executes.
- `sdds/SDD_FIREGRID_ENGINE_NATIVE_PRIMITIVES_ESCAPE_HATCH.md` — canonical
  contingency/performance track for `streamWait`, `streamWaitAny`, reducers,
  and signal primitives.

### Research / Evidence

- `research/workflow-body-single-suspension-rule.md` — current workflow body
  authoring rule.
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

- `docs/sdds/SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER.md` is historical:
  useful as the cutover plan, but superseded by the landed state and current
  convergence assessment.
- `docs/research/canonical-convergence-assessment-2026-05-20.md` is historical:
  its 65% estimate was correct when written, but stale after PRs #518-#528.
- Older wait-router/durable-tools SDDs are historical. `durable-tools` has been
  deleted and must not be reintroduced as a compatibility surface.

## Current Hard Invariants

- Runtime must not import host-sdk.
- Client SDK must not import runtime.
- Agent/app code must not receive workflow handles, execution ids, stream URLs,
  table names, CDC/subscription handles, engine services, or durable wait
  stores.
- Channels are the semantic application surface.
- Runtime owns workflow definitions, engine integration, event pipeline,
  provider adapters, durable authorities, and common operation execution.
- Host SDK owns host-author composition, channel Layer installation, MCP/Effect
  AI binding, and topology options.
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
- `packages/runtime/src/durable-tools/` stays deleted.

## Current Scoreboard

The finish-line metric is the `currentHostSdkSubstrateDebt` list in
`.dependency-cruiser.cjs`. As of this curation pass it has 8 files. Future
boundary work should reduce that list or produce a finding explaining why it
cannot yet be reduced.
