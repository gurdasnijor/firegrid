# tf-2y01 import guardrails baseline

Date: 2026-05-20

Base: `6860203b2` for `codex/tf-wtgc-lint-guardrails-error-flip`.

Canonical source: `docs/architecture/host-sdk-runtime-boundary.md`.

## Rule Posture

PR #498 added dependency-cruiser guardrails in report mode (`severity: "warn"`). After #508 calibrated the Effect diagnostics gate, `tf-wtgc` flips the scan rules to hard errors.

Existing hard zero package-direction rules remain in place:

- `runtime-no-host-sdk`
- `client-sdk-no-runtime`

Lane D now enforces hard-error scan mirrors for those package directions plus host-sdk-specific scan rules for runtime subpath and substrate imports.

## Proposed Sanctioned Runtime Capability Subpaths

These are the runtime subpaths the first-slice rule allows host-sdk binding/composition modules to import:

| Runtime subpath | Resolved file | Rationale |
|---|---|---|
| `@firegrid/runtime/errors` | `packages/runtime/src/runtime-errors.ts` | Shared error types crossing the binding/runtime boundary. |
| `@firegrid/runtime/tool-executor` | `packages/runtime/src/agent-event-pipeline/subscribers/runtime-tool-use-executor.ts` | Runtime-owned capability tag; host-sdk provides the live implementation. |
| `@firegrid/runtime/control-plane` | `packages/runtime/src/authorities/index.ts` | Narrow runtime authority/capability surface currently composed by host-sdk. |
| `@firegrid/runtime/runtime-output` | `packages/runtime/src/agent-event-pipeline/authorities/runtime-output-public.ts` | Public runtime-output observation authority surface. |
| `@firegrid/runtime/streams` | `packages/runtime/src/streams/index.ts` | Substrate-neutral stream observation types. |
| `@firegrid/runtime/events` | `packages/runtime/src/agent-event-pipeline/events/index.ts` | Event schemas shared with binding code. |
| `@firegrid/runtime/codecs` | `packages/runtime/src/agent-event-pipeline/codecs/index.ts` | Codec adapter surface currently consumed at host composition edges. |
| `@firegrid/runtime/agent-adapters` | `packages/runtime/src/agent-adapters/index.ts` | Runtime adapter composition surface; still subject to review as substrate moves down. |
| `@firegrid/runtime/sources/sandbox` | `packages/runtime/src/agent-event-pipeline/sources/sandbox/index.ts` | Host-bound sandbox provider options and live composition surface. |

Not sanctioned by this first-slice rule:

- `@firegrid/runtime/workflow-engine`
- `@firegrid/runtime/durable-tools`
- direct imports of runtime implementation files below exported subpath barrels
- `effect-durable-operators` durable table facades from host-sdk binding modules

This list remains the sanctioned host-sdk-to-runtime import surface for the hard gate:

- `@firegrid/runtime/errors`
- `@firegrid/runtime/tool-executor`
- `@firegrid/runtime/control-plane`
- `@firegrid/runtime/runtime-output`
- `@firegrid/runtime/streams`
- `@firegrid/runtime/events`
- `@firegrid/runtime/codecs`
- `@firegrid/runtime/agent-adapters`
- `@firegrid/runtime/sources/sandbox`

The list is intentionally narrow. Workflow-engine, durable-tools, runtime implementation files below exported barrels, and durable table facades remain outside the sanctioned surface.

## Baseline Command

```bash
pnpm run lint:deps
```

Initial warning-mode result from PR #498:

```text
x 11 dependency violations (0 errors, 11 warnings). 221 modules, 547 dependencies cruised.
```

Raw hard-flip result on `6860203b2` before adding current-debt carveouts:

```text
x 25 dependency violations (25 errors, 0 warnings). 228 modules, 563 dependencies cruised.
```

Final hard-gate result after explicit current-debt carveouts:

```text
✔ no dependency violations found (228 modules, 563 dependencies cruised)
```

## Original Warning List

| Rule | From | To |
|---|---|---|
| `host-sdk-no-unsanctioned-runtime-subpaths-scan` | `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` | `packages/runtime/src/durable-tools/index.ts` |
| `host-sdk-no-unsanctioned-runtime-subpaths-scan` | `packages/host-sdk/src/host/control-request-reconciler.ts` | `packages/runtime/src/workflow-engine/index.ts` |
| `host-sdk-no-unsanctioned-runtime-subpaths-scan` | `packages/host-sdk/src/host/host-owned-durable-tools.ts` | `packages/runtime/src/durable-tools/index.ts` |
| `host-sdk-no-unsanctioned-runtime-subpaths-scan` | `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts` | `packages/runtime/src/workflow-engine/index.ts` |
| `host-sdk-no-unsanctioned-runtime-subpaths-scan` | `packages/host-sdk/src/host/runtime-input-deferred.ts` | `packages/runtime/src/workflow-engine/index.ts` |
| `host-sdk-no-workflow-or-durable-substrate-scan` | `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` | `packages/runtime/src/durable-tools/index.ts` |
| `host-sdk-no-workflow-or-durable-substrate-scan` | `packages/host-sdk/src/host/control-request-reconciler.ts` | `packages/runtime/src/workflow-engine/index.ts` |
| `host-sdk-no-workflow-or-durable-substrate-scan` | `packages/host-sdk/src/host/host-owned-durable-tools.ts` | `packages/runtime/src/durable-tools/index.ts` |
| `host-sdk-no-workflow-or-durable-substrate-scan` | `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts` | `packages/runtime/src/workflow-engine/index.ts` |
| `host-sdk-no-workflow-or-durable-substrate-scan` | `packages/host-sdk/src/host/runtime-input-deferred.ts` | `packages/runtime/src/workflow-engine/index.ts` |
| `host-sdk-no-workflow-or-durable-substrate-scan` | `packages/host-sdk/src/host/session-log-channel.ts` | `packages/effect-durable-operators/src/index.ts` |

## Interpretation

The warnings match the architecture doc's expected debt shape:

- Lane B should reduce `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` by splitting validated execution into runtime-owned services and leaving host-sdk with protocol decoding and `ToolResult` adaptation.
- Lane C should reduce `runtime-context-workflow-runtime.ts`, `runtime-input-deferred.ts`, and `control-request-reconciler.ts` by moving or wrapping workflow definitions/execution mechanics under runtime-owned subpaths.
- Phase-1 cleanup should remove the remaining durable-tools import in `host-owned-durable-tools.ts`.
- `session-log-channel.ts` is a channel binding that currently reaches a durable table facade directly. It may stay in host-sdk only if the public surface remains semantic channel binding and the durable table access is wrapped behind a sanctioned runtime capability.

The scan mirrors for runtime-to-host-sdk and client-sdk-to-runtime reported zero warnings. The existing hard rules already enforce those directions.

## Current Hard-Gate Carveouts

The raw hard flip showed that Lanes B/C did not fully eliminate all host-sdk substrate imports before this slice. Those violations are not mechanical in scope for `tf-wtgc`; they are the remaining boundary-refactor surface. The hard rules now exclude only these existing debt files, so new host-sdk files and any non-carved-out import sites fail immediately.

Current count after `tf-rb9e`: 8 files.

| Carved-out file | Remaining substrate import class |
|---|---|
| `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` | workflow clock / workflow definitions |
| `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts` | workflow definitions |
| `packages/host-sdk/src/host/control-request-reconciler.ts` | workflow engine and workflow definitions |
| `packages/host-sdk/src/host/internal/runtime-context-helpers.ts` | workflow definitions |
| `packages/host-sdk/src/host/runtime-context-workflow-core.ts` | workflow definitions |
| `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts` | workflow engine |
| `packages/host-sdk/src/host/runtime-input-deferred.ts` | workflow engine |
| `packages/host-sdk/src/host/session-log-channel.ts` | durable table facade |

The package-direction mirror rules have no carveouts:

- `runtime-no-host-sdk-scan`: hard error, zero current violations.
- `client-sdk-no-runtime-scan`: hard error, zero current violations.

## Carveout Removal Plan

Remove entries from `currentHostSdkSubstrateDebt` as the owning refactors land:

1. Lane B moves the execution arms out of `agent-tools/execution` or replaces workflow-substrate imports with sanctioned runtime capabilities.
2. Lane C moves workflow definitions/execution mechanics out of host-sdk or replaces direct workflow-engine/workflow-definition imports with sanctioned runtime-owned capability tags.
3. The durable-tools deletion path removes `host-owned-durable-tools.ts` and any `@firegrid/runtime/durable-tools` imports.
4. Channel binding work wraps `session-log-channel.ts` durable table access behind a sanctioned runtime capability or moves that substrate access below the boundary.

After each cleanup, delete the corresponding carveout and re-run `pnpm run lint:deps`. The target end state is an empty `currentHostSdkSubstrateDebt` list with all four scan rules still at `severity: "error"`.

## tf-6ezj Recheck

Date: 2026-05-20

Base: current `origin/main` for `codex/tf-6ezj-ratchet-carveouts-down`.

Result: no carveouts removed. The list remains 12 files.

All 12 carved-out files still exist under `packages/host-sdk/`. A no-carveout dependency-cruiser probe still reports 25 hard violations across the same files, so each existing carveout remains necessary on current main.

Command:

```bash
pnpm exec depcruise --config /tmp/tf-6ezj-dependency-cruiser-no-carveouts.cjs packages
```

No-carveout result:

```text
x 25 dependency violations (25 errors, 0 warnings). 234 modules, 576 dependencies cruised.
```

Normal gate result with the existing carveouts:

```text
✔ no dependency violations found (234 modules, 576 dependencies cruised)
```

Removed files:

```text
(none)
```

## tf-1glx Retry After Durable-Tools Deletion

Date: 2026-05-20

Base: current `origin/main` for `codex/tf-1glx-ratchet-carveouts-retry`, after PR #519 (`ec639aad8`) deleted durable-tools.

Result: 1 carveout removed. The list moves from 12 files to 11 files.

Removed carveout:

```text
packages/host-sdk/src/host/host-owned-durable-tools.ts
```

Why removed: the file no longer exists after the final durable-tools deletion. Removing its carveout keeps `pnpm run lint:deps` green. The old durable-tools carveout for `tool-use-to-effect.ts` is also gone, but that file still needs a carveout for workflow-substrate imports.

No-carveout probe after #519:

```text
x 23 dependency violations (23 errors, 0 warnings). 219 modules, 529 dependencies cruised.
```

Normal gate after removing the stale carveout:

```text
✔ no dependency violations found (219 modules, 529 dependencies cruised)
```

## tf-emxk Shim Retirement

Date: 2026-05-20

Base: current `origin/main` for `codex/tf-emxk-shim-retirement-ratchet`.

Result: 2 carveouts removed. The list moves from 11 files to 9 files.

Removed shim carveouts:

```text
packages/host-sdk/src/host/internal/runtime-context-workflow-run.ts
packages/host-sdk/src/host/runtime-ingress-transform.ts
```

Why removed: both files were pure re-export shims to `@firegrid/runtime/workflows`. Their only active imports were in tiny-firegrid simulations, and those imports now use the canonical runtime workflow subpath directly.

No-carveout probe after shim retirement:

```text
x 19 dependency violations (19 errors, 0 warnings). 219 modules, 529 dependencies cruised.
```

Normal gate after removing the two shim carveouts:

```text
✔ no dependency violations found (219 modules, 529 dependencies cruised)
```

## tf-rb9e Shim Retirement Iteration 3

Date: 2026-05-20

Base: current `origin/main` for `codex/tf-rb9e-shim-retirement-iteration-3`.

Result: 1 carveout removed. The list moves from 9 files to 8 files.

Removed compatibility re-export carveout:

```text
packages/host-sdk/src/host/index.ts
```

Why removed: the host public barrel only needed its carveout for a compatibility re-export of runtime control workflow helpers from `@firegrid/runtime/workflows`. The only repo consumer of those barrel re-exports was `packages/host-sdk/test/host/control-request-reconciler.test.ts`; that test now imports the helpers from the canonical runtime workflow subpath.

No-carveout probe after iteration 3:

```text
x 17 dependency violations (17 errors, 0 warnings). 219 modules, 531 dependencies cruised.
```

Normal gate after removing the barrel carveout:

```text
✔ no dependency violations found (219 modules, 531 dependencies cruised)
```

## tf-ygz3 Shim Retirement Iteration 4

Date: 2026-05-20

Base: current `origin/main` for `codex/tf-ygz3-shim-retirement-iteration-4`.

Result: no carveouts removed. The list remains 8 files.

Why no ratchet: only `packages/host-sdk/src/host/runtime-context-workflow-core.ts` is a pure compatibility shim, and it still has active production, test, and tiny-firegrid simulation consumers. The other seven carveouts are implementation modules or channel bindings that actively import workflow engine, workflow definitions, or durable table substrate.

No-carveout probe:

```text
x 17 dependency violations (17 errors, 0 warnings). 219 modules, 531 dependencies cruised.
```

Recommended next slice: migrate `runtime-context-workflow-core.ts` consumers to `@firegrid/runtime/workflows`, delete the shim, and remove that carveout.
