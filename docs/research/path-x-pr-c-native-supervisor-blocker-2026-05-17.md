# Path X PR C Native Supervisor Blocker

Date: 2026-05-17
Branch: `codex/path-x-pr-c-native-supervisor`

## Scope Attempted

This branch attempted the P0 Path X production cutover primitive:

- host-owned `RuntimeContextSupervisor` with short `startOrAttach(context, activityAttempt)` and `send(context, activityAttempt, command)` operations.
- `RuntimeContextWorkflowNative` wired as the production runtime-context workflow.
- workflow-owned tool and permission command ids:
  - `tool-{contextId}-{activityAttempt}-{toolUseId}`
  - `permission-{permissionRequestId}`
- per-context output stream writes from the native supervisor instead of the old session-runtime output path.

## Concrete Blocker

The attempted supervisor can start the local process and write per-context terminal output, but `startRuntime` does not complete: the workflow wait row remains `active` and no durable wait completion is written.

Observed focused debug result:

- `RuntimeRun.started` is written.
- per-context `RuntimeOutputTable.events` receives:
  - raw child stdout at sequence `0`
  - encoded `Terminated` at sequence `1`
- durable wait row exists for `AgentOutputAfter(contextId, activityAttempt: 1, afterSequence: -1)`.
- durable wait completion rows are empty.
- `RuntimeRun.exited` is not written because the workflow remains suspended.

Follow-up isolation added process-free `AgentOutputAfter` coverage in
`packages/host-sdk/test/host/runtime-context-workflow-core.test.ts`:

- per-context output initial-state completion through `HostRuntimeObservationSubstrateLive`.
- per-context output live completion through `HostRuntimeObservationSubstrateLive`.
- per-context output initial-state completion through `FiregridRuntimeHostWithWorkflowLive`.
- per-context output live completion through `FiregridRuntimeHostWithWorkflowLive`.

Those focused cases pass, so the basic stream URL alignment and
`RuntimeWaitStreamsLive` override propagation are proven. A debug probe against
the full `startRuntime` path also showed `RuntimeAgentOutputAfterEvents.initial`
can see the supervisor-written `Terminated` row, and a later host-layer acquire
can reconcile the wait. The unresolved blocker is therefore narrower: the
native runtime-context workflow/supervisor execution path still does not drive
the wait completion/resume while `startRuntime` is blocked.

Adding the current supervisor as-is would still be additive substrate, not replacement.

## Review-Bar Gaps

This branch is not mergeable until these are closed:

- `RuntimeContextSupervisor` is still a monolith; raw and codec process/session ownership must be split into small adapters with only a shared registry if needed.
- cached `startOrAttach` replay with an empty in-memory session registry is not covered; `send` must reattach/rebuild or otherwise succeed instead of returning session-missing.
- host-sdk currently still imports old runtime authority layers in the attempted composition; this must be replaced by a host-sdk-owned thin per-context output writer or a narrower runtime capability.
- lifecycle tests are missing for host-scope pump release, sandbox death cleanup, repeated same context/attempt start idempotency, and absence of competing sessions.
- legacy production paths remain reachable, so the deletion gate is not satisfied.

## Required Static Evidence Classification

Current `rg` classifications for this blocker branch:

- `runRuntimeContext`: DELETE. Still exported from `packages/host-sdk/src/host/raw-process-runtime.ts`; must be deleted or made unreachable before non-draft PR.
- `runCodecRuntimeEventPipeline`: DELETE. Still exported from `@firegrid/runtime/host-substrate` and used by raw-process legacy path; must be removed from production reachability.
- `runIngressDelivery`: DELETE. Still present under runtime subscriber/session-runtime path; delete once command delivery is workflow/supervisor-owned.
- `runToolRouter`: DELETE. Still present under runtime subscriber/session-runtime path; delete once tool execution is workflow-owned through `RuntimeToolUseExecutor`.
- `appendRuntimeIngress`: RESHAPE/KEEP temporarily. Survives only as rewritten `session.prompt` / internal command seam until deferred-input design replaces it.
- `appendRuntimeIngressToOwner`: RESHAPE/KEEP temporarily. Same rationale as `appendRuntimeIngress`.
- `RuntimeOutputJournalLayer`: RESHAPE/KEEP on the runtime read-side substrate, but host-sdk production supervisor composition should not depend on it as an old authority layer.

## Validation Run

Passing:

- `pnpm --filter @firegrid/runtime typecheck`
- `pnpm --filter @firegrid/host-sdk typecheck`
- `pnpm --filter @firegrid/host-sdk exec vitest run test/host/runtime-context-workflow-core.test.ts`

Failing / blocked:

- focused host integration still hangs because terminal output is written but the full native runtime-context workflow does not resume to write `RuntimeRun.exited`.
