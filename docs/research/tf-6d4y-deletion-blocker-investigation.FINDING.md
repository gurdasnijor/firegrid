# tf-6d4y deletion blocker investigation

Date: 2026-05-20

Base: `aeaf5f6af` (`origin/main` at investigation start)

Scope: read-only characterization of what keeps PR #475 red after the Phase-2 channel work, with dependency graph output plus OTEL trace evidence from a current-main `workflow-core-paths` run.

## Dependency Graph

Commands run:

```bash
pnpm run arch:deps:runtime
pnpm run arch:deps:runtime:detail
pnpm run arch:deps
pnpm run arch:deps:workspace:detail
```

Results:

- `arch:deps:runtime`: completed; regenerated `docs/dependency-graph-runtime.mmd` and still shows `packages/runtime/src/durable-tools`.
- `arch:deps:runtime:detail`: completed; regenerated `docs/dependency-graph-runtime-detail.mmd` with the durable-tools detail subgraph (`DurableToolsWaitFor.ts`, `internal/wait-router.ts`, `internal/table.ts`, `internal/wait-for.ts`, `internal/durable-wait-store.ts`).
- `arch:deps:workspace:detail`: completed; regenerated `docs/dependency-graph-detail.mmd` and shows the host-sdk path through `runtime-substrate.ts` and `host-owned-durable-tools.ts`.
- `arch:deps`: failed before producing a useful full graph because the configured source list still references missing `packages/client/src`.

Generated graph files were restored after inspection so this finding carries the evidence without committing graph churn.

### Importer Classification

| Importer | Classification | Evidence |
|---|---:|---|
| `packages/host-sdk/src/host/host-owned-durable-tools.ts` | HARD | Directly imports `DurableToolsWaitForLive` and durable wait row service types from `@firegrid/runtime/durable-tools`, then builds `HostOwnedDurableToolsWaitForLive` over the host-owned `durableTools` stream segment. See lines 7-11 and 19-35. |
| `packages/host-sdk/src/host/runtime-substrate.ts` | HARD | Imports `HostOwnedDurableToolsWaitForLive`, composes `HostRuntimeObservationSubstrateLive` from it, and keeps durable wait services in the execution environment. See lines 27-29, 58-69, and 78-85. |
| `packages/host-sdk/src/host/runtime-context-workflow-support.ts` | HARD, transitive | Provides `HostRuntimeObservationSubstrateLive` into both `RuntimeContextWorkflowNativeLayer` and `RuntimeToolUseExecutorLive`. This is not a direct durable-tools import, but it is the current production composition path for the host observation substrate. See lines 12-15 and 46-51. |
| `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts` | HARD, transitive | Provides `HostRuntimeObservationSubstrateLive` into the tool-call workflow layer. The comments still mention `WaitFor.match`; current runtime need is the shared observation substrate composition, not direct wait-router matching. See lines 20-22 and 91-103. |
| `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` | HARD helper, not hard wait-router | Imports only `evaluateFieldEquals` and `FieldEqualsTrigger` from durable-tools. Current `wait_for` and `wait_for_any` route through `ChannelRegistry` streams and use the field-equals predicate helper; there is no production `WaitFor.match` call here. See lines 91-93, 265-344, and 361-374. This can be unwound by moving the predicate type/helper to a substrate-neutral module. |
| `packages/host-sdk/src/agent-tools/bindings/tools.ts` | DEAD comment | The only production hit is a stale comment saying the tool lowers onto durable-tools `WaitFor.match`. |
| `packages/host-sdk/src/index.ts` | HARD, public host export | Re-exports `HostRuntimeObservationSubstrateLive`; this is host-sdk surface, not runtime root durable-tools surface. It remains tied to the hard host composition above. |
| `packages/runtime/src/durable-tools/**` | Deletion target | Internal durable-tools implementation and index. Not an external importer, but the hard host imports above still require it. |
| `packages/runtime/test/durable-tools/WaitFor.test.ts` | HARD test-only | Direct tests of `WaitFor.match`, `DurableToolsWaitForLive`, `DurableToolsTable`, wait-store spans, and restart behavior. These should be deleted or migrated with the implementation deletion. |
| `packages/host-sdk/test/host/runtime-context-workflow-core.test.ts` | HARD test-only | Imports durable-tools public surface and exercises `WaitFor.match` plus `HostRuntimeObservationSubstrateLive`. |
| `packages/host-sdk/test/host/runtime-observation-sources.test.ts` | HARD test-only | Imports `WaitFor` and uses `HostRuntimeObservationSubstrateLive`. |
| `packages/runtime/test/authorities/provider-uniqueness.test.ts` | SCHEMA/test-only | Imports internal durable wait-store authorities and asserts table/provider identity. Delete or migrate with durable-tools. |
| `packages/firelab/src/simulations/inv3-restart-replay/host.ts` | HARD sim-only | Legacy durable-tools simulation imports `WaitFor`, `DurableToolsWaitForLive`, and `DurableToolsTable`. |
| retired firelab migration backlog | RESOLVED sim-only | The old migration backlog was deleted from the active simulation tree. |
| `packages/firelab/src/simulations/inv2-waitforworkflow/**` | DEAD comment evidence | Comments document the intended absence of `WaitFor.match`, wait-router, durable wait rows, and durable-tools wait-router spans. |

## OTEL Trace Evidence

Representative sim:

```bash
pnpm --filter firelab simulate:run workflow-core-paths --timeout-ms 120000
```

Run:

```text
2026-05-20T12-02-26-727Z__workflow-core-paths
packages/firelab/.simulate/runs/2026-05-20T12-02-26-727Z__workflow-core-paths/trace.jsonl
```

The sim completed with `DriverCompleted`. A post-hoc `simulate:gate` run failed on expected workflow-execution/DurableDeferred checks for the in-flight Phase-1 gate shape, but its legacy durable-tools checks passed for `wait_for.match`, `runtime_context.workflow.output.wait`, and `wait_router.complete_match` all at zero. The raw span counts below are from the trace file itself.

| Span name | Count |
|---|---:|
| `firegrid.durable_tools.wait_for.match` | 0 |
| `firegrid.durable_tools.wait_for.upsert_active` | 0 |
| `firegrid.durable_tools.wait_router.attach_source` | 0 |
| `firegrid.durable_tools.wait_router.attach_wait` | 0 |
| `firegrid.durable_tools.wait_router.complete_match` | 0 |
| `firegrid.durable_tools.wait_router.start` | 2 |
| `firegrid.durable_tools.wait_router.initial_check` | 0 |
| `firegrid.durable_tools.wait_router.active_wait_rows` | 0 |
| `firegrid.durable_tools.wait_router.stream_for_wait` | 0 |
| `firegrid.durable_tools.wait_store.wait_rows` | 0 |
| `firegrid.durable_tools.wait_store.wait.find` | 0 |
| `firegrid.durable_tools.wait_store.wait.upsert` | 0 |

Broader durable/runtime-substrate grep:

| Span name | Count | Attribute evidence |
|---|---:|---|
| `firegrid.host.durable_tools.wait_for.layer` | 2 | One under `firegrid.side=host`, one under `firegrid.side=agent-tools`. |
| `firegrid.durable_tools.wait_router.start` | 2 | One under `firegrid.side=host`, one under `firegrid.side=agent-tools`, both with `firegrid.wait.bucket=durable`. |

No `firegrid.host.runtime_substrate.observation.layer` span appeared in this trace, but the wrapped layer's child spans did appear through `firegrid.host.durable_tools.wait_for.layer` and `firegrid.durable_tools.wait_router.start`.

## Verdict

Verdict: **HYBRID**.

Current main no longer shows active wait-row matching in the representative workflow path: no `WaitFor.match`, no wait-row upsert/find, no wait-router attach, and no complete-match spans fired. That supports the conclusion that tf-dlaa's channel-registry dispatch removed the old production `wait_for` matching path from `tool-use-to-effect.ts`.

However, import-unwinding alone is not sufficient for PR #475 as currently scoped. `HostRuntimeObservationSubstrateLive` still instantiates the host-owned durable-tools wait layer, and the trace confirms this at runtime via two `firegrid.host.durable_tools.wait_for.layer` spans and two `firegrid.durable_tools.wait_router.start` spans. Deleting `packages/runtime/src/durable-tools/` without first removing or replacing that host composition will break real layer construction, even though the router is not matching rows in this sim.

## Recommended #475 Path

1. Keep #475 gated on the host observation-substrate composition removal/replacement, but narrow the blocker: the hard runtime-active dependency is layer instantiation (`HostOwnedDurableToolsWaitForLive` -> `HostRuntimeObservationSubstrateLive`), not current `wait_for` tool dispatch through `WaitFor.match`.
2. Treat `tool-use-to-effect.ts` as a small import-unwinding task: move `FieldEqualsTrigger` plus `evaluateFieldEquals` to a substrate-neutral channel/predicate module, then import that helper from host-sdk or runtime streams/channels instead of durable-tools.
3. Remove stale comments in `tools.ts` and `toolkit-layer.ts` that still describe the channel-registry path as `WaitFor.match`-backed.
4. After the host composition dependency is gone, delete or migrate the durable-tools-specific tests/sims listed above with the implementation tree.
5. Re-run the PR #475 acceptance grep:

```bash
rg -n "WaitFor\\.match|DurableToolsWaitFor|wait_router|DurableToolsTable|HostOwnedDurableTools" packages/runtime/src packages/host-sdk/src
```

Expected result after the composition fix plus helper relocation: zero production hits.
