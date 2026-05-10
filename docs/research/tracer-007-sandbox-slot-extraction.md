# Tracer 007 Sandbox Slot Extraction

Date: 2026-05-10

Branch: `firegrid/tracer-007-sandbox-slot-extraction`

## Summary

Tracer 007 extracted the sandbox launch slot from `@firegrid/runtime` into two
top-level workspace packages:

- `@firegrid/sandboxes-core`
- `@firegrid/sandbox-local-process`

The repo workspace currently includes `packages/*`, not nested
`packages/sandboxes/*`, so this PR uses the tracer doc's fallback top-level
package naming.

Relevant ACIDs:

- `firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.1`
- `firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.2`
- `firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.3`
- `firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.4`
- `firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.5`
- `firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.6`
- `firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.3`
- `firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.5`

## Moved Surface

Moved out of runtime:

```txt
packages/runtime/src/data-plane/execution/sandbox/sandbox.ts
  -> packages/sandboxes-core/src/SandboxProvider.ts

packages/runtime/src/data-plane/execution/sandbox/providers/local-process.ts
  -> packages/sandbox-local-process/src/LocalProcessSandboxProvider.ts
```

Removed from `@firegrid/runtime`:

- `packages/runtime/src/data-plane/execution/sandbox/index.ts`
- `@firegrid/runtime/data-plane/execution/sandbox` export
- runtime-internal `LocalProcessSandboxProviderLive` integration path

New primary integration path:

```ts
import { SandboxProvider } from "@firegrid/sandboxes-core"
import { LocalProcessSandboxProvider } from "@firegrid/sandbox-local-process"
```

## Runtime Integration

Runtime workflow now depends only on the core sandbox contract:

```ts
import { SandboxProvider } from "@firegrid/sandboxes-core"
```

`FiregridRuntimeHostLive` wires the first provider implementation:

```ts
Layer.provide(LocalProcessSandboxProvider.layer())
```

Tracer 001 still starts runtime execution through `FiregridRuntimeHostLive`,
not scenario-local provider wiring.

## Provider Helper Shape

`@firegrid/sandbox-local-process` includes a small provider-helper sketch:

```ts
localProcess({
  cwd: "/workspace",
  env: { NODE_ENV: "test" },
  labels: { app: "example" },
})
```

This helper carries local-process provider config only. It does not carry host
stream URLs, workflow engine selection, process handles, durable-state
machinery, or materialization strategy. Full client launch integration remains
a follow-up because the current public launch input has not grown a sandbox
field yet.

## Questions Answered

### Is `SandboxProvider` the right slot name?

Yes for this tracer. The existing ACIDs and runtime workflow already use
`SandboxProvider`, and the contract maps cleanly to local process and future
remote execution providers. `ExecutionEnvironment` may be friendlier later, but
renaming now would add vocabulary churn without changing the boundary.

### Does local-process need a registry now?

No. A single `LocalProcessSandboxProvider.layer()` is enough for the current
`FiregridRuntimeHostLive` production root. A registry should wait until launch
requests can choose among multiple sandbox providers.

### Which config fields are core?

The current core `SandboxConfig` keeps only cross-provider fields already
needed or described by the spec: image/runtime hints, resources, non-durable env
values, labels, setup commands, working directory, and provider-specific config.
Local-process helper config is narrower and maps to the relevant live-provider
boundary fields.

### Should `stream(...)` be primary?

Yes. Tracer 001's durable journaling path depends on stdout/stderr/exit chunks.
`execute(...)` remains a derived convenience in the contract because it already
existed and is cheap for local process, but runtime launch uses `stream(...)`.

### What would a second provider need?

A second provider must implement the `SandboxProviderService` contract, declare
its capabilities, preserve stdout/stderr/exit stream ordering for one process
attempt, keep provider handles non-durable, and map setup/resources/env through
live provider config without introducing product/session schema.

## Stale Plane Paths

The primary sandbox API no longer lives under the stale runtime
`data-plane/execution/sandbox` path.

Remaining runtime control/data-plane paths:

- `packages/runtime/src/control-plane/runtime-context/*`
- `packages/runtime/src/data-plane/runtime-output/*`
- `packages/runtime/src/data-plane/materialization/*`

Those are outside tracer 007 scope. This PR deliberately avoids a broad runtime
control-plane/data-plane directory rewrite.

Historical docs still mention the old sandbox path as prior/current context:

- `docs/proposals/ADR_RUNTIME_CONTROL_PLANE_AND_DATA_PLANE_BOUNDARY.md`
- `docs/tracers/HANDOFF_FIREGRID_DURABLE_AGENT_TRACERS_2026-05-08.md`
- `docs/tracers/009-required-action-workflow.md`

Those references were not rewritten here because tracer 007 owns implementation
alignment and this result report, not historical handoffs or future tracer
briefs.

## Validation Notes

The local-process provider tests cover:

- provider contract shape;
- live sandbox identity/state/provider metadata;
- declared capabilities;
- stdout/stderr/exit stream chunks;
- provider-helper shape without durable host authority.

The scenario E2E proof is:

- `scenarios/firegrid/src/tracer-007.test.ts`
- test name: `firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.1 firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.6 firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.3 firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.5 journals stdout stderr and exit through FiregridRuntimeHostLive`

That scenario starts from public `Firegrid.launch(...)`, runs through the
exported `@firegrid/runtime` `FiregridRuntimeHostLive` / `startRuntime` surface,
reads retained Durable Streams runtime-output rows for stdout/stderr, and
asserts the exited run snapshot from the production runtime host path.
