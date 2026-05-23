# Wave D-D — WaitForWorkflow channel-route race migration

**Verdict: 🟢 GREEN**

`WaitForWorkflow`'s match `Activity` body can be migrated from
`Stream.runHead(streamForSource(...).filter(trigger))` over the legacy
`RuntimeObservationStreams.{agentOutput, agentOutputAfter, runtimeRun,
callerFact}` catalog to a `router.dispatch({ verb: "wait_for", target,
payload })` cursor-advance loop, raced across N sources via
`Effect.raceAll`, with optional `Effect.race(match, Effect.sleep(timeoutMs))`
timeout — and all four Shape D invariants the existing wait-router
guarantees (single-source filter correctness, N-source race correctness,
restart safety, timeout race) survive the rewrite unchanged.

The probe uses ONLY `@firegrid/runtime/channels` (the routes + router) +
the protocol channel targets. No `RuntimeObservationStreams`, no
`CallerOwnedFactStreams`, no `@firegrid/runtime/streams` subpath, no new
generic stream, no new driver/runner. The Shape D justification on
`WaitForWorkflow` (durable race + timer) is preserved by the rewrite —
the `Activity.make` wrapper is unchanged; only the inner body swaps
streams-of-rows for router-dispatch-of-rows.

## What the probe asserts (13 invariants, all green)

### No-new-primitive gate (structural × 3)

- ✗ `RuntimeObservationStreams`, `RuntimeObservationStreamsLive`,
  `CallerOwnedFactStreams`, `CallerFactObservationSource`,
  `@firegrid/runtime/streams` — all absent.
- ✗ `WaitForWorkflow`, `WaitForWorkflowLayer`, `wait-router` — all absent
  (the probe stands in for the rewrite; we are proving the SHAPE).
- ✓ Runtime imports limited to exactly `@firegrid/runtime/channels`.

### Invariant 1 — single-source filter correctness

- Advance cursor on non-matching observations; settle on first match.
- Park at frontier until matching arrival, then settle (subscribe-after-
  cursor preserved).

### Invariant 2 — N-source race correctness (`wait_for_any` shape)

- Race two homogeneous sources (two `session.agent_output` cursors keyed
  by different `sessionId`); winning source's match + index returned;
  losing source does NOT deliver a duplicate.
- Race heterogeneous channel targets (`session.agent_output` vs
  `session.lifecycle`) in a single `Effect.raceAll`; the `AgentOutput`
  source wins when its match arrives first AND the route's terminal
  `seek` correctly skips non-terminal lifecycle rows during the race.
- Reverse polarity: `session.lifecycle` wins when its terminal arrives
  first; `AgentOutput` cursor advances through its non-matches without
  fabricating a winner.

### Invariant 3 — restart safety

- Interrupting the in-flight race fiber (host crash simulation) and
  re-issuing the SAME race body re-finds the SAME match. No missed
  match, no stale duplicate. (Snapshot-first + subscribe-after-cursor
  invariant inherited from the underlying route, validated by tf-22fo
  against the same primitives.)
- Restart-replay over a settled wait re-finds the same row from the
  snapshot (the production `Activity.make` wrapper journals the
  outcome on first success; the cursor-advance body is shown
  idempotent against the snapshot regardless).

### Invariant 4 — timeout race

- No matching arrival within `timeoutMs` → deterministic `Timeout`
  outcome.
- Matching arrival within `timeoutMs` → `Match` wins the race.
- Slow non-matching producer + heterogeneous sources → `Timeout` still
  wins deterministically (no source-specific timer leak).

## Evidence

- Probe logic: `packages/tiny-firegrid/src/simulations/wave-d-d-waitfor-channel-route-race/probe.ts`
- Probe tests: `packages/tiny-firegrid/test/wave-d-d-waitfor-channel-route-race/probe.test.ts`
- Run: `pnpm --filter=@firegrid/tiny-firegrid exec vitest run test/wave-d-d-waitfor-channel-route-race/probe.test.ts`
- Result: **13 passed** (116ms); `tsc --noEmit -p .` clean.

## Production migration plan unlocked by this GREEN

The migration cut is now tight enough to dispatch. It is the **inner-body
swap inside `WaitForWorkflow`'s match Activity**, not a deletion of the
workflow identity.

### File-by-file (production code, separate PR — this PR is sim + finding only)

1. `packages/runtime/src/workflow-engine/workflows/wait-for.ts`
   - `WaitForWorkflowSource` discriminant: replace
     `RuntimeObservationSourceSchema` with a `ChannelRouteSourceSchema`
     `{ target: Schema.String, payload: PerTargetPayloadUnion, trigger:
     FieldEqualsTriggerSchema }`. The payload union covers exactly the
     two registered ingress wait_for routes today
     (`SessionAgentOutputRouteInputSchema`, `SessionLifecycleRouteInputSchema`)
     plus an empty `{}` for plain `runtimeRouteFromChannel` ingress.
   - `streamForSource(streams, source)` → delete. Replace
     `matchOrTimeoutActivity`'s body with `Effect.raceAll(sources.map(s
     => matchOnRoute(router, s)))` exactly per the probe's
     `matchOrTimeoutOnRoutes` shape.
   - Remove `RuntimeObservationStreams` from the Activity's `R` channel.
     The Activity's `R` becomes `RuntimeChannelRouter`.

2. `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts`
   - `runWaitForTool` (lines 299–364) currently builds
     `{ _tag: "CallerFact", stream: String(registration.target) }`. Replace
     with `{ target: registration.target, payload: <per-target>, trigger }`.
     The `sessionId` payload field is extracted from the agent's `match`
     predicate when the target is a factory-keyed ingress route
     (`session.agent_output`, `session.lifecycle`); fall back to empty
     payload `{}` for non-factory ingress.
   - `waitForAnyDescriptorToEffect` (lines 432–488): same lower per
     descriptor.

3. `packages/runtime/src/agent-event-pipeline/tool-execution/runtime-agent-tool-execution.ts`
   - `RuntimeAgentToolExecutionService.waitFor` / `waitForAny`: now pass
     the channel-route source through (no schema-shape change at this
     boundary; the carrier is the workflow payload).

4. `packages/host-sdk/src/agent-tools/execution/runtime-tool-use-executor-live.ts`
   - The `RuntimeObservationStreams` capture in the executor live layer
     (line 30) is no longer needed; capture `RuntimeChannelRouter` instead.

### Paired deletions (in the same production PR, post-this finding)

| Symbol | File | Reason |
|---|---|---|
| `CallerFactObservationSourceSchema` variant | `packages/runtime/src/streams/sources.ts:38–42` | Only consumer was `WaitForWorkflow`'s `streamForSource` `CallerFact` arm + the agent-tool single-source/N-source lower. Both replaced by `ChannelRouteSource`. |
| `RuntimeObservationStreams.callerFact` field | `packages/runtime/src/streams/runtime-observation-streams.ts:27,130` | Same. |
| `RuntimeObservationStreams.agentOutput` / `agentOutputAfter` / `initialAgentOutputAfter` / `agentOutputForContext` / `runtimeRun` fields | `runtime-observation-streams.ts:13–26,67–129` | The `streamForSource` consumer is gone. Any production consumer outside `WaitForWorkflow` must be enumerated by `grep -rn "RuntimeObservationStreams" packages/{runtime,host-sdk,protocol}/src` before deletion; the survey at the head of this PR shows the only non-`wait-for.ts` non-stream-internal consumers are the host-sdk substrate wiring layers (which evaporate when the Tag is gone) and the verified-webhook `CallerOwnedFactStreams` binding (see PARK below). |
| `RuntimeObservationStreams` Tag + `RuntimeObservationStreamsLive` Layer | `runtime-observation-streams.ts:38–40,64` | Whole Tag deletable. |
| `RuntimeObservationSource` / `RuntimeObservationSourceSchema` / source variant schemas | `packages/runtime/src/streams/sources.ts` | Replaced by `ChannelRouteSource` in `wait-for.ts`. |
| `@firegrid/runtime/streams` public export | `packages/runtime/package.json` `exports` | Whole subpath retired once the Tag/Layer is gone. |
| `HostRuntimeObservationStreamsLive` host-sdk wiring | `packages/host-sdk/src/host/runtime-substrate.ts:63` + uses in `runtime-context-workflow-support.ts:13,35,69,89` | Whole identity goes; the workflow-support layer is itself slated for D-E body retirement (per #714 commit message). |

### PARK — explicit blocker on `CallerOwnedFactStreams` deletion

`CallerOwnedFactStreams` survives the deletion above only if
`VerifiedWebhookFactCallerOwnedFactStreamsLive` is moved off it. Two
options, neither in this PR's scope:

- **Cut-V1:** Register `VerifiedWebhookFactChannel` on
  `HostPlaneChannelRouter` via the standard ingress factory pattern.
  The agent-tool wait_for then dispatches against the
  verified-webhook target the same way it does for `session.agent_output`.
  Verified-webhook's existing `binding.stream` over
  `RuntimeOutputTable.events.rows()` becomes the route's underlying
  source.
- **Cut-V2:** Keep `CallerOwnedFactStreams` as a verified-webhook-only
  carrier (rename to `VerifiedWebhookFactCallerStream`), narrow its
  consumers to the verified-webhook flow only. Records a smaller
  `@firegrid/runtime/streams` subpath; the bulk deletion still lands.

**Recommended PARK:** Cut-V1, scheduled as a follow-up bead named
`tf-d-d-verified-webhook-router-route`. Deletion blocker recorded as:

```
PARK firegrid-host-sdk-no-effect-workflow-import / CallerOwnedFactStreams
     packages/host-sdk/src/host/channels/verified-webhook/index.ts
     deletion blocked on tf-d-d-verified-webhook-router-route
     (register VerifiedWebhookFactChannel on HostPlaneChannelRouter,
      retarget wait_for through router.dispatch, then delete
      VerifiedWebhookFactCallerOwnedFactStreamsLive + this Layer.)
```

The PARK is narrow and unambiguous — it does NOT block the bulk
`RuntimeObservationStreams` Tag deletion, only the final
`CallerOwnedFactStreams`-piece. Two follow-up PRs:

1. **D-D body PR** (post-this-finding): swap `wait-for.ts` body to
   `matchOnRoute` per the probe shape; delete `streamForSource`,
   `CallerFact*` variants, `RuntimeObservationStreams.{agentOutput,
   agentOutputAfter, runtimeRun, callerFact}` fields, and the Tag
   itself if `CallerOwnedFactStreams` proves orphaned. Production
   tests prove the route-based observation end-to-end.
2. **`tf-d-d-verified-webhook-router-route`** (smaller, follow-up):
   register the verified-webhook route on the router; retarget the
   wait_for path; delete the last `CallerOwnedFactStreams` consumer.

## What would have falsified GREEN

- **N-source race losing source delivers duplicate match** → would have
  shown up in the heterogeneous race test. Did NOT: `Effect.raceAll`'s
  short-circuit on first success interrupts loser fibers cleanly.
- **Snapshot-first race produces stale duplicates after restart** →
  would have shown up in the in-flight-interrupt restart test. Did
  NOT: cursor advance over `runHead` snapshots is read-only and
  idempotent.
- **Timeout race leaks a Match after the Timeout already fired** →
  would have shown up in the slow-producer timeout test. Did NOT.

Each invariant has a falsifying-case test in `probe.test.ts`.
