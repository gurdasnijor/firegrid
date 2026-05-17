# SDD: Firegrid SDK Plane Split

Status: draft design contract, revised for the greenfield Path X baseline

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

Path X replaces the current runtime authority/subscriber bypass with a reactive
`RuntimeContextWorkflow` body over `DurableStreamsWorkflowEngine`. This SDK SDD
must not freeze old substrate mechanics as public API.

Consequences:

- Direct `RuntimeIngressTable` append, owner-host stream URL construction, and
  runtime authority tags are not app-facing surfaces.
- Public client and CLI operations stay session-shaped:
  `sessions.createOrLoad`, `session.prompt`, `session.wait.*`,
  `session.permissions.respond`, `session.snapshot`, and `watchContexts`.
- Host composition stays host-shaped: apps install providers, MCP, env policy,
  durable storage, and runtime start/execution layers through host-sdk.
- `RuntimeToolUseExecutor` is the shared seam between this SDD and Path X. It
  already landed in PR 282 and is the injection point the reactive workflow body
  uses for tool execution.
- `RUNTIME_CAPABILITY_PROJECTIONS` is cancelled. Those ACIDs described optional
  cleanup of runtime authority files that Path X deletes or rewrites.

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
exposure, agent-tool bindings, runtime start capability, and the live
`RuntimeToolUseExecutor` layer.

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

Allowed imports: `@firegrid/protocol`, `@firegrid/runtime`, `@effect/ai`,
`@effect/platform-node`, and `@modelcontextprotocol/sdk`.

Forbidden imports: `@firegrid/client-sdk`, `@firegrid/cli`.

Host-sdk composes whatever runtime substrate exists. Today that includes the
current host layers; after Path X it includes the reactive workflow substrate.
The public `FiregridHostLive` options should not change because of that
internal substrate replacement.

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

Loses public host composition, `agent-tools/`, and `verified-webhook-ingest/`.
Keeps runtime-private substrate implementation: agent event pipeline,
workflow-engine integration, durable-tools, codecs, agent adapters, and host
internals.

Runtime owns `RuntimeToolUseExecutor` as the narrow capability consumed by
ToolUse routing today and by the Path X reactive workflow body later.

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

## Acceptance

- Dependency-cruiser reports zero SDK boundary violations.
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
