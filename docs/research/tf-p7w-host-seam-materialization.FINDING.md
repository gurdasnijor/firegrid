# FINDING — tf-p7w: lifecycle materializes; serial reconciliation starved clean-unwind

Status authority: bead `tf-p7w`. Supersedes the earlier `tf-4ni` /
`tf-auk` / PR #404 halt diagnosis that suspected host-origin
`lifecycleRequests` materialization.

## Source-verified conclusion

The remaining Gap-3 blocker was **not** collection registration, write
topology, materialization subscription scope, or loopback dedupe. The
source and trace now prove the lifecycle row is materialized by the same
DurableTable machinery as the working `contextRequests` and
`startRequests` collections:

- `RuntimeControlPlaneTable` includes `lifecycleRequests` in the same
  `runtimeControlPlaneSchemas` map as `contextRequests` and
  `startRequests` (`packages/protocol/src/launch/table.ts`).
- `DurableTable` compiles every schema-map entry into a collection,
  action set, and facade; there is no per-origin collection filter in
  that path (`packages/effect-durable-operators/src/DurableTable.ts`).
- The red artifact
  `2026-05-19T13-21-58-134Z__session-lifecycle-unwind-pipeline`
  shows `firegrid.durable_table.producer_append` success for
  `firegrid.runtime.lifecycleRequests` from `session_cancel`.

The real failure was the **serial control-request reconciler**. The
one-shot loop processed `context`, then `lifecycle`, then `start`; once a
`start` request reached `startRuntime()`, that long-running runtime
blocked the next scan. The lifecycle row was appended after the runtime
was already inside that long-running start path, so no later lifecycle
scan ran before the simulation timeout. The red artifact ends with
`firegrid.host.control_request.start.reconcile` timing out; it never got
back to the lifecycle scan.

## Fix recorded by tf-p7w

The fix keeps the durable lifecycle request design and changes the host
reconciler behavior:

1. Lifecycle reconciliation also runs in its own daemon loop, independent
   of the full context/start control loop. A long-running `startRuntime()`
   can no longer starve `cancel` / `close`.
2. A reconciled lifecycle request writes public terminal evidence:
   durable run status `exited` and a per-context `Terminated`
   `AgentOutput`. The host-local engine scope close is still performed
   via `RuntimeContextEngineRegistry.deregister`, but the public surface
   no longer depends on the running adapter unwinding quickly enough to
   emit terminal output itself.

Passing artifact:
`2026-05-19T13-31-56-064Z__session-lifecycle-unwind-pipeline`.
Summary: `sawReady:true`, `sawTerminated:true`,
`snapshotStatus:"exited"`, `terminalObserved:true`.

Relevant spans in that artifact:

- `firegrid.durable_table.producer_append` for
  `firegrid.runtime.lifecycleRequests`, result `Appended`.
- `firegrid.host.control_request.lifecycle.reconcile_once` with
  `firegrid.control.lifecycle_request_count:1`.
- `firegrid.host.runtime_context.engine.close`, status success.
- `firegrid.host.control_request.lifecycle.terminal_evidence`, status
  success.

## Disposition

No architect halt remains for tf-p7w. The materialization suspicion is
exonerated; the clean-unwind substrate failure was reconciler starvation
plus missing immediate terminal evidence. The merged #393
`session-lifecycle-unwind-pipeline` simulation is the acceptance signal
for this fix: it must stay green with `terminalObserved:true`.
