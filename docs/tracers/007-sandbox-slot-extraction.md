# 007: Sandbox Slot Extraction

## Objective

Prove the first launch-slot package boundary by extracting sandbox execution
behind a package-shaped slot while keeping tracer 001's runtime-output journaling
path intact.

The load-bearing claim is:

```txt
client launch request chooses a sandbox provider helper
  -> runtime host resolves the sandbox provider registry
  -> runtime workflow depends only on the sandbox slot contract
  -> local process remains the first provider implementation
```

This tracer should make the sandbox dimension easy to swap later for
ComputeSDK, Docker, Kubernetes, E2B, Daytona, Firebox, Modal, or customer-owned
execution without changing runtime-output journaling.

## Why This Is Load Bearing

Sandbox is the most grounded launch slot. Tracer 001 already depends on process
streaming, and every real runtime adapter will need an execution environment.

If this slot boundary works, the remaining launch slots can follow the same
pattern:

```txt
runtimes/core + runtime-acp
sandboxes/core + sandbox-local-process
workspaces/core + workspace-git
tools/core + tool-mcp
secrets/core + secrets-env
```

If it does not work, the target package model should be revised before creating
more slot packages.

## Relationship To Parallel Tracers

Tracer 006 has landed the runtime-host root and launch/request boundary. Tracer
007 owns only the sandbox slot contract and local-process provider extraction.
Start from the current `FiregridRuntimeHostLive` wiring rather than
reconstructing runtime layers in scenarios.

Tracer 008 has landed the staged materialization strategy surface. Do not touch
materialization files.

## Current Ground Truth

Current sandbox code lives inside runtime:

```txt
packages/runtime/src/data-plane/execution/sandbox/
  sandbox.ts
  providers/local-process.ts
  index.ts
```

Current workflow usage:

```txt
packages/runtime/src/control-plane/runtime-context/workflow.ts
  -> SandboxProvider.stream(...)
  -> workflow activity journals stdout/stderr to runtime-output durable events
```

Current host wiring:

```txt
packages/runtime/src/runtime-host/index.ts
  -> LocalProcessSandboxProviderLive
  -> FiregridRuntimeHostLive(...)
```

Relevant existing ACIDs:

- `firegrid-platform-invariants.PRODUCTION_SURFACE.5`
- `firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.1`
- `firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.2`
- `firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.3`
- `firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.4`
- `firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.5`
- `firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.6`
- `firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.3`
- `firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.5`

Update specs first if the implementation needs behavior not covered by those
requirements.

## Target Shape

Preferred package shape:

```txt
packages/sandboxes/
  core/
    package.json       # @firegrid/sandboxes-core
    src/
      SandboxProvider.ts
      SandboxConfig.ts
      SandboxCommand.ts
      ProcessOutputChunk.ts
      SandboxProviderRegistry.ts
      index.ts
  local-process/
    package.json       # @firegrid/sandbox-local-process
    src/
      LocalProcessSandboxProvider.ts
      index.ts
```

If the repo package tooling makes nested packages awkward, use equivalent
top-level package names:

```txt
packages/sandbox-local-process
packages/sandboxes-core
```

Use whatever package naming fits the repo's current package conventions, but do
not leave local process as a random runtime-internal provider if the slot
boundary is proven.

The runtime workflow should depend on the core contract:

```ts
const provider = yield* SandboxProvider
const sandbox = yield* provider.getOrCreate(config)
const chunks = provider.stream(sandbox, command)
```

The local-process package should provide:

```ts
LocalProcessSandboxProvider.layer(...)
```

or another narrow Effect Layer that satisfies the core `SandboxProvider` tag.

## Provider Helper Boundary

This tracer should sketch, and implement only if cheap, a provider-helper value
that can appear in the client launch request later:

```ts
firegrid.launch({
  sandbox: localProcess({
    cwd: "/workspace",
    env: { NODE_ENV: "test" },
  }),
  // runtime/workspace/tools omitted for this tracer
})
```

The helper must not carry host stream URLs, workflow engine choices,
materialization strategy, process handles, or raw durable-state machinery.

If the current client launch surface is not ready for this helper, document the
shape and leave full launch integration to a follow-up.

## Non-Goals

- Do not build ComputeSDK/Docker/E2B/remote providers.
- Do not add workspace mounting or file sync unless current tests require it.
- Do not move runtime-output journaling into the sandbox provider.
- Do not make process handles, PIDs, pipes, sockets, or SDK clients durable
  authority.
- Do not change the runtime host root beyond import/provider wiring required to
  keep tracer 001 passing.
- Do not touch materialization.

## Write Scope

Primary:

```txt
packages/runtime/src/data-plane/execution/sandbox/**
packages/sandboxes/**
packages/sandbox-local-process/**
packages/sandboxes-core/**
packages/*/package.json
features/firegrid/firegrid-durable-launch-runtime-operator.feature.yaml
scenarios/firegrid/src/tracer-001.test.ts
```

Expected integration touch:

```txt
packages/runtime/src/runtime-host/**
packages/runtime/src/index.ts
```

Avoid unless required for integration:

```txt
packages/runtime/src/control-plane/runtime-context/workflow.ts
packages/runtime/src/data-plane/materialization/**
scenarios/firegrid/src/tracer-002.test.ts
```

Integrate through the public host root. Do not create a new scenario-local
composition root to prove the provider split.

## Acceptance Criteria

1. A sandbox core package or package-shaped module exposes the common
   `SandboxProvider` contract.
2. A local-process provider package or package-shaped module satisfies that
   contract through an Effect Layer.
3. Runtime workflow code no longer owns local-process implementation details.
4. Tracer 001 still proves that sandbox stdout/stderr chunks become durable
   runtime-output data-plane events.
5. Scenario tests invoke production package surfaces; they do not become the
   only place local-process provider wiring works.
6. A tracer 007 scenario-level E2E invokes the production host root, starts a
   runtime through `@firegrid/runtime`, and observes retained runtime-output
   rows produced through the extracted sandbox provider path.
7. `@firegrid/runtime` no longer exports a runtime-internal local-process
   provider surface as the primary integration path.
8. The PR/report states whether the package split earned itself or should remain
   staged under runtime for one more tracer.
9. The PR/report lists what a second sandbox provider would need to implement
   next, based on the actual extracted contract.

## Validation

Run the relevant checks for the implementation scope:

```sh
pnpm --filter @firegrid/runtime run typecheck
pnpm --filter @firegrid/runtime run test
pnpm --filter @firegrid/scenario-firegrid run typecheck
pnpm --filter @firegrid/scenario-firegrid test -- tracer-001.test.ts
pnpm run check:docs
pnpm run check:specs
pnpm run lint
pnpm run lint:deps
pnpm run lint:dup
pnpm run lint:dead
pnpm run lint:effect-quality
```

If new sandbox packages are introduced, run their package-specific
typecheck/tests too.

## Questions To Answer

- Is `SandboxProvider` the right slot name, or should the public core package
  expose `Sandbox` / `ExecutionEnvironment` vocabulary?
- Does local-process need a provider registry now, or is a single Layer enough
  until tracer 006 host root consumes registries?
- Which `SandboxConfig` fields are truly core versus local-process-specific?
- Should `stream(...)` be the primary required operation and `execute(...)` be a
  derived helper, or should both remain in the core contract?
- What must be true for a remote provider to preserve tracer 001's durable
  output ordering guarantees?
