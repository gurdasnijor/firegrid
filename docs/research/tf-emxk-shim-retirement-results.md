# tf-emxk shim retirement results

Date: 2026-05-20

Base: current `origin/main` for `codex/tf-emxk-shim-retirement-ratchet`.

## Summary

Retired 2 pure compatibility re-export shims and ratcheted `currentHostSdkSubstrateDebt` from 11 files to 9 files.

Removed:

- `packages/host-sdk/src/host/internal/runtime-context-workflow-run.ts`
- `packages/host-sdk/src/host/runtime-ingress-transform.ts`

Both files only re-exported symbols from `@firegrid/runtime/workflows`. Their only active imports were in tiny-firegrid simulations, which now import from the canonical runtime workflow subpath.

## Per-File Disposition

| Carveout file | Pure re-export shim? | Host-sdk-path consumers | Disposition |
|---|---:|---|---|
| `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` | no | production implementation | Kept; still imports workflow substrate. |
| `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts` | no | production implementation | Kept; still imports workflow substrate. |
| `packages/host-sdk/src/host/control-request-reconciler.ts` | no | production implementation | Kept; still imports workflow substrate. |
| `packages/host-sdk/src/host/index.ts` | no | public host barrel | Kept; mixed public exports plus workflow re-exports. |
| `packages/host-sdk/src/host/internal/runtime-context-helpers.ts` | no | production implementation and re-exports | Kept; not a pure shim. |
| `packages/host-sdk/src/host/internal/runtime-context-workflow-run.ts` | yes | tiny-firegrid simulations only | Deleted; consumers migrated to `@firegrid/runtime/workflows`. |
| `packages/host-sdk/src/host/runtime-context-workflow-core.ts` | yes | production host-sdk modules and tests | Kept; consumers remain on host-sdk path. |
| `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts` | no | production implementation | Kept; still imports workflow substrate. |
| `packages/host-sdk/src/host/runtime-ingress-transform.ts` | yes | tiny-firegrid simulations only | Deleted; consumers migrated to `@firegrid/runtime/workflows`. |
| `packages/host-sdk/src/host/runtime-input-deferred.ts` | no | production implementation | Kept; still imports workflow substrate. |
| `packages/host-sdk/src/host/session-log-channel.ts` | no | production channel binding | Kept; still imports durable table facade. |

## Evidence

No-carveout probe after deleting the two shims:

```text
x 19 dependency violations (19 errors, 0 warnings). 219 modules, 529 dependencies cruised.
```

Normal guardrail gate:

```text
✔ no dependency violations found (219 modules, 529 dependencies cruised)
```

## Validation

```bash
pnpm run lint:deps
pnpm --filter @firegrid/tiny-firegrid typecheck
pnpm --filter @firegrid/host-sdk typecheck
pnpm --filter @firegrid/tiny-firegrid test
pnpm --filter @firegrid/host-sdk test
```
