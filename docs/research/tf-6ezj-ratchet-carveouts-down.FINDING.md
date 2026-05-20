# tf-6ezj carveout ratchet finding

Date: 2026-05-20

Base: current `origin/main` for `codex/tf-6ezj-ratchet-carveouts-down`.

## Summary

No `currentHostSdkSubstrateDebt` carveouts can be removed on current main.

All 12 carved-out files still exist, and removing the carveout list still produces dependency-cruiser violations for every file. The hard import guardrails are working for new/non-carved-out files, but the current host-sdk substrate debt surface has not yet shrunk after the cited merges.

## Method

1. Read the `currentHostSdkSubstrateDebt` list in `.dependency-cruiser.cjs`.
2. Verified each listed file still exists under `packages/host-sdk/`.
3. Ran a no-carveout depcruise probe by removing `pathNot: currentHostSdkSubstrateDebt` from the two host-sdk substrate rules in a temporary config.
4. Re-ran the normal `pnpm run lint:deps` gate with the existing carveouts.

## Evidence

Existing carved-out files:

| File | Still exists | Still violates without carveout |
|---|---:|---:|
| `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` | yes | yes |
| `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts` | yes | yes |
| `packages/host-sdk/src/host/control-request-reconciler.ts` | yes | yes |
| `packages/host-sdk/src/host/host-owned-durable-tools.ts` | yes | yes |
| `packages/host-sdk/src/host/index.ts` | yes | yes |
| `packages/host-sdk/src/host/internal/runtime-context-helpers.ts` | yes | yes |
| `packages/host-sdk/src/host/internal/runtime-context-workflow-run.ts` | yes | yes |
| `packages/host-sdk/src/host/runtime-context-workflow-core.ts` | yes | yes |
| `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts` | yes | yes |
| `packages/host-sdk/src/host/runtime-ingress-transform.ts` | yes | yes |
| `packages/host-sdk/src/host/runtime-input-deferred.ts` | yes | yes |
| `packages/host-sdk/src/host/session-log-channel.ts` | yes | yes |

No-carveout probe:

```text
x 25 dependency violations (25 errors, 0 warnings). 234 modules, 576 dependencies cruised.
```

Normal gate:

```text
✔ no dependency violations found (234 modules, 576 dependencies cruised)
```

## Verdict

**NO-RATCHET-AVAILABLE.** The carveout count remains 12. The next ratchet slice should wait for one of these files to move, disappear, or stop importing workflow-engine/workflows, durable-tools, or durable table facades.
