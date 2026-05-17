# SDD: Firegrid SDK Plane Split

Status: design contract for the ratified post-#309 Host SDK target shape. The
PR A package split and the `RuntimeToolUseExecutor` seam (PR 282) have landed.
The Path X live-owner cutover and the `@firegrid/runtime/host-substrate`
removal are the ratified target and are **in progress in #309 (still
draft, tests red) — not yet merged**. This document describes the target
end-state #309 implements; statements about the cutover apply once #309
merges.

Related specs:

- `firegrid-host-sdk`
- `firegrid-schema-projection-contract`
- `firegrid-runtime-boundary-reconciliation`
- `firegrid-runtime-agent-event-pipeline`
- `firegrid-runtime-host-modularity`
- `firegrid-local-mcp-run`

Related substrate plan:

- `docs/sdds/SDD_PATH_X_IMPLEMENTATION.md`

## Decision

Firegrid should cut directly to three public package surfaces over protocol and
runtime:

- `@firegrid/client-sdk` owns the session plane.
- `@firegrid/host-sdk` owns host composition, provider installation, agent-tool
  bindings, MCP exposure, and host-side execution layers.
- `@firegrid/cli` owns command bindings over host-sdk and client-sdk.

`@firegrid/runtime` remains the execution substrate. Product apps should not
import runtime implementation paths for normal behavior, and runtime must not
import host-sdk, client-sdk, or CLI.

This is a greenfield cutover, not a compatibility migration. Do not build
long-lived shims, deprecation windows, duplicate package surfaces, or projection
helper cleanups for files Path X is about to delete. The target architecture is
the clean baseline future work should build on.

## Relationship To Path X

Path X replaces the runtime authority/subscriber bypass with a reactive
`RuntimeContextWorkflow` body over `DurableStreamsWorkflowEngine`. The live
owner cutover is in progress in #309 (draft, tests red — not yet merged). The
ratified target: the legacy ingress-delivery spine —
`agent-event-pipeline/subscribers/ingress-delivery.ts` (`runIngressDelivery`),
`agent-event-pipeline/session-runtime.ts`, and
`agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts`
(`RuntimeIngressDeliveryClaimAndComplete`) — is deleted outright, not
deprecated. No mixed-mode or compatibility writer path is introduced. The
following hold once #309 merges.

Consequences (target, pending #309 merge):

- Direct `RuntimeIngressTable` append, owner-host stream URL construction, and
  runtime authority tags are not app-facing surfaces.
- Public client and CLI operations stay session-shaped and unchanged by the
  cutover: `sessions.createOrLoad`, `session.prompt`, `session.wait.*`,
  `session.permissions.respond`, `session.snapshot`, and `watchContexts`.
- Host composition stays host-shaped: apps install providers, MCP, env policy,
  durable storage, and runtime start/execution layers through host-sdk.
  Host-sdk owns the live owner adapters (the codec/raw
  `RuntimeContextWorkflowSession` adapters) behind that surface.
- `RuntimeToolUseExecutor` is the shared seam. It landed in PR 282 and is the
  injection point the reactive workflow body uses for tool execution.
- `@firegrid/runtime/host-substrate` (the transitional barrel host-sdk
  imported during the split) is **removed** by #309. Runtime exposes scoped
  public subpaths; host-sdk imports those, never the runtime root barrel or a
  `host-substrate` aggregate. The scoped subpaths and why host-sdk needs each:
  - `@firegrid/runtime/control-plane` — runtime-context/control-plane recorder
    + read authorities the host composition wires.
  - `@firegrid/runtime/runtime-output` — per-context output writer / output
    table the live-owner adapters journal through.
  - `@firegrid/runtime/runtime-ingress` — runtime ingress append surface for
    host-side sequenced input.
  - `@firegrid/runtime/tool-executor` — the `RuntimeToolUseExecutor` capability
    tag (host provides the live layer).
  - `@firegrid/runtime/events` — `AgentInputEvent`/`AgentOutputEvent` schemas
    the adapters and command shapes reference.
  - `@firegrid/runtime/durable-tools` — `WaitFor` / durable-tools wait-router
    the reactive workflow body composes.
  - `@firegrid/runtime/workflow-engine` — `DurableStreamsWorkflowEngine` the
    host composition installs.
  - `@firegrid/runtime/codecs` — the agent codec surface the host-side
    **CodecAdapter** (`RuntimeContextWorkflowSession` codec adapter) lowers
    onto. Rationale: the live-owner codec adapter is the host-sdk seam that
    bridges the reactive workflow body to the agent codec; it must reach the
    codec surface through this scoped subpath, not a barrel.
  - `@firegrid/runtime/sources/sandbox` — local-process sandbox provider,
    `RuntimeEnvResolverPolicy`, and `localProcessSpawnEnvFromHostEnv`.
    Rationale: the live-owner raw adapter and provider installation depend on
    the sandbox/provider substrate; this is the scoped surface for that
    dependency. (If the final #309 export layout names either of these
    differently, treat the name as **pending** and reconcile to the shipped
    subpath; the rationale stands.)
- `RUNTIME_CAPABILITY_PROJECTIONS` is cancelled — Path X deletes/rewrites the
  runtime authority files those ACIDs described.

## Package Contracts

### `@firegrid/client-sdk`

Owns browser/edge-safe session-plane bindings projected from protocol schemas.

Public surface:

```ts
import {
  Firegrid,
  FiregridConfig,
  FiregridLive,
  FiregridStandaloneLive,
  local,
  type FiregridSessionHandle,
} from "@firegrid/client-sdk"
```

Rules:

- Must not import `@firegrid/runtime`, `@firegrid/host-sdk`, `@firegrid/cli`,
  `@effect/platform-node`, `@effect/ai`, `@modelcontextprotocol/sdk`, or
  `node:*`.
- Must not expose runtime table append, owner-stream construction, workflow
  engine tokens, host credentials, process handles, or provider clients.
- Examples and tests must demonstrate session methods, not substrate mechanics.
- Internal transport files may use protocol-owned table schemas where necessary
  before Path X lands, but that detail must not leak into public bindings.

### `@firegrid/host-sdk`

Owns host composition, provider implementation installation, route-scoped MCP
exposure, agent-tool bindings, runtime start capability, the live owner
adapters (the codec/raw `RuntimeContextWorkflowSession` adapters that drive the
reactive `RuntimeContextWorkflow` body), and the live `RuntimeToolUseExecutor`
layer.

Public surface:

```ts
import {
  FiregridAgentToolkit,
  FiregridAgentToolkitLayer,
  FiregridHostFromConfig,
  FiregridHostLive,
  FiregridMcpServerLayer,
  FiregridMcpServerListenerConfig,
  LocalProcessSandboxProvider,
  RuntimeEnvResolverPolicy,
  RuntimeStartCapabilityLive,
  RuntimeToolUseExecutorLive,
  type FiregridHostOptions,
} from "@firegrid/host-sdk"
```

Allowed imports: `@firegrid/protocol`, `@effect/ai`, `@effect/platform-node`,
`@modelcontextprotocol/sdk`, and `@firegrid/runtime` **only through its scoped
public subpaths** (`@firegrid/runtime/{control-plane,runtime-output,runtime-ingress,tool-executor,events,durable-tools,workflow-engine,codecs,sources/sandbox}` —
see the per-subpath rationale under "Relationship To Path X", including
`codecs` for the CodecAdapter seam and `sources/sandbox` for the live-owner
adapter/provider dependency). The `@firegrid/runtime` root barrel and the
former `@firegrid/runtime/host-substrate` aggregate are not import surfaces;
#309 removes the latter.

Forbidden imports: `@firegrid/client-sdk`, `@firegrid/cli`, the
`@firegrid/runtime` root barrel, and `@firegrid/runtime/host-substrate`
(removed by #309).

Host-sdk composes the reactive workflow substrate that the Path X live owner
cutover (#309, in progress) introduces. The public `FiregridHostLive` /
`FiregridHostFromConfig` options are designed to stay stable across that
internal substrate replacement, and the client-sdk and cli public surfaces are
not changed by it — this is a target invariant #309 must preserve, not a
post-hoc observation.

### `@firegrid/cli`

Owns `@effect/cli` command definitions, argv parsing, help text, examples,
local developer defaults, process exit behavior, and Node-only entrypoints.

Public surface:

```ts
import { firegrid } from "@firegrid/cli"
```

Allowed imports: `@firegrid/protocol`, `@firegrid/host-sdk`,
`@firegrid/client-sdk`, `@effect/cli`, and `@effect/platform-node`.

No package may import `@firegrid/cli`.

CLI commands call client-sdk session methods and host-sdk composition. They do
not call runtime substrate helpers directly.

### `@firegrid/runtime`

Has no public host composition, `agent-tools/`, or `verified-webhook-ingest/`
surface. Keeps runtime-private substrate implementation: agent event pipeline,
workflow-engine integration, durable-tools, codecs, and agent adapters. Target
(implemented by #309, in progress): the legacy ingress-delivery spine
(`subscribers/ingress-delivery.ts`, `session-runtime.ts`,
`authorities/runtime-ingress-delivery-tracker.ts`) is deleted outright and
`src/host-substrate.ts` is removed. Until #309 merges these still exist on
`main`.

Runtime exposes scoped public subpaths for the substrate host-sdk composes.
The set (non-exhaustive; final names are whatever #309's shipped `exports`
map publishes — treat unmatched names as **pending** and reconcile):
`control-plane`, `runtime-output`, `runtime-ingress`, `tool-executor`,
`events`, `durable-tools`, `workflow-engine`, `codecs` (CodecAdapter seam),
`sources/sandbox` (live-owner adapter / provider + env policy), and the
runtime error surface used by the host adapters (`RuntimeContextError` /
`asRuntimeContextError` / `mapRuntimeContextError` — exact subpath name
pending #309; today these are `runtime-errors.ts`, guarded internal-only by
depcruise `runtime-errors-internal-only`, and #309 must publish a scoped
surface rather than have host-sdk reach the internal file). Runtime owns
`RuntimeToolUseExecutor` as the narrow capability consumed by ToolUse routing
and the reactive workflow body, and never imports host-sdk, client-sdk, or cli
(enforced by depcruise `runtime-no-host-sdk` + eslint).

## Operation Projection Contract

Protocol schemas are the source of truth. Bindings project schema annotations
into target environments:

```txt
@firegrid/protocol catalog
  schemas + firegridProjection annotations

  -> @firegrid/client-sdk
       session methods, snapshots, waits, permission helpers

  -> @firegrid/host-sdk
       Effect AI tools/toolkits, MCP exposure, host layers

  -> @firegrid/cli
       @effect/cli commands, flags, help, local defaults
```

Production bindings must not depend on `FiregridOperationEntry`,
`defineFiregridOperation`, copied metadata registries, or a second operation
DSL. Plain grouped schema values plus Schema annotations are the contract.

## Direct Cutover Plan

### Already Landed: RuntimeToolUseExecutor Seam

PR 282 landed the load-bearing inversion:

- runtime ToolUse routing depends on `RuntimeToolUseExecutor`;
- live execution delegates to existing host-side `toolUseToEffect`;
- runtime no longer needs to import agent-tool bindings directly.

This satisfies:

- `firegrid-host-sdk.TOOL_EXECUTOR_SEAM.1`
- `firegrid-host-sdk.TOOL_EXECUTOR_SEAM.2`
- `firegrid-host-sdk.TOOL_EXECUTOR_SEAM.3`
- `firegrid-host-sdk.SEQUENCING.10`
- `firegrid-host-sdk.PACKAGE_GRAPH.6`

### PR A: SDK Baseline Cutover

Purpose:

- Create the clean package baseline in one direct cutover.

What it does:

- Creates `packages/client-sdk`, `packages/host-sdk`, and `packages/cli`.
- Moves client session bindings, snapshots, waits, permission helpers, and local
  runtime intent helpers into client-sdk.
- Moves host composition, provider layers, agent-tool bindings, MCP exposure,
  `RuntimeStartCapabilityLive`, scheduled input workflow, `AgentToolHost`, and
  `RuntimeToolUseExecutorLive` into host-sdk.
- Moves root CLI command definitions and process entrypoints into CLI.
- Deletes production dependency on `FiregridOperationEntry` and
  `defineFiregridOperation`; operation groupings become plain protocol schema
  values.
- Updates factory, scenarios, and root command entrypoints to import the new
  public packages.
- Adds package graph, boundary, and semgrep rules in the same PR:
  runtime cannot import SDK packages or CLI; client-sdk cannot import runtime,
  host-sdk, CLI, Node, Effect AI, MCP, or platform-node; host-sdk cannot import
  client-sdk or CLI; no package imports CLI; examples do not demonstrate
  substrate-shaped input.
- Keeps behavior through existing session, CLI, runtime, and factory tests.

Likely files:

- `packages/client/**` -> `packages/client-sdk/**`
- `packages/runtime/src/agent-tools/**` -> `packages/host-sdk/agent-tools/**`
- `packages/runtime/src/host/**` host composition exports -> `packages/host-sdk/host/**`
- `src/run.ts` and CLI entrypoints -> `packages/cli/**`
- `packages/protocol/src/**` operation catalog groupings
- root `package.json`, `pnpm-workspace.yaml`, tsconfig/dependency-cruiser
  configuration, semgrep rules, and exports maps
- app/scenario imports that currently reach into runtime or root CLI paths

Behavior changed:

- package names and import paths change to the target architecture.
- public session/host/CLI behavior should remain the same.

Invariants and validation:

- `sessions.createOrLoad`, `externalKey`, `local.jsonl(...)`, typed waits, and
  permission response behavior remain unchanged.
- `pnpm firegrid -- run` and `pnpm firegrid -- start` scenario behavior remains
  covered through CLI compatibility tests or their moved equivalents.
- Factory imports only public SDK/protocol/integration/app-owned modules for
  normal Firegrid behavior.
- Runtime does not import host-sdk, client-sdk, or CLI.
- Client-sdk remains browser/edge safe.
- Host-sdk returns protocol-shaped launch/session identity results rather than
  client-sdk-owned handles.

Reversible standalone:

- by revert only. This is the intentional baseline cutover, not a staged
  migration.

Estimate:

- 1.5 to 3 engineer-weeks.

### PR B: Cleanup And Spec Alignment

Purpose:

- Remove stale surfaces and align docs/specs after the direct package cutover.

What it does:

- Retires `packages/runtime/src/verified-webhook-ingest/` unless a real product
  consumer appears before this PR.
- Deletes old root CLI compatibility files if PR A left tiny entrypoint shims.
- Removes deprecated runtime host or agent-tool exports kept only to make PR A
  reviewable.
- Updates docs and examples to use only `@firegrid/client-sdk`,
  `@firegrid/host-sdk`, `@firegrid/cli`, and protocol packages.
- Marks `firegrid-host-sdk.RUNTIME_CAPABILITY_PROJECTIONS.1-4` and
  `firegrid-host-sdk.SEQUENCING.12` superseded by Path X.
- Runs dependency, dead-code, docs, specs, and semgrep checks.

Behavior changed:

- none intended beyond removing stale implementation surface.

Invariants and validation:

- boundary checks still pass;
- dead-code checks do not see old public runtime host/agent-tool surfaces;
- docs/specs no longer instruct workers to implement cancelled projection
  helpers.

Reversible standalone:

- yes, after PR A.

Estimate:

- 2 to 4 engineer-days.

## Status and Next Cleanup

Landed on `main`: the PR A package split and the `RuntimeToolUseExecutor` seam
(PR 282).

In progress (not merged): the Path X live owner cutover and the
`@firegrid/runtime/host-substrate` removal are #309, still **draft with tests
red**. The ratified target #309 implements: the legacy ingress-delivery spine
is deleted outright (not deprecated) — no mixed-mode runtime path, no
compatibility writer; host-sdk owns the live owner adapters; client-sdk and cli
public surfaces are unchanged by the cutover (a target invariant #309 must
hold, asserted at review/merge, not yet observed).

Follow-up after #309 merges (one item, scoped narrow): **deferred-input
cleanup** — finish converging prompt/permission/tool delivery on the reactive
workflow's content-derived `DurableDeferred` waits, removing any transitional
`RuntimeIngressInput` sequencing helpers that #309 leaves only as internal
plumbing. This is internal-only; it does not alter the client-sdk, host-sdk,
or cli public surfaces and must not reintroduce a deprecated path. It is gated
on #309 landing.

## Acceptance

- Dependency-cruiser reports zero SDK boundary violations, including
  `runtime-no-host-sdk` and no `@firegrid/runtime/host-substrate` consumers.
- Runtime no longer exports public `host/` or `agent-tools/` surfaces for
  product apps.
- Runtime ToolUse routing depends on `RuntimeToolUseExecutor`.
- Production bindings do not import `FiregridOperationEntry` or
  `defineFiregridOperation`.
- Client-sdk passes browser/edge boundary tests.
- Host-sdk exports `FiregridHostLive`, `FiregridAgentToolkit`,
  `FiregridMcpServerLayer`, `RuntimeStartCapabilityLive`, and
  `RuntimeToolUseExecutorLive`.
- CLI exposes session, permission, `run`, and `start` commands projected from
  protocol schemas.
- Factory and scenarios use public SDK imports for normal Firegrid behavior.
- `verified-webhook-ingest/` is gone or explicitly moved to a real integration
  package with a product consumer.

## Non-Goals

- No new operation contracts.
- No durable row migrations; Path X owns substrate replacement.
- No replacement for SourceCollections; typed wait-source redesign already
  retired it.
- No dynamic provider registry. Providers are explicit Layers at the
  composition root.
- No Firegrid-specific workflow DSL or operator framework.
- No brand-typed runtime capability framework.
- No durable-record factory that generates anonymous tag bundles.
- No runtime capability projection helpers.
- No browser-originated runtime authority.
- No substrate-aware public client surface.

## Risks

| Risk | Mitigation |
| --- | --- |
| Package cutover becomes a long-lived partial boundary. | PR A moves package surfaces, imports, static rules, and consumers together. |
| Runtime imports host-sdk after agent tools move. | `RuntimeToolUseExecutor` remains runtime-owned; host-sdk provides only the live layer. Dependency rules fail the build on reverse imports. |
| Client-sdk leaks substrate mechanics. | Boundary rules forbid runtime/Node/host imports and examples must use session methods only. |
| CLI loses current flags or local defaults. | Snapshot current help and scenario behavior before PR A; preserve behavior in moved CLI tests. |
| Path X and SDK cutover touch the same host wiring files. | Coordinate by file ownership. If a file is being moved and rewritten, merge the move first or include the rewrite on top of the moved path. |
