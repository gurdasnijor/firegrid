# 006: Runtime Host Root And Launch Boundary

## Objective

Prove the separation between runtime-host configuration and client launch
requests with a production composition surface.

The host root chooses infrastructure and provider wiring. A client launch
request describes one agent request. Scenario tests may configure and invoke
the production root, but they must not own the only working Layer graph.

## Why This Runs In Parallel With 008

Tracer 006 owns the runtime host root and launch/request boundary. Tracer 008
owns the materialization strategy abstraction that this root will eventually
select.

Do not make 006 depend on a finished materialization strategy. The host root
may include a narrow placeholder or current production projection surface, but
it should not move materialization files or define the strategy API.

## Current Ground Truth

The current production-ish execution surface is `startRuntime(...)` in:

```txt
packages/runtime/src/control-plane/runtime-context/launcher.ts
```

That function currently accepts host-wide stream choices:

```ts
type StartRuntimeOptions = {
  runtimeStreamUrl: string
  controlPlaneStreamUrl?: string
  dataPlaneStreamUrl?: string
  workflowStreamUrl?: string
  contextId: string
  workerId?: string
}
```

It also builds the runtime Layer graph internally:

```txt
RuntimeContextWorkflowLayer
  + Durable Streams workflow engine layer
  + RuntimeControlPlaneLive
  + RuntimeCaptureJournalLive
```

This is useful as a tracer 001 implementation, but it blurs two planes:

- host config: stream URLs, worker id, workflow engine, materialization strategy,
  provider registry;
- launch request: context id and the desired managed-agent runtime shape.

## Target Shape

Introduce a small production root that owns host-wide runtime wiring. Do not
invent a full `RuntimeHost` framework or split all launch-slot packages yet.

The shape should be close to:

```ts
const FiregridRuntimeHostLive = FiregridRuntimeHost.layer({
  streams: {
    workflow: workflowStreamUrl,
    controlPlane: controlPlaneStreamUrl,
    runtimeOutput: runtimeOutputStreamUrl,
  },
  workerId,
})

yield* FiregridRuntimeHost.start({
  contextId,
}).pipe(Effect.provide(FiregridRuntimeHostLive))
```

Or, if a service wrapper is too much for the current code, use a named Layer
factory plus a program:

```ts
const Live = RuntimeHostLive({
  streams,
  workerId,
})

yield* startRuntimeContext({ contextId }).pipe(Effect.provide(Live))
```

The important boundary:

```txt
Host root options
  stream URLs
  worker id
  workflow engine substrate
  runtime control-plane store
  runtime output journal
  materialization backend, if current code needs it

Launch request
  context id
  current runtime request shape
  no stream URLs
  no workflow engine selection
  no materialization backend selection
  no provider registry construction
```

## Non-Goals

- Do not create `packages/runtimes/*`, `packages/sandboxes/*`,
  `packages/tools/*`, or `packages/secrets/*`.
- Do not design the final `RuntimeHost` abstraction if the current code only
  needs a small root Layer/program.
- Do not move materialization into its final package shape.
- Do not change the durable stream as the invocation boundary.
- Do not reintroduce client-provided stream URLs into launch request types.

## Implementation Guidance

Start from the current runtime context launcher.

Likely code movement:

```txt
packages/runtime/src/control-plane/runtime-context/launcher.ts
  keep: launch/request-shaped program
  remove: host stream topology construction if possible

packages/runtime/src/runtime-host/
  add: host root service or layer factory
  owns: stream topology, workflow engine layer, runtime control plane layer,
        runtime output layer
```

Primary write scope:

```txt
packages/runtime/src/runtime-host/**
packages/runtime/src/control-plane/runtime-context/**
packages/runtime/src/index.ts
scenarios/firegrid/src/tracer-001.test.ts
```

Avoid touching:

```txt
packages/runtime/src/data-plane/materialization/**
packages/materialization/**
scenarios/firegrid/src/tracer-002.test.ts
```

Those are owned by tracer 008.

If tracer 005 has landed first, the host root should consume:

```ts
import { DurableStreamsWorkflowEngine } from "@firegrid/durable-streams"
```

If tracer 005 has not landed in the branch being tested, keep the same shape but
use the current workflow-engine layer as a temporary dependency. Do not block
006 design on the substrate extraction.

## Acceptance Criteria

1. There is a production runtime-host root surface in package source, not only
   scenario/test setup.
2. The runtime-host root owns stream topology and workflow engine selection.
3. The client/launch-shaped program no longer accepts host-owned stream URLs.
4. Existing tracer 001 execution still runs through production package code.
5. Scenario tests configure the host root and call the launch/runtime program;
   they do not assemble the core Layer graph themselves.
6. The PR/report lists any host-owned concerns that remain in launch request
   types and why they could not be removed yet.

## Validation

Run the relevant checks for the implementation scope:

```sh
pnpm --filter @firegrid/runtime run typecheck
pnpm --filter @firegrid/runtime run test
pnpm --filter @firegrid/scenario-firegrid run typecheck
pnpm --filter @firegrid/scenario-firegrid test -- tracer-001.test.ts
pnpm run check:docs
pnpm run check:specs
pnpm run lint:deps
```

If any check is not applicable in the current branch, record why in the PR or
tracer result.

## Questions To Answer

- Is the smallest useful production root a service Tag, a Layer factory, a
  program function, or a combination?
- Which current `StartRuntimeOptions` fields are host-owned versus launch-owned?
- Does the root become clearer after tracer 005 extracts
  `@firegrid/durable-streams`?
- Does this reveal an immediate need for a sandbox slot package, or can that
  wait for tracer 007?
