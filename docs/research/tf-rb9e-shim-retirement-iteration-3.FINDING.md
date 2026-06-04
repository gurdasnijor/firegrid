# tf-rb9e shim retirement iteration 3

Date: 2026-05-20

Base: current `origin/main` for `codex/tf-rb9e-shim-retirement-iteration-3`.

## Summary

Retired the remaining runtime workflow compatibility re-export from the host public barrel and ratcheted `currentHostSdkSubstrateDebt` from 9 files to 8 files.

Removed from the carveout list:

- `packages/host-sdk/src/host/index.ts`

The barrel was not a pure shim file, so it was not deleted. Its only unsanctioned runtime workflow dependency was the compatibility re-export of runtime control workflow helpers from `@firegrid/runtime/workflows`. The only repo consumer of those barrel re-exports was `packages/host-sdk/test/host/control-request-reconciler.test.ts`; that test now imports the helpers from the canonical runtime workflow subpath.

## Per-File Disposition

| Carveout file | Pure re-export shim? | Host-sdk-path consumers | Disposition |
|---|---:|---|---|
| `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` | no | production implementation and tests | Kept; still implements host-side tool lowering and imports workflow definitions. |
| `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts` | no | production implementation and tests | Kept; still composes execution support and imports workflow definitions. |
| `packages/host-sdk/src/host/control-request-reconciler.ts` | no | production implementation and tests | Kept; still dispatches runtime control workflows and imports workflow engine/definitions. |
| `packages/host-sdk/src/host/index.ts` | mixed barrel | test-only consumer for workflow helper re-export | Ratcheted; removed the `@firegrid/runtime/workflows` re-export and migrated the test import to runtime. |
| `packages/host-sdk/src/host/internal/runtime-context-helpers.ts` | no | production implementation, simulations, and tests | Kept; still provides host helpers plus runtime workflow helper re-exports. |
| `packages/host-sdk/src/host/runtime-context-workflow-core.ts` | yes | production host-sdk modules, simulations, and tests | Kept; pure compatibility shim, but active consumers remain. |
| `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts` | no | production implementation, simulations, and tests | Kept; still owns host-scoped workflow runtime composition. |
| `packages/host-sdk/src/host/runtime-input-deferred.ts` | no | production implementation, simulations, and tests | Kept; still writes runtime input deferreds via workflow engine. |
| `packages/host-sdk/src/host/session-log-channel.ts` | no | public host barrel and tests | Kept; still binds session log storage to durable table facades. |

## Evidence

No-carveout probe after this ratchet:

```text
x 17 dependency violations (17 errors, 0 warnings). 219 modules, 531 dependencies cruised.
```

Normal guardrail gate:

```text
✔ no dependency violations found (219 modules, 531 dependencies cruised)
```

## Recommended Next Slice

The next consumer-migration slice should target `packages/host-sdk/src/host/runtime-context-workflow-core.ts`. It is now a pure compatibility shim, but production modules, tests, and firelab simulations still import the host-sdk path. Move those consumers to `@firegrid/runtime/workflows` in a focused migration before deleting the shim and removing its carveout.
