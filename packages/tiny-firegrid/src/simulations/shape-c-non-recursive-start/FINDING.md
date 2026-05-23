# shape-c-non-recursive-start — Wave C public start facade (non-recursive)

**Verdict: GREEN.** The minimal non-recursive public start/turn shape is
expressible over existing channel/router/request-row/reconciler primitives
only. No new driver, no new runner, no generic stream surface, no new
router surface, no direct handler call from the client/edge/public facade.

CC1's recursion blocker is a code-path bug, not a primitive gap. The fix
is a three-surface decomposition that already lives in the production
codebase as separate symbols; the bug bound them together. This sim
validates the decomposition stands on its own.

## CC1's blocker (the recursion)

```
caller
   ↓
public startRuntime (host-sdk)
   ↓                              ┌─────────────────────────────────┐
HostSessionsStartChannel.call ────┤ writes RuntimeStartRequestRow   │
                                  │ ack returned to caller          │
   ↓                              └─────────────────────────────────┘
caller awaits session.agent_output
                                  ┌─────────────────────────────────┐
reconciler                ────────┤ sees pending startRequests row │
                                  └────────────┬────────────────────┘
                                               ↓
                          RuntimeControlRequestSideEffects.start
                                               ↓
                              **calls public startRuntime again** ← bug
                                               ↓
                              another HostSessionsStartChannel.call
                                               ↓
                              another startRequests row
                                               ↓
                              deadlock; no session ever runs
```

## The non-recursive shape (this sim)

Three distinct surfaces, each with a single responsibility:

```
                                    ┌──────────────────────────────────────┐
caller                              │ Surface 1: PUBLIC START FACADE       │
   ↓                                │                                      │
startSession(router, …)             │ - call host.sessions.start (1 write) │
   ↓                                │ - wait_for session.agent_output      │
host.sessions.start (call)          │ - return terminal observation        │
   ↓                                │                                      │
durable startRequests row           │ does NOT touch substrate directly    │
                                    │ does NOT call reconciler             │
   ↓                                │ does NOT call internal side-effect   │
caller waits on session.agent_output└──────────────────────────────────────┘

                                    ┌──────────────────────────────────────┐
reconcileOnce(substrate, hooks)     │ Surface 2: RECONCILER                │
   ↓                                │                                      │
drains pending startRequests rows   │ - drains pending startRequests       │
   ↓                                │ - invokes internalHostStart per row  │
internalHostStart(request)          │                                      │
                                    │ does NOT call the public facade      │
                                    └──────────────────────────────────────┘

                                    ┌──────────────────────────────────────┐
internalHostStart(request)          │ Surface 3: INTERNAL SIDE-EFFECT      │
   ↓                                │                                      │
emits Terminated/Error onto         │ - physically starts the session      │
session.agent_output stream         │ - emits Terminated/Error to outputs  │
                                    │                                      │
                                    │ does NOT call the public facade      │
                                    │ does NOT write a new startRequest    │
                                    └──────────────────────────────────────┘
```

The recursion is impossible because **Surface 3** (`internalHostStart`)
has no callable reference to **Surface 1** (`startSession`) — neither in
its imports nor in its body. The structural recursion-guard tests pin
this via file-text assertions.

## Production target mapping

| Sim concept | Production symbol | Location |
|---|---|---|
| Public start facade (Surface 1) | `startRuntime(options)` | `packages/host-sdk/src/host/commands.ts:188` |
| Public start route | `HostSessionsStartChannel` (CallableChannel) | declared `packages/protocol/src/channels/host-control.ts`; impl in `packages/protocol/src/launch/host-control-request.ts:143` (`makeHostSessionsStartChannel`) — writes `makeRuntimeStartRequestRow({ contextId, requestedBy: "client" })` via `control.startRequests.insertOrGet(stamped)` and returns `RuntimeStartRequestAck` |
| Durable start-request row | `RuntimeStartRequestRow` | `packages/protocol/src/launch/control-request.ts:132` |
| Observation source | `SessionAgentOutputChannel.forContext(contextId).binding.stream` | `packages/protocol/src/channels/session-agent-output.ts`; route registered on `HostPlaneChannelRouter` by #703 (`sessionAgentOutputObservationRoute` in `packages/runtime/src/channels/host-control-routes.ts`) |
| Reconciler (Surface 2) | `reconcileRuntimeControlRequestsOnce` / `runRuntimeControlRequestReconciler` | `packages/runtime/src/control-plane/control-request-dispatcher.ts:683` and `:720` |
| Internal side-effect (Surface 3) | `RuntimeControlRequestSideEffects.start(request)` service tag | `packages/runtime/src/control-plane/control-request-dispatcher.ts:53-68` (interface), invoked at `:375` (`sideEffects.start(request)`) |

The reconciler in production already invokes `sideEffects.start(request)`
through the typed `Context.Tag` boundary, not through the public
`startRuntime` facade. The recursion CC1 hit means the **implementation of
the `RuntimeControlRequestSideEffectsService.start` method** routed back
through `startRuntime` rather than directly through the existing private
host-start primitive.

## What CC1's deletion PR needs (mapped through this sim)

This sim says nothing has to be invented. CC1's cutover removes the
recursion by ensuring three constraints hold simultaneously:

1. **`startRuntime` (public facade)** — `commands.ts:188` — body must
   reduce to: `HostSessionsStartChannel.binding.call({ sessionId })` →
   await on `SessionAgentOutputChannel.forContext(contextId).binding.stream`
   filtered for terminal `_tag`. No other writes; no other invocations
   into the substrate. Production `startRuntime` today still
   `yield* RuntimeContextWorkflowRuntime` and calls
   `claimAndRunRuntimeContextWorkflow(context, runtime, agentToolHost)` —
   that's the body to delete (cf. `commands.ts:206-208`).
2. **`reconcileRuntimeControlRequestsOnce`** — already calls
   `sideEffects.start(request)` (line 375). This is unchanged.
3. **`RuntimeControlRequestSideEffectsService.start`** — the implementation
   bound by the host composition (currently
   `RuntimeContextWorkflowRuntimeLive` per `layers.ts:340`) must invoke
   the **private host start primitive** (the runtime's
   session/body start over `RuntimeOutputTable` + per-context sandbox),
   **not** `startRuntime(...)`. CC1 reported the recursion because the
   bound implementation re-entered the public facade.

In short: the recursion is in `RuntimeControlRequestSideEffectsService.start`'s
implementation, not in any primitive. The deletion lane retargets that
implementation to the runtime-internal start primitive (which already
exists — sandbox spawn + codec init + per-context output journal), and
the public facade becomes pure dispatch + observe.

## Counter assertions (the test harness)

| Counter | What it counts | Expected per `startSession` call |
|---|---|---|
| `substrate.startRequestWrites` | Times `host.sessions.start` route's call body ran (durable row writes) | **1** |
| `substrate.reconcilerDrains` | Times the reconciler polled and (possibly) drained pending requests | ≥ 1 (driven by sim's polling cadence; production is row-subscription-driven) |
| `substrate.internalStartInvocations` | Times the internal side-effect `internalHostStart` was invoked | **1** |

If any of these exceeds the expected value, the recursion is back. The
two happy-path tests and the error-path test all assert these counters.

## Structural recursion guard

The recursion bug looks like `import { startSession } from "./public-facade.ts"`
appearing inside the internal side-effect's source file. The test grep-
asserts the inverse:

- `runtime.ts` (Surface 2 + 3) does **not** import `./public-facade.ts`.
- `runtime.ts` does **not** reference the `startSession` symbol anywhere.
- `runtime.ts` does **not** mention `router.dispatch` (the side-effect
  cannot re-enter the wire-edge).
- `public-facade.ts` imports **only** type-level surface from
  `runtime.ts` (`Router`, `RuntimeStartRequestAck`, `SessionAgentOutputObservation`).
  It does not import `makeSubstrate`, `reconcileOnce`, `internalHostStart`,
  `makeRouter`, or any route factory.
- `public-facade.ts`'s only dispatch calls are
  `router.dispatch.call("host.sessions.start", …)` and
  `router.dispatch.waitFor("session.agent_output", …)`. It does not
  touch the substrate, the reconciler, or the side-effect directly.

These structural assertions translate to production simply: in CC1's
deletion PR, the bound `RuntimeControlRequestSideEffectsService.start`
implementation must not import `startRuntime` from
`packages/host-sdk/src/host/commands.ts`. The same grep test in the host-
sdk-side cutover lane (or a Semgrep rule scoped to the side-effect's
implementation module) would catch any regression at CI time.

## Hard constraints — all observed

| Constraint | Status |
|---|---|
| No new driver / runner / generic stream | ✅ — only `host.sessions.start` callable channel + `session.agent_output` ingress channel are used |
| No direct handler call from client/edge/public facade | ✅ — `public-facade.ts` dispatches only through the typed `Router`; recursion-guard test asserts no substrate import |
| No `RuntimeObservationStreams` | ✅ — observation goes through `SessionAgentOutputChannel`-shaped `wait_for` only |
| No new router surface | ✅ — the existing 2-route shape (call + ingress) is what the SDD pins; this sim reuses it |
| Use existing channel/router/request-row/reconciler concepts | ✅ — production mapping table above; every sim concept maps 1:1 to an existing production symbol |

## Test command

```
pnpm --filter @firegrid/tiny-firegrid test test/shape-c-non-recursive-start/probe.test.ts
pnpm --filter @firegrid/tiny-firegrid typecheck
```

## Sources

- `docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md`
- `docs/architecture/host-sdk-runtime-boundary.md`
- `docs/sdds/SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY_IMPLEMENTATION.md`
- `packages/runtime/src/control-plane/control-request-dispatcher.ts`
  (`RuntimeControlRequestSideEffects`, `reconcileRuntimeControlRequestsOnce`)
- `packages/protocol/src/launch/host-control-request.ts:143`
  (`makeHostSessionsStartChannel`)
- `packages/protocol/src/launch/control-request.ts:132`
  (`RuntimeStartRequestRow`)
- `packages/host-sdk/src/host/commands.ts:188` (`startRuntime` — the
  body that needs the deletion lane to drop the
  `RuntimeContextWorkflowRuntime` re-entry)
- `packages/runtime/src/channels/host-control-routes.ts` (#703 —
  `sessionAgentOutputObservationRoute`)
- Companion sim `packages/tiny-firegrid/src/simulations/shape-c-channel-router-turn/`
  (#702 / #705) — proves the broader Wave C client-surface dispatch
  contract this sim's three-surface split builds on
