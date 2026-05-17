# Path X PR C Native Cutover Blocker

Date: 2026-05-17

Scope: Path X PR C implementation lane, after Host SDK cutover.

## Target

Path X PR C is not a compatibility migration. The target production path is:

- `FiregridRuntimeHostLive` registers `RuntimeContextWorkflowNativeLayer`.
- `startRuntime` and host tool child-session starts execute `RuntimeContextWorkflowNative`.
- The production host provides a real `RuntimeContextWorkflowSession`.
- Runtime process/session side effects happen at `Activity.make` boundaries.
- Legacy `runtime-context-workflow`, `runRuntimeContext`, `session-runtime`,
  `ingress-delivery`, and `tool-router` paths are deleted or impossible to call.

## Concrete Finding

The first mechanical live-wire is straightforward, but it is not sufficient for
PR C:

- `FiregridRuntimeHostLive` can provide `RuntimeContextWorkflowNativeLayer`.
- `startRuntime` can execute `RuntimeContextWorkflowNative`.
- host-side child session creation can execute `RuntimeContextWorkflowNative`.
- the legacy `runtime-context-workflow.ts` wrapper can be deleted once those
  callers move.

That slice still leaves the old substrate underneath if
`RuntimeContextWorkflowSessionLive.start` delegates to `runRuntimeContext`.
That is a behavior-preserving staging slice, not the requested Path X cutover.

## Rejected Shape: Started By Forking The Old Runner

I tested a `Started | Exited` seam where codec contexts returned `Started` from
the start activity by forking the existing `runRuntimeContext` runner, while
raw contexts returned `Exited`.

That shape is not acceptable for PR C:

- it is still the old `session-runtime` / `ingress-delivery` / `tool-router`
  substrate hidden behind a new service name;
- it does not prove the native workflow owns prompt, permission, and tool
  command flow;
- focused stdio-jsonl tool roundtrip tests hung when the forked runner was
  used as the production session start path.

The tests that exposed this were:

- `pnpm --filter @firegrid/host-sdk exec vitest run test/host/runtime-codec-event-plane.test.ts -t "journals stdio-jsonl" --reporter verbose`
- `pnpm --filter @firegrid/host-sdk exec vitest run test/host/runtime-codec-event-plane.test.ts`

The behavior-preserving blocking variant passed only after returning to the
old blocking `runRuntimeContext` runner. That proves the legacy substrate still
owns the live behavior and therefore cannot be the final PR C shape.

## Required Next Implementation Step

The deletion cutover needs a native host-session runner rather than a renamed
legacy runner:

1. `RuntimeContextWorkflowSessionLive.start` starts the local process/session
   through an activity boundary and returns `Started` only when a host-owned
   session supervisor is actually registered.
2. The workflow body owns prompt, permission, and tool command acceptance using
   content-derived `DurableDeferred` names.
3. `RuntimeContextWorkflowSessionLive.send` emits bytes or codec control
   messages only from workflow `Activity.make` calls.
4. The output pump writes per-context output side-channel rows without using
   `session-runtime.ts` subscribers.
5. Once that is green, delete:
   - `packages/host-sdk/src/host/raw-process-runtime.ts`
   - `packages/runtime/src/agent-event-pipeline/session-runtime.ts`
   - `packages/runtime/src/agent-event-pipeline/subscribers/ingress-delivery.ts`
   - `packages/runtime/src/agent-event-pipeline/subscribers/tool-router.ts`
   - `RuntimeIngressDeliveryTrackerLayer` production wiring if no callers remain
   - runtime-ingress delivery-row tests that only validate deleted subscriber behavior

## Validation Reached Before The Blocker

Green focused checks on the behavior-preserving staging slice:

- `pnpm --filter @firegrid/host-sdk typecheck`
- `pnpm --filter @firegrid/runtime typecheck`
- `pnpm --filter @firegrid/host-sdk test`
- `pnpm --filter @firegrid/runtime test`
- `pnpm run lint`
- `pnpm run lint:deps`
- `pnpm run lint:dead`
- `pnpm run lint:dup`
- `pnpm run lint:effect-quality`
- `pnpm run lint:semgrep:test`
- `pnpm run lint:semgrep`
- `pnpm run check:specs`
- `pnpm run check:docs`
- `git diff --check`

These checks do not certify PR C completion because the underlying production
runner still preserves the legacy substrate.
