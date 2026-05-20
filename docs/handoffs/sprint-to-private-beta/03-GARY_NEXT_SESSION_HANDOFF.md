# Gary Next-Session Handoff

Date: 2026-05-20
Repo state used: `origin/main` at `7ecaa9102`

Update mode: this is a tactical handoff plus live watchpoint log. If Gurdas
keeps surfacing boundary questions, add the conclusion here and in
`02-GARY_ARCHITECTURE_ASSESSMENT.md` before batching to the coordinator.

## Read First

1. `docs/cannon/README.md` after PR #529 lands.
2. `docs/cannon/architecture/host-sdk-runtime-boundary.md`
3. `docs/handoffs/sprint-to-private-beta/01-COORDINATOR_HANDOFF_canonical_convergence.md`
4. `docs/handoffs/sprint-to-private-beta/02-GARY_ARCHITECTURE_ASSESSMENT.md`
5. `docs/handoffs/sprint-to-private-beta/02b-COMPANION_ARCHITECTURE_ASSESSMENT.md`
6. `docs/handoffs/sprint-to-private-beta/architecture/00-README.md`
7. `.dependency-cruiser.cjs`
8. `docs/cannon/rfcs/tf-lwqm-session-new-all-delegation.PROPOSAL.md`

The boundary architecture is no longer in discovery mode. Treat the canonical
doc as law unless Gurdas explicitly changes the firewall.

## Current Mental Model

The target architecture is:

```text
protocol schema catalog
  -> host/client/CLI bindings
  -> runtime execution substrate
```

Channels are the app/agent semantic event/faculty surface. Workflows, durable
streams, table CDC, engine services, execution ids, and stream URLs stay below
that surface.

Sharper rule: host-sdk is a composition boundary, not a substrate owner. It can
compose Effect Layers, host deployment resources, semantic channels, and
projection bindings. It should not assemble workflow engines, durable table
facades, deferred-row drivers, runtime observation authorities, or control-plane
dispatch loops directly. When host-sdk needs runtime behavior, it should provide
a host-specific implementation of a runtime-owned capability tag.

Important refinement: channels do **not** replace every control-plane API.
Launch/start/prompt/session control are protocol/session operations projected
through client SDK, CLI, MCP, REST, etc. They may lower into the same runtime
substrate, but they should not be taught as arbitrary agent-visible
`send(control.table, ...)` channels.

The system is now roughly **90-93% converged**. The old 65% convergence doc is
historically useful, but stale after PRs #518, #519, #522, #524, #525, #526,
#527, and #528.

Use the two-number convergence frame when briefing the coordinator:

- substrate boundary: **90-93%**;
- surface hygiene: **75-80%**.

Route dispatch from `docs/handoffs/sprint-to-private-beta/architecture/` so the
surface-hygiene gates from the companion assessment are sequenced alongside the
8-file substrate carveout work.

## What Landed After The 65% Assessment

- `durable-tools` final deletion: #519.
- More RuntimeAgentToolExecution arms: #518.
- More schema projection: #522 and #525.
- More guardrail ratcheting: #520, #524, #526, #528.
- Deterministic factory smokes through sleep and waitFor: #516 and #527.
- Driver/run bounding for dark-factory: #521.
- Spawn/delegation proposal: #523.
- Canon docs + public README/package README projection refresh: #529.
- Projection-surface backlog captured as `tf-aago` for client SDK/CLI presets
  over protocol launch/channel contracts.

Do not accidentally reason from the pre-#519 world. `durable-tools` is gone on
`origin/main`.

## Objective Scoreboard

Use `.dependency-cruiser.cjs` `currentHostSdkSubstrateDebt` as the scoreboard.
As of `7ecaa9102`, 8 files remain:

- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts`
- `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts`
- `packages/host-sdk/src/host/control-request-reconciler.ts`
- `packages/host-sdk/src/host/internal/runtime-context-helpers.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-core.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts`
- `packages/host-sdk/src/host/runtime-input-deferred.ts`
- `packages/host-sdk/src/host/session-log-channel.ts`

Every next-wave architecture answer should reduce, explain, or preserve this
list. If a lane touches one of these files and does not shrink the carveout or
explain why it remains, ask for clarification.

## Generated Diagram Evidence

The useful architecture graphs were regenerated in PR #529's worktree with the
repo's own `package.json` scripts:

```bash
pnpm run arch:deps:workspace
pnpm run arch:deps:workspace:detail
pnpm run arch:deps:protocol
pnpm run arch:deps:runtime
pnpm run arch:deps:runtime:detail
```

Use these artifacts when supporting or challenging boundary claims:

- `docs/dependency-graph.mmd`
- `docs/dependency-graph-detail.mmd`
- `docs/dependency-graph-protocol.mmd`
- `docs/dependency-graph-runtime.mmd`
- `docs/dependency-graph-runtime-detail.mmd`

The important read: `docs/dependency-graph-detail.mmd` makes the remaining
host-sdk substrate concentration visible at file granularity. Runtime already
owns the workflow definitions; host-sdk still owns the live control/session
dispatcher and adapter spine. That is the current gap.

Known tooling drift: `pnpm run arch:deps:client` fails because the generator
still targets `packages/client/src`; the current package is
`packages/client-sdk`. Fold that fix into `tf-aago` or the next projection-docs
lane before relying on client-sdk diagrams in public material.

## Recommended First Response Next Session

If asked "what now?", answer:

1. Dispatch a narrow carveout-reduction lane against one or two files from the
   8-file list.
2. Dispatch a surface-hygiene lane: barrel-export audit, tiny-firegrid
   methodology/examples sweep, and `hostProjectionObserver` removal path.
3. Dispatch projection-surface cleanup from `tf-aago`: client SDK + CLI presets
   lower to protocol launch/channel contracts, not a separate config DSL.
4. Dispatch external-trigger planning for Linear verified webhook -> channel ->
   planner.
5. Keep one lane free for guardrail/rebase repair.

## Decisions I Would Stand Behind

- Keep `FiregridRuntimeHostLive` stable. Rename later, if at all.
- Do not introduce `@firegrid/host-runtime` yet. Runtime remains the lower-tier
  execution home.
- Do not reopen the old channel registry debate. `ChannelInventory` is an edge
  inventory/metadata adapter, not a mutable app registry.
- Defer `session_new_all` unless evidence proves repeated `session_new` is
  insufficient. If taken later, introduce a new operation; do not overload
  terminal `spawn_all`.
- Treat engine-native `streamWait/streamWaitAny` as performance-triggered, not
  a blocker for private beta.
- Keep verified webhook implementation in runtime; move/provide public fact
  schemas through protocol when a binding observes them.
- Treat `appendRuntimeIngress` as control-plane/session authority, not a
  channel. It should eventually sit behind a narrow runtime/control-plane
  capability or session facade.
- Treat `state-changes-channel.ts` as the good CDC-channel example: an adapter
  may touch `DurableTable.rows()`, but the agent sees only an opaque semantic
  channel.
- Treat `control-request-reconciler.ts` as live boundary debt, not dead code.
  It is the Path C bridge from protocol-owned control request rows to runtime
  control workflows. The workflow definitions already live in
  `packages/runtime/src/workflow-engine/workflows/runtime-control-request.ts`;
  the misplaced part is `RuntimeControlRequestWorkflowEngineLive` plus the
  request-row subscription, startup backfill, registration, and side-effect
  dispatcher. `pollIntervalMs` is vestigial; the live daemon uses rows() streams
  after a startup reconciliation scan. The target is to move the
  dispatcher/daemon mechanics below the runtime line, remove stale poll-era API,
  and hide the dispatcher inside the runtime host/control-plane spine. Host-sdk
  should compose only top-level public host/session capabilities, not exported
  dispatcher internals.
- Treat the rest of `packages/host-sdk/src/host` as three spine moves, not one
  broad relocation:
  1. runtime context workflow spine (`runtime-context-workflow-runtime.ts`,
     `runtime-input-deferred.ts`, `runtime-substrate.ts`,
     `runtime-context-workflow-support.ts`);
  2. control/session spine (`control-request-reconciler.ts`, `commands.ts`,
     `agent-tool-host-live.ts` execution pieces);
  3. runtime output/session adapters (`per-context-runtime-output.ts`,
     `runtime-context-session/*`, runtime-backed parts of
     `channels/session-self/index.ts`).
  Host-sdk keeps channel factories, MCP projection, config DTOs, and top-level
  composition.
- Treat `runtime-substrate.ts` as the current substrate knot, not a durable
  host-sdk concept. It composes runtime control-plane authorities, runtime
  observation streams, workflow support, runtime tool-execution tags, host tool
  bindings, and `toolUseToEffect` in one place. The cleanup should split by
  capability family: runtime owns observation/control/workflow/tool-execution
  providers; host-sdk owns top-level host composition and projection bindings.
- Treat `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts` as the
  main downstream symptom of that knot. It currently imports
  `host/runtime-substrate.ts` to run `ToolCallWorkflow`; the target is for the
  toolkit projection to depend on runtime-owned execution services and channel
  capabilities, not host-sdk substrate assembly.
- Treat `runtime-context-session/codec-adapter.ts` specifically as runtime
  agent-session spine. It owns ACP/stdio-jsonl codec Layer selection,
  runtime-context MCP URL injection, stderr journaling, output streaming, and
  input-event sending. The host-specific input is configuration/capability
  provision; the adapter body belongs below the runtime line.
- Treat `packages/runtime/src/authorities/runtime-control-plane-recorder.ts` as
  legitimate runtime substrate. It is the narrow authority provider over
  runtime control-plane rows: context insert/read, run attempt allocation, run
  status writes, and context/run streams. `authorities/README.md` is useful only
  as a least-privilege provider convention; it should not become a public API or
  table-facade escape hatch.
- Treat `packages/runtime/src/agent-event-pipeline/subscribers/runtime-tool-use-executor.ts`
  as mislocated. It defines the runtime tool execution service tag; it is not a
  subscriber driver. Move it under `agent-event-pipeline/tool-execution/` or a
  workflow/tool-execution module when this area is touched, and keep
  `subscribers/` for scoped observation drivers only.
- Treat `hostProjectionObserver` as a public API leak, not a helper to relocate.
  It should be deleted/replaced with existing paved roads: client-sdk projection
  waits for client-visible simulation assertions, semantic channels for
  application event/fact observation, and `RuntimeObservationStreams` for
  runtime-internal consumers. Do not create another generic projection-observer
  facade unless repeated evidence proves the existing surfaces are insufficient.

## Watchpoints

- If anyone proposes passing workflow handles or execution ids through channels,
  push back immediately. That violates the canonical firewall.
- If host-sdk grows new common execution behavior, ask why it is not a runtime
  service.
- If host-sdk code imports `host/runtime-substrate.ts` from a projection layer,
  ask whether the projection can depend on a runtime-owned capability tag
  instead. New imports from `agent-tools/`, channel bindings, or simulations
  should be treated as boundary regressions.
- If runtime code is placed under `agent-event-pipeline/subscribers/`, verify it
  is actually a scoped observation driver. Service tags such as
  `RuntimeToolUseExecutor` belong under tool-execution/workflow seams, not in
  subscribers.
- If runtime imports host-sdk, stop the lane. The guardrail should catch it, but
  the architectural review should catch it first.
- If durable-tools or wait-router names reappear, assume regression until proven
  otherwise.
- If a PR claims "ratchet" but `.dependency-cruiser.cjs` carveouts do not
  shrink, read the finding carefully. It may still be valuable if it proves no
  safe ratchet is available.
- If public docs or examples teach callers to import `RuntimeControlPlaneTable`,
  construct durable rows, or pass workflow-engine handles, stop and redirect to
  protocol/session/channel projections.
- If someone proposes "make launch/prompt a channel," ask what problem is being
  solved. Session control is normally a protocol projection; channels are for
  semantic event/fact observation and send/call faculties.
- If someone proposes deleting `control-request-reconciler.ts`, check whether
  the control request row -> workflow execution bridge has moved first. It is
  still composed by `FiregridRuntimeHostLive`.
- If someone proposes exporting `RuntimeControlRequestWorkflowEngineLive` for
  host-sdk/app composition, push back. That is the control-plane spine, not a
  public composition primitive.
- If someone proposes moving `event-channel.ts`, `state-changes-channel.ts`, or
  `human-channel.ts` wholesale into runtime, push back unless the file has grown
  execution authority. Those are presentation channel factories; injected stream
  or append bindings are acceptable.
- If a simulation imports `hostProjectionObserver` or runtime observation types
  from `@firegrid/host-sdk`, treat that as a public-surface leak to unwind. The
  simulation may need a client wait, a semantic channel, or a package-local
  `Stream` expression over a runtime tag, but not a new exported host-sdk
  observer API.
- If an end-user-facing simulation needs local wrappers around the client SDK
  for basic flows, treat that as SDK surface feedback. Do not hide it inside
  simulation-only helpers. The `acp-sdk-example-agent` sim deliberately uses
  the bare public surface across `launch`, `prompt`, `open`, `watchContexts`,
  `sessions.createOrLoad`, `sessions.attach`, scoped session prompt/start/
  snapshot/waits, scoped auto-approve, top-level permission response, and
  `sessions.prompt`. It exposed two follow-ups: `autoApprove` should be started
  after `session.whenReady` or hardened, and the SDK likely needs a typed/
  predicate output wait helper for ergonomic examples.
- If a binding package defines its own operation catalog, check protocol first.
  `packages/protocol/src/session-facade/operations.ts` already exports the
  session/client `FiregridClientOperations`; the local
  `packages/client-sdk/src/operations.ts` copy is projection-surface debt, not a
  pattern to repeat. Future REST/gRPC/JSON-RPC/MCP projections should project
  the protocol catalog rather than copy it.
- Apply the same skepticism to observation surfaces.
  `packages/protocol/src/observations/schema.ts` currently only centralizes
  source-name constants; normalized observation schemas are still spread across
  session facade, agent output, launch/runtime rows, and verified-webhook
  schemas. The target is a protocol-owned observation catalog plus runtime-owned
  stream resolvers, not more one-off observers.
- Do not read `packages/protocol/src/agent-tools/schema.ts` as "the MCP schema
  package." It is protocol-owned and currently doubles as the agent/tool
  projection catalog. Cross-surface operations should migrate toward neutral
  protocol operation entries that agent tools, client SDK, CLI, MCP, REST, gRPC,
  and JSON-RPC all project by identity.
- Treat projection-package boundaries as part of the target architecture, not
  only as naming cleanup. Client, agent/MCP, CLI, REST, gRPC, and JSON-RPC are
  environment-specific projection packages over protocol. They should not import
  each other, import runtime, or define local operation/observation catalogs.
  Host-sdk composes runtime plus selected projection adapters; it is not the
  contract owner for every surface.
- Treat direct durable-table access in projection packages as transport
  implementation, not public semantics. `client-sdk` currently materializes
  `RuntimeControlPlaneTable` / `RuntimeOutputTable` and exposes
  `FiregridRuntimeTables` / `FiregridControlPlaneTableLive`; that should shrink
  behind a named client transport/provider seam so future REST, gRPC, JSON-RPC,
  and in-process transports project the same protocol operations instead of
  reimplementing row plumbing.
- Treat `@firegrid/protocol` table declarations as shared row/provider
  mechanics, not the app-facing API. Protocol owns schemas and operation
  catalogs; public docs should not teach callers that
  `RuntimeControlPlaneTable` or `RuntimeOutputTable` is how to use Firegrid.
- Treat CLI as a projection over protocol plus host composition, not a third
  bespoke control path. `packages/cli/src/bin/run.ts` currently mixes
  `firegrid.sessions.createOrLoad`, `reconcileRuntimeControlRequestsOnce`, and
  `appendRuntimeIngress`; future CLI cleanup should collapse this behind one
  protocol-shaped command flow.
- Keep channel constructors generic over `Stream`, append `Effect`, and call
  `Effect`. DurableTable `fromCollection(...)` helpers are adapter-edge
  conveniences only. Do not let `DurableTableCollectionFacade` become the
  channel API, and move session/workflow table readers below runtime
  observation capabilities.
- Refresh or retire stale local docs/comments before using them for dispatch.
  `packages/runtime/ARCHITECTURE.md` still references old
  `@firegrid/client`/`runtime-host`/`agent-tools` surfaces, and
  `client-sdk/src/internal/projection-wait.ts` still mentions the deleted
  durable-tools wait router.
- Before treating tiny-firegrid runs as gates, verify the runner fails the
  process on driver failure. An intermediate `acp-sdk-example-agent` run had a
  driver span status error while `simulate:run` still exited zero with
  `outcome=DriverCompleted`.

## Useful Commands

```bash
git fetch origin main
git log --oneline origin/main -n 20
git show origin/main:.dependency-cruiser.cjs | sed -n '1,40p'
git grep -n "@firegrid/host-sdk" origin/main -- packages/runtime/src
git grep -n "@firegrid/runtime/durable-tools\\|wait_router\\|DurableTools" origin/main -- packages
git grep -n "RuntimeControlPlaneTable" origin/main -- packages/host-sdk/src
git grep -n "export const FiregridClientOperations" origin/main -- packages
git grep -n "defineFiregridOperation" origin/main -- packages | grep -v "packages/protocol/"
git grep -n "FiregridRuntimeObservationSourceNames" origin/main -- packages
git grep -n "@firegrid/runtime" origin/main -- packages/client-sdk packages/cli 2>/dev/null || true
git grep -n "@firegrid/client-sdk" origin/main -- packages/runtime packages/host-sdk/src/agent-tools 2>/dev/null || true
git grep -n "RuntimeControlPlaneTable\\|RuntimeOutputTable\\|FiregridRuntimeTables\\|FiregridControlPlaneTableLive" origin/main -- packages/client-sdk/src packages/cli/src
git grep -n "RuntimeControlRequestWorkflowEngineLive\\|HostRuntimeObservationSubstrateLive\\|hostProjectionObserver" origin/main -- packages/host-sdk/src
git grep -n "durable-tools wait_router\\|@firegrid/client\\|runtime-host\\|@firegrid/runtime/agent-tools" origin/main -- packages docs
bash scripts/lane-sweep.sh --json
gh pr list --state open --limit 20 --json number,title,isDraft,mergeStateStatus,statusCheckRollup,url
pnpm --filter @firegrid/tiny-firegrid simulate:run acp-sdk-example-agent
pnpm --filter @firegrid/tiny-firegrid simulate:perf 2026-05-20T22-03-21-597Z__acp-sdk-example-agent
```

## If Asked To Dispatch

Prefer dispatches with this structure:

```text
READ:
  docs/architecture/host-sdk-runtime-boundary.md
  .dependency-cruiser.cjs currentHostSdkSubstrateDebt

SCOPE:
  one or two named files only

ACCEPTANCE:
  pnpm run lint:deps
  pnpm run verify or focused package checks
  rg/grep proving the removed boundary leak
  currentHostSdkSubstrateDebt reduced or unchanged with a finding explaining why
```

Avoid broad prompts like "move host-sdk to runtime." That failure mode is already
named in the canonical doc.

## Current Private-Beta Read

Private beta is plausible after:

- deterministic factory smoke covers delegation;
- the `acp-sdk-example-agent` dynamic trace is either included as a handoff
  packet artifact or replaced by a broader client-surface data-plane tour;
- one external trigger path or a clearly accepted synthetic trigger path is
  declared beta-sufficient;
- one real side-effect adapter is either implemented or explicitly deferred from
  the first beta story;
- guardrails are green with carveouts understood.
- client/CLI/docs examples present projection-safe launch/channel usage and do
  not teach substrate handles.
- session/client operation schemas have one source of truth in protocol, with
  binding packages importing or re-exporting that catalog instead of copying it.
- projection packages are enforced as environment adapters over protocol rather
  than parallel contract owners: client, agent/MCP, CLI, REST, gRPC, and
  JSON-RPC do not import each other, do not import runtime, and do not define
  their own semantic schema catalogs.

The system does not need engine-native primitives before private beta unless
performance data says Firegrid overhead is approaching a meaningful fraction of
LLM/provider latency.

`session_new_all` is not required for private beta. Repeated `session_new` calls
are the default until evidence says a batch primitive is worth adding.

## Human Context

Gurdas has been pushing correctly against accidental registry/substrate leakage.
If there is a disagreement, reduce it to the canonical analogy:

```text
Do not pass DB drivers through business logic.
Do not pass workflow engines through agent/application code.
Channels are the semantic application surface.
Runtime owns the machinery below it.
Session/control APIs are protocol projections, not generic channels.
```

That framing has consistently clarified the right move.
