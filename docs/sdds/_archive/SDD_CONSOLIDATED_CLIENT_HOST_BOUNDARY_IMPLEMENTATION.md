> **HISTORICAL (pre-#765).** References paths deleted in #765 (packages/substrate, packages/host-sdk/src/host, and legacy packages/runtime/src/{subscribers,durable-tools,workflow-engine,agent-event-pipeline,agent-tools,runtime-host,composition}); kept for provenance. Current architecture: docs/cannon/.

# SDD: Consolidated Client/Host Boundary Implementation

Status: draft - implementation design only, no production code
Created: 2026-05-18
Owner: Firegrid Client SDK / Host SDK boundary

## Signoff Input

Gurdas signed off on Option 1 from
`SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY.md`:

- client writes durable intent;
- host-side reconciler materializes and starts;
- `session.start()` becomes request/ack;
- CLI/factory migrate to a host-owned synchronous start surface in the same
  transaction;
- no temporary compatibility wait helper;
- do not foreclose future host auto-start via `startOnCreate: true`.

This SDD scopes the implementation transaction. It still does not change
production code.

## Host-Owned Synchronous Start Surface

Use the existing host API as the migration target:

- API: `startRuntime(options: StartRuntimeOptions)`
- Location: `packages/host-sdk/src/host/commands.ts`
- Public export: `@firegrid/host-sdk/host` via
  `packages/host-sdk/src/host/index.ts`
- Result type: `StartRuntimeResult` from
  `packages/host-sdk/src/host/types.ts`

This is already host-owned. It requires the host environment, calls
`requireLocalContext(options.contextId)`, claims the runtime engine, reconciles
pending input, and runs the existing runtime-context workflow.

Same-transaction migrations:

- `packages/cli/src/bin/run.ts`: after `firegrid.sessions.createOrLoad()`,
  keep appending the initial prompt through `appendRuntimeIngress()`, then call
  `startRuntime({ contextId: session.contextId })` for the synchronous exit
  code instead of `session.start()`.
- `apps/factory/src/host.ts`: `startFactoryPlanner()` attaches/knows the
  planner context id, then calls `startRuntime({ contextId:
  run.plannerContextId })` instead of `session.start()`.

Do not add a client compatibility wait helper. If CLI/factory need terminal
results, they are host programs and must use the host start surface.

## Protocol Shape

Make the #327 request rows live by adding them to the durable control plane:

- `RuntimeControlPlaneTable.contextRequests`
  - schema: `RuntimeContextRequestRowSchema`
  - client-written, idempotent by deterministic `requestId`;
  - carries full `PublicLaunchRuntimeIntent`.

- `RuntimeControlPlaneTable.startRequests`
  - schema: `RuntimeStartRequestRowSchema`
  - client-written, idempotent by deterministic `requestId`;
  - returns immediately to the client as an acknowledgement.

`PublicLaunchRuntimeIntentSchema` already includes the TFIND-038 fields:
`argv`, `cwd`, `agent`, `envBindings`, `agentProtocol`, and `mcpServers`.
Implementation must preserve those fields through `RuntimeContextRequestRow`
and into `normalizeRuntimeIntent()` when the host materializes the bound
context.

Add host-written reconciliation state rows, but do not add a new locking or
lease abstraction. The state is intentionally just durable facts written
through the existing `DurableTable.insertOrGet` primary-key fence:

- `RuntimeControlRequestClaimRow`
  - table: `RuntimeControlPlaneTable.controlRequestClaims`
  - fields: `claimId`, `requestKind`, `requestId`, `contextId`, `hostId`,
    `hostSessionId`, `claimWindowStartedAtMs`, `claimWindowExpiresAtMs`,
    `claimedAtMs`.
  - `claimId` is deterministic per request/window. `insertOrGet` is the only
    winner election mechanism.

- `RuntimeControlRequestCompletionRow`
  - table: `RuntimeControlPlaneTable.controlRequestCompletions`
  - fields: `requestId`, `requestKind`, `contextId`, `status`, `hostId`,
    `completedAtMs`, optional `activityAttempt`, optional `exitCode`,
    optional `signal`, optional `message`.
  - `requestId` is the primary key. The first terminal row wins; later
    claimants can only observe it.

Completion `status` values:

- `succeeded`
- `failed`
- `abandoned`

Do not add `startOnCreate` behavior or schema in this transaction. Keep the
request shape extensible so a future optional field can be added without
changing request identity:

```ts
readonly startOnCreate?: boolean
```

When added later, it should default to absent/false. That leaves room for the
rejected Option 2 to layer on top later without changing the request identity.

## Client SDK Changes

`packages/client-sdk/src/firegrid.ts` changes:

- `launch()`
  - decode `PublicLaunchRequest`;
  - allocate a `contextId`;
  - write `RuntimeContextRequestRow` using the full public runtime intent;
  - return `open(contextId)` or the signed-off handle shape;
  - remove `CurrentHostSession` from the effect environment.

- `sessions.createOrLoad()`
  - decode `SessionCreateOrLoadInput`;
  - compute `contextId` with `sessionContextIdForExternalKey`;
  - write `RuntimeContextRequestRow` with `insertOrGet`;
  - return `makeSessionHandle(contextId)`;
  - remove `CurrentHostSession` from the effect environment.

- `FiregridSessionHandle.start()`
  - write `RuntimeStartRequestRow` with `insertOrGet`;
  - return a request ack, not `RuntimeStartResult`;
  - remove `RuntimeStartCapability` from the effect environment.

Suggested ack shape:

```ts
export interface RuntimeStartRequestAck {
  readonly requestId: string
  readonly contextId: string
  readonly inserted: boolean
}
```

The ack is not a terminal result. Terminal status remains observable through
existing projections: `snapshot()`, `wait.*`, output rows, and run rows.

## Host-Side Reconciler

Add the reconciler in host-sdk:

- Module: `packages/host-sdk/src/host/control-request-reconciler.ts`
- Service/layer: `RuntimeControlRequestReconcilerLive`
- One-shot API for tests: `reconcileRuntimeControlRequestsOnce()`
- Long-running API for hosts: `runRuntimeControlRequestReconciler(options)`

`runRuntimeControlRequestReconciler` runs inside a host environment that
provides `CurrentHostSession`, `RuntimeControlPlaneTable`,
`RuntimeContextEngineRegistry`, `AgentToolHost`, and the existing workflow
support required by `startRuntime`.

Loop:

1. Query pending `contextRequests`.
2. For each request, reconcile context materialization.
3. Query pending `startRequests`.
4. For each request, reconcile start execution.
5. Sleep for the configured poll interval and repeat.

Default options:

```ts
export interface RuntimeControlRequestReconcilerOptions {
  readonly pollIntervalMs?: number // default 5_000
  readonly claimWindowMs?: number // default 60_000
  readonly abandonAfterMs?: number // default 600_000
}
```

Host layers that are meant to process remote client requests should fork this
reconciler. Tests can use the one-shot API to keep assertions deterministic.

## Failure Semantics

These semantics are load-bearing.

Primitive-based claim window:

- Default `claimWindowMs`: 60 seconds.
- A claim id is deterministic per request and window:
  - context: `ctx_req_claim:${requestId}:${claimWindowStartedAtMs}`
  - start: `start_req_claim:${requestId}:${claimWindowStartedAtMs}`
- A host claims by `insertOrGet` on
  `RuntimeControlPlaneTable.controlRequestClaims`.
- If another host already owns the current claim window, this host skips the
  request until the next scan.
- If the current claim window expires without success, the request becomes
  eligible for another claim window.
- This is not a package-owned lease/mutex layer. `DurableTable.insertOrGet`
  already provides the first-writer-wins row fence; the reconciler uses it
  directly and treats the returned `_tag` as the election result.

Timeout/abandon:

- Default `abandonAfterMs`: 10 minutes from request `createdAt`.
- If no host has successfully materialized a context request before
  `abandonAfterMs`, the reconciler writes an `abandoned` completion row and
  stops materializing that request.
- If no host has successfully completed a start request before
  `abandonAfterMs`, the reconciler writes an `abandoned` completion row and
  stops executing that request.
- A later host must not revive abandoned requests. The client can issue a new
  logical request only by using a new context/session identity or by a future
  explicit reset API.
- Abandon is also written with `insertOrGet`. If a completion row already
  exists, abandon loses and observes the existing terminal status; if abandon
  wins, later success/failure writes observe the abandoned row and do not
  replace it.

Context idempotency:

- Client request id is deterministic from `contextId`.
- The host first checks `controlRequestCompletions` for the `requestId`. If a
  terminal row exists, it skips the request.
- Host materialization must use `contexts.insertOrGet(...)`, not blind
  `upsert(...)`.
- If the context row already exists, materialization is treated as succeeded.
- The host records `succeeded` by `insertOrGet` on
  `controlRequestCompletions`. If an `abandoned` row won first, the success
  write observes it and the request remains terminally abandoned.
- If a late claimant resumes after its window expired, `contexts.insertOrGet`
  prevents overwriting the host binding chosen by the winning materializer.

Start idempotency and duplicate-start suppression:

- Client start request id is deterministic from `contextId` in v1.
- Before starting, the host checks `controlRequestCompletions` for the
  `requestId`. If present, it returns/skips.
- The host claims the current start window with `insertOrGet`.
- The host then calls `startRuntime({ contextId })`.
- On success/failure result, it writes `RuntimeControlRequestCompletionRow`.
- Duplicate execution is suppressed by:
  - one winning claim per request/window from DurableTable's row fence;
  - terminal completion-row check before execution;
  - first-writer-wins completion row after execution;
  - existing deterministic `runtimeContextWorkflowExecutionId(contextId)` in
    the workflow engine path;
  - `RuntimeContextEngineRegistry.claimActive()` within the host process.

Known consequence:

- A host crash after claim but before completion waits until the next
  `claimWindowMs` before another host/session can retry.
- A process pause longer than the claim window can race with a retry. The
  completion-row check plus first-writer-wins completion insert plus
  deterministic workflow execution id are the final duplicate-start guards.

Property-preservation argument:

- Claim idempotency: the primary key for each claim is a pure function of
  `requestKind`, `requestId`, and the 60s window start. Re-running the same
  host or a different host in the same window converges on one row.
- Exactly one winner per request/window: `insertOrGet` writes through
  DurableTable's existing append-with-producer primary-key fence. One caller
  gets `_tag: "Inserted"`; contenders get `_tag: "Found"` and skip.
- Duplicate-start suppression: a start request must pass the terminal-row
  check, win the window claim, then call the existing host-owned
  `startRuntime`. The run path already uses `claimActive()` and
  `runtimeContextWorkflowExecutionId(contextId)`; the terminal completion row
  is another first-writer-wins durable fact, not a replacement execution
  system.
- No lost requests: request rows remain append-only durable rows until a
  terminal completion row exists. A host crash before completion leaves the
  request visible to the next scan/window.
- No zombie revival: abandon is a terminal completion row keyed by
  `requestId`. Once written, later reconciliation observes it before work and
  later completion attempts cannot overwrite it.

## Sequencing

Implement as one transaction after this SDD is signed off:

1. Protocol
   - add request tables and host-written claim/completion rows;
   - keep `RuntimeContextRequestRow` compatible with a future optional
     `startOnCreate?: boolean` field, but do not add that field yet;
   - add schema/constructor tests.

2. Host SDK
   - add control-request reconciler module;
   - use `insertOrGet` materialization for context requests;
   - call existing `startRuntime` for start requests;
   - export reconciler APIs/layer;
   - wire reconciler into the host layers that should process remote client
     requests.

3. Client SDK
   - write `RuntimeContextRequestRow` from `launch()` and
     `sessions.createOrLoad()`;
   - write `RuntimeStartRequestRow` from `session.start()`;
   - update exported types and operation/projection schemas;
   - remove `CurrentHostSession` and `RuntimeStartCapability` from those
     client paths.

4. CLI/factory
   - migrate synchronous terminal execution to `startRuntime({ contextId })`;
   - remove reliance on `session.start()` for terminal results.

5. Tiny-firegrid/tests
   - update configurations that currently reach past by manually constructing
     contexts or extracting `RuntimeStartCapability`;
   - assert request rows, host reconciliation, run rows, and output
     projections through public surfaces.

6. Findings/docs
   - update TFIND-001/002/003/004/008/038/039 ledger statuses only after the
     implementation lands and tests prove the reach-past is gone.

## Blast Radius

- `packages/protocol`
- `packages/client-sdk`
- `packages/host-sdk`
- `packages/cli`
- `apps/factory`
- `packages/firelab`
- relevant tests in each package
- SDD/spec references for client-host boundary and session facade semantics

## CI Gate Plan

Before opening the implementation PR for merge:

```bash
pnpm run check:specs
pnpm run check:docs
pnpm --filter @firegrid/protocol test
pnpm --filter @firegrid/client-sdk test
pnpm --filter @firegrid/host-sdk test
pnpm --filter @firegrid/cli test
pnpm --filter firelab test
pnpm run typecheck
pnpm run lint
pnpm run lint:effect-quality
pnpm run verify
```

If package names differ from the filters above, use the repo's actual package
filters discovered from `pnpm-workspace.yaml` and `package.json`.

Current known blocker outside this SDD-only PR: `pnpm run check:specs` fails
on `features/firegrid/firegrid-durable-tools.feature.yaml` line 15 column 406.
The implementation PR must either land after that spec parse issue is fixed or
include a separately approved fix if it is still present.

## Non-Goals

- No production code before coordinator review and Gurdas signoff.
- No temporary client wait helper for terminal start results.
- No host auto-start behavior in this transaction.
- No permanent parallel path where client APIs can either hold host
  capabilities or write durable requests.
