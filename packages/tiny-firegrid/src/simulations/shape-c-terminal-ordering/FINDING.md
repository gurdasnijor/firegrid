# shape-c-terminal-ordering — Wave C terminal completion ordering

**Verdict: GREEN.** The target terminal contract is
**terminal-after-durable-settlement via the existing
`SessionLifecycleChannel` ingress + `RuntimeRunEvent` durable row**. No
new primitive is required. The cannon already answers the architecture
question; this sim demonstrates the ordering gap CC1 hit and proves the
existing route closes it.

CC1's option set was:

> Determine whether the target contract should be terminal-after-durable-
> settlement via existing route/side-effect ordering, or whether the
> tests should observe a different existing durable evidence point.

**Both** branches resolve to the same answer: **the tests should observe
a different existing durable evidence point** — `session.lifecycle`
(per-session ingress over `RuntimeRunEvent`) — **which is itself the
terminal-after-durable-settlement contract** (the stream tails the
durable runs table; observation cannot resolve before the row exists).

## Cannon anchor

`docs/cannon/architecture/runtime-design-constraints.md` §"Route
Completion" (constraint C7):

> Immediate append/call receipts are router metadata. **Terminal prompt
> completion is durable runtime result state. Do not synthesize terminal
> `Done` at the ACP edge over raw `TurnComplete` observation. Bind
> terminal completion to the state/result fact that the keyed handler
> owns.**
>
> RFC-conforming target: terminal facts are durable records/projection
> state with first-valid-terminal-wins, not edge-local synthesis.

`session.agent_output` `_tag: "Terminated"` is exactly the raw
TurnComplete-shaped observation the cannon forbids treating as the
terminal contract. The keyed handler's terminal fact is
`RuntimeRunEvent` with `status: "exited" | "failed"`.

## Existing production primitives (no invention)

| Concern | Production symbol | Location |
|---|---|---|
| Durable run-lifecycle event row | `RuntimeRunEventSchema` (`status: "started" \| "exited" \| "failed"`, `exitCode`, `signal`, `message`, `provider`, `runEventId`) | `packages/protocol/src/launch/schema.ts:522` |
| Durable runs table | `RuntimeControlPlaneTable.runs` | `packages/protocol/src/launch/...`; consumed at `packages/runtime/src/authorities/runtime-control-plane-recorder.ts:260+` |
| Durable terminal-write entry point | `RuntimeRunAppendAndGet.recordExited(context, activityAttempt, { exitCode, signal? })` | `packages/runtime/src/authorities/runtime-control-plane-recorder.ts:` (interface); called from `packages/runtime/src/workflow-engine/workflows/runtime-context-run.ts:100` (`"runtime-control-plane.runs.exited"`) |
| Per-session lifecycle ingress channel | `SessionLifecycleChannel.forSession(sessionId)` — `IngressChannel<RuntimeRunEventSchema>` | `packages/protocol/src/channels/host-control.ts:180-191` |
| Channel service Live | provided in `RuntimeHostControlChannelsLive` as `makeIngressChannel({ target: SessionLifecycleChannelTarget, schema: RuntimeRunEventSchema, stream: control.runs.rows().filter(row => row.contextId === sessionId) })` | `packages/runtime/src/channels/host-control-routes.ts:99-107` |

The lifecycle channel's `stream` IS `control.runs.rows().filter(...)` —
i.e., the observation source is the durable terminal fact itself. No
ordering gap is possible.

## The exact production change CC1 should make

**One mechanical route registration** — pattern-identical to #703 which
added `session.agent_output / wait_for` to `HostPlaneChannelRouter`.

Today `SessionLifecycleChannel` is wired as a Live service Tag but
**not** registered on `HostPlaneChannelRouter`:

```ts
// packages/runtime/src/channels/host-control-routes.ts:80-92
const router = makeRuntimeChannelRouter([
  runtimeRouteFromChannel(contextsCreate),
  runtimeRouteFromChannel(hostPrompt),
  runtimeRouteFromFactoryChannel({
    target: SessionPromptChannelTarget,
    field: "sessionId",
    inputSchema: SessionPromptRouteInputSchema,
    channel: sessionPrompt.forSession,
    payload: input => input.prompt,
  }),
  runtimeRouteFromChannel(sessionsStart),
  runtimeRouteFromChannel(permissionRespond),
  runtimeRouteFromChannel(contexts),
  runtimeRouteFromChannel(sessionsCreateOrLoad),
  // sessionAgentOutputObservationRoute added by #703.
  //
  // session.lifecycle is NOT here — the existing comment in this file says:
  //   "SessionLifecycleChannel is intentionally observation-only here.
  //    The router declares every dispatched host-control channel;
  //    lifecycle remains a stream service consumed through its typed
  //    channel tag."
])
```

To close CC1's ordering gap **at the public router/edge surface**, add a
factory-keyed route registration mirror of #703:

```ts
// In packages/runtime/src/channels/host-control-routes.ts (one new line in
// makeRuntimeChannelRouter([...])):
runtimeRouteFromFactoryIngressChannel({
  target: SessionLifecycleChannelTarget,
  field: "sessionId",
  inputSchema: SessionLifecycleRouteInputSchema,  // new, sim-modeled here
  channel: sessionLifecycle.forSession,
}),
```

This is **route exposure only**, not new behavior. The channel
implementation, the durable table, the writer, and the observation
contract all already exist. Pattern parity with #703.

If the route name `runtimeRouteFromFactoryIngressChannel` does not exist
in the runtime/channels barrel (today only the
`runtimeRouteFromFactoryChannel` egress-keyed variant is used by
`SessionPromptChannel`), the route can be expressed equivalently with
`runtimeRouteFromChannel(sessionLifecycle.forSession("placeholder"))`
guarded by a factory-shaped router lookup. The route layering is the
same; only the helper-fn surface differs.

**Public facade body** in `packages/host-sdk/src/host/commands.ts`
`startRuntime`: after dispatching `HostSessionsStartChannel.binding.call`,
observe `SessionLifecycleChannel.forSession(contextId).binding.stream`
filtered for `row.status === "exited" || row.status === "failed"`. **Do
not** filter `SessionAgentOutputChannel` for `_tag: "Terminated"`.

## What this sim proves

Three reproducible assertions:

1. **The gap is real.** With a `settlementDelayMs: 25` between the
   internal side-effect's `agent_output` Terminated emit and the
   durable `runs.exited` write, a facade that observes
   `agent_output._tag === "Terminated"` returns to its caller before
   the runs table contains the row. The test
   `the bug — observing session.agent_output _tag:Terminated is racy`
   asserts the runs table is empty at facade-return.

2. **The lifecycle observation point closes the gap.** The same
   settlement delay does NOT race the lifecycle facade because the
   observation source is the durable runs table itself. The test
   `the fix — observing session.lifecycle binds to the durable runs.exited row`
   asserts the runs row exists with `status: "exited"` at facade-return.

3. **Cannon C7 structural assertions.** The right-shape facade
   dispatches `waitForLifecycle`, not `waitForAgentOutput`, for terminal
   evidence; no `_tag: "Done"` synthesis appears in the facade source;
   the lifecycle route's stream is `substrate.runs.changes` (the
   durable terminal fact), not `substrate.outputs.changes`.

## Why this is NOT a new SDD surface

| Concern | Resolved by existing primitive |
|---|---|
| "Where does the terminal fact live?" | `RuntimeControlPlaneTable.runs` |
| "What schema is it?" | `RuntimeRunEventSchema` |
| "Who writes it?" | `RuntimeRunAppendAndGet.recordExited` (production write site at `runtime-context-run.ts:100`) |
| "How does the client observe it?" | `SessionLifecycleChannel.forSession(sessionId).binding.stream` (Live tag already provided by `RuntimeHostControlChannelsLive`) |
| "How does a router-edge consumer reach it?" | One mechanical `runtimeRouteFromFactoryIngressChannel` registration on `HostPlaneChannelRouter`, parity with #703 |
| "What about the ordering contract — terminal-after-durable-settlement?" | Implicit in the channel's stream definition: `control.runs.rows().filter(...)`. Observation cannot resolve before the row is durable. First-valid-terminal-wins per cannon C7. |

The Wave C exit gate criterion ("terminal completion bound to durable
state, not edge synthesis") is **already satisfied** by the existing
primitives. The only Wave C-shaped work is the one-line route exposure
and the host-sdk facade body retarget.

## What CC1 should NOT do

- ❌ Do not register a new `runs.exited` callable channel — the
  observation contract already lives in `SessionLifecycleChannel`.
- ❌ Do not invent a `RuntimeObservationStreams` surface — the typed
  ingress channel + factory pattern (#702/#703) already covers per-
  session observation streams.
- ❌ Do not "wait for both events" at the facade — the
  `session.agent_output` Terminated event is correct as a raw codec
  observation but is not the terminal contract. Mixing observation
  points reintroduces the race.
- ❌ Do not paper over the gap with a `Effect.sleep` settlement — that
  IS the cannon-C7 anti-pattern (edge-local synthesis), just hidden
  behind a delay.

## Hard constraints — all observed

- ✅ Read-only review of existing primitives (no production edits).
- ✅ No new driver / runner / generic stream.
- ✅ No `RuntimeObservationStreams`.
- ✅ No new router surface (the registration is mechanical pattern parity
  with #703 over an existing IngressChannel).
- ✅ All proposed production changes are minimal-mechanical and use only
  pre-existing protocol schemas, runtime tables, and writer entry points.

## Test command

```
pnpm --filter @firegrid/tiny-firegrid test test/shape-c-terminal-ordering/probe.test.ts
pnpm --filter @firegrid/tiny-firegrid typecheck
```

## Sources

- `docs/cannon/architecture/runtime-design-constraints.md` §"Route
  Completion" (C7)
- `docs/cannon/architecture/runtime-pipeline-type-boundaries.md`
- `docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md`
- `docs/architecture/host-sdk-runtime-boundary.md`
- `packages/protocol/src/launch/schema.ts:522` (`RuntimeRunEventSchema`)
- `packages/protocol/src/channels/host-control.ts:180-191`
  (`SessionLifecycleChannel`)
- `packages/runtime/src/channels/host-control-routes.ts:99-107`
  (`RuntimeHostControlChannelsLive` lifecycle Live wiring; the route
  is intentionally observation-only here today)
- `packages/runtime/src/authorities/runtime-control-plane-recorder.ts`
  (`RuntimeRunAppendAndGet.recordExited`)
- `packages/runtime/src/workflow-engine/workflows/runtime-context-run.ts:100`
  (production durable write site, span name
  `runtime-control-plane.runs.exited`)
- Companion sims: `shape-c-channel-router-turn` (#702/#705),
  `shape-c-non-recursive-start` (#706/#707)
