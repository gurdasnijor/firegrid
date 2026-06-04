# tf-ygz3 shim retirement iteration 4

Date: 2026-05-20

Base: current `origin/main` for `codex/tf-ygz3-shim-retirement-iteration-4`.

## Summary

No carveouts retired. `currentHostSdkSubstrateDebt` remains at 8 files.

The remaining list has only one pure compatibility shim:

- `packages/host-sdk/src/host/runtime-context-workflow-core.ts`

That shim still has active production, test, and firelab simulation consumers. The other seven carveouts are implementation modules or channel bindings that actively import workflow engine, workflow definitions, or durable table substrate.

## Per-File Disposition

| Carveout file | Pure re-export shim? | Active consumers / reason | Disposition |
|---|---:|---|---|
| `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` | no | Production tool lowering; imports workflow helpers for wait matching. | Kept. |
| `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts` | no | Production toolkit execution layer; imports `ToolCallWorkflow` and host runtime workflow runtime. | Kept. |
| `packages/host-sdk/src/host/control-request-reconciler.ts` | no | Production reconciler; imports runtime control workflows and workflow engine substrate. | Kept. |
| `packages/host-sdk/src/host/internal/runtime-context-helpers.ts` | no | Production helper module plus runtime workflow helper re-exports; consumed by host runtime code, tests, and firelab simulations. | Kept. |
| `packages/host-sdk/src/host/runtime-context-workflow-core.ts` | yes | Production host-sdk session adapters, tests, and firelab simulations still import this host-sdk shim path. | Kept. |
| `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts` | no | Production host-scoped workflow runtime; imports workflow engine substrate. | Kept. |
| `packages/host-sdk/src/host/runtime-input-deferred.ts` | no | Production runtime input deferred writer; imports workflow engine substrate and runtime workflow helpers. | Kept. |
| `packages/host-sdk/src/host/session-log-channel.ts` | no | Production session log channel; imports durable table facade for row primary-key metadata and collection binding. | Kept. |

## Evidence

No-carveout probe on the current 8-file list:

```text
x 17 dependency violations (17 errors, 0 warnings). 219 modules, 531 dependencies cruised.
```

Every current carveout appears in that no-carveout failure set.

Active `runtime-context-workflow-core.ts` shim consumers include:

```text
packages/host-sdk/src/host/runtime-context-session/common.ts
packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts
packages/host-sdk/src/host/runtime-context-session/raw-adapter.ts
packages/host-sdk/test/host/runtime-context-workflow-core.test.ts
packages/host-sdk/test/host/runtime-context-session-codec-adapter.test.ts
packages/host-sdk/test/host/runtime-context-session-raw-adapter.test.ts
packages/host-sdk/test/host/runtime-codec-event-plane.test.ts
packages/firelab/src/simulations/inv1-stream-zip-body/host.ts
packages/firelab/src/simulations/phase0-wave-2b-stream-zip-restart-replay/host.ts
```

## Recommended Next Slice

Create a focused consumer-migration slice for `packages/host-sdk/src/host/runtime-context-workflow-core.ts`:

1. Move production host-sdk session adapter imports from the host shim to `@firegrid/runtime/workflows`.
2. Move host-sdk tests and firelab simulations to the same canonical runtime subpath.
3. Delete `packages/host-sdk/src/host/runtime-context-workflow-core.ts`.
4. Remove its `currentHostSdkSubstrateDebt` carveout and rerun `pnpm run verify`.

That is the next mechanical ratchet opportunity. The other seven files require actual boundary refactors, not shim retirement.
