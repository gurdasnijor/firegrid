# shape-c-channel-router-turn — Wave C dispatch contract (blackbox client)

**Verdict: GREEN.** The existing production channel targets are
sufficient to express the full public client turn surface from
`packages/client-sdk/src/firegrid.ts` through `router.dispatch.{call,
send, waitFor}` by string target only. No new protocol contract or
runtime abstraction is required. The mapping table below **is the Wave C
dispatch contract.**

## The Wave C dispatch contract

| Public client method | Production channel target | Verb | Direction | Completion | Production source |
|---|---|---|---|---|---|
| `client.launch({ contextId })` | `host.contexts.create` | `call` | `call` | `terminal` (response schema) | `HostContextsCreateChannel` — `packages/protocol/src/channels/host-control.ts`; production client `firegrid.ts:1023` calls `hostContextsCreateChannel.binding.call({ contextId, runtime })` |
| `client.prompt({ contextId, inputId, prompt })` | `host.prompt` | `send` | `egress` | `acknowledgement` (input intent row receipt) | `HostPromptChannel` — `host-control.ts`; production `appendHostPrompt` (`firegrid.ts:825`) calls `hostPromptChannel.binding.append(request)` |
| `client.sessions.createOrLoad({ externalKey })` | `host.sessions.create_or_load` | `call` | `call` | `terminal` (`SessionHandleReference`) | `HostSessionsCreateOrLoadChannel` — `packages/protocol/src/channels/host-sessions-create-or-load.ts`; production `createOrLoadSession` calls `hostSessionsCreateOrLoadChannel.binding.call(...)` |
| `client.sessions.attach({ sessionId })` | — | — | — | — | **Pure client-side handle construction.** Production `attachSession` (`firegrid.ts`) returns `makeSessionHandle(decoded.sessionId)`; no channel call. The sim mirrors this. |
| `client.open(contextId)` | — | — | — | — | **Pure client-side handle construction.** Production `open()` returns `{ contextId, snapshot }` where `snapshot` reads runtime tables; no channel call. |
| `handle.start()` | `host.sessions.start` | `call` | `call` | `terminal` (`RuntimeStartRequestAck`) | `HostSessionsStartChannel` — `host-control.ts`; production `handle.start` calls `hostSessionsStartChannel.binding.call({ sessionId })` |
| `handle.prompt({ inputId, prompt })` | `session.prompt` | `send` | `egress` | `acknowledgement` (input intent row receipt) | `SessionPromptChannel` — `host-control.ts`; per-session factory (`sessionPromptChannel.forSession(sessionId)`); sim models the factory by passing `sessionId` in the input schema |
| `handle.wait.forAgentOutput({ afterSequence })` | `session.agent_output` | `wait_for` | `ingress` | `terminal` via `RouteCompletionReceipt` | `SessionAgentOutputChannel` — `packages/protocol/src/channels/session-agent-output.ts`; per-context factory; input schema = `SessionAgentOutputRouteInputSchema { contextId, afterSequence }` |
| `handle.wait.forPermissionRequest({ afterSequence })` | `session.agent_output` | `wait_for` | `ingress` | `terminal` via `RouteCompletionReceipt` | **Same ingress, filtered by predicate.** Production `waitForPermissionRequest` (`firegrid.ts:743`) calls `waitForAgentOutputObservation(contextId, input, observation => isPermissionRequest(observation))`. **No `session.permission_request` route exists in production** — the predicate filter on the typed source observation union is the production contract. |
| `handle.permissions.respond({ permissionRequestId, decision })` | `host.permissions.respond` | `call` | `call` | `terminal` (response schema) | `HostPermissionRespondChannel` — `host-control.ts`; the handle's `permissions.respond` bakes `contextId` from the handle into the request — production `firegrid.ts` uses `hostPermissionRespondChannel` for BOTH session-scoped and top-level respond. |
| `client.permissions.respond({ contextId, permissionRequestId, decision })` | `host.permissions.respond` | `call` | `call` | `terminal` (response schema) | Same as above; the host-scoped path. Production `firegrid.ts:permissions.respond` calls `hostPermissionRespondChannel.binding.call(...)`. |
| `client.watchContexts(predicate)` | _OUT OF SCOPE_ | _wait_for_ | _ingress_ | — | Production maps to `HostContextsChannel` ingress stream (`host.contexts`) — `firegrid.ts:waitUntilContextReady` uses `hostContextsChannel.binding.stream`. Adding it requires one more ingress route; see "Out of scope" below. |

### Permission ambiguity resolved → GREEN

The task asked: "session.wait.forPermissionRequest → session.agent_output / wait_for filtered for PermissionRequest, OR YELLOW if existing channel contract needs a dedicated permission-request route".

**Resolution: filtered, GREEN.** Production already filters the same
typed source — `firegrid.ts:743` `waitForPermissionRequest` reuses
`waitForAgentOutputObservation` with the predicate
`observation => Option.isSome(runtimePermissionRequestObservationFromAgentOutput(observation))`.
The Wave C dispatch contract therefore needs no dedicated
`session.permission_request` route. The sim asserts this structurally
(the `forPermissionRequest` body must contain both the
`session.agent_output` dispatch and the `"PermissionRequest"` filter
predicate).

### Permission respond ambiguity resolved → GREEN

The task asked: "permissions.respond and session.permissions.respond → host.permissions.respond / call".

**Resolution: both → `host.permissions.respond`, GREEN.** Production
`firegrid.ts:540` resolves a single `HostPermissionRespondChannel`
service and uses it for both `client.permissions.respond` (top-level,
contextId in request) and `handle.permissions.respond` (session-scoped,
contextId baked from the handle). The sim's client mirrors this:
`handle.permissions.respond` is a thin closure that supplies
`contextId` from the handle and dispatches `host.permissions.respond`.

A separate `SessionPermissionChannel` (`session.permissions.respond`)
exists in `packages/protocol/src/channels/session-permission.ts` but
the production client does not use it for the public turn — see
`firegrid.ts:540`. Wave C does not need to add it.

## Out of scope

- **`client.watchContexts(predicate)`.** Production lowers to the
  `HostContextsChannel` ingress stream (`host.contexts`). Adding it to
  the sim would require one more ingress route. The decision is purely
  mechanical (same pattern as `session.agent_output`); recording as
  out-of-scope keeps the proof tight. If Wave C dispatch needs it, add
  `host.contexts` ingress route alongside the seven existing ones; no
  new protocol contract required.
- **`handle.snapshot`.** Reads runtime tables (`runtime-output`,
  `runtime-control-plane`) directly in production. The sim returns a
  stub `{ contextId }`. The snapshot path bypasses channels because
  production reads durable tables — that is **the legacy table-read
  path**, not the typed-ingress channel path. Wave C may keep snapshot
  as table-direct or repoint it through a dedicated ingress route
  later; it is not on the public-turn critical path.
- **`autoApprovePermissions`** and other ergonomic helpers — they
  compose `wait.forPermissionRequest` + `permissions.respond` and add
  no new dispatch primitive.
- **Schema richness.** Sim schemas carry only the public-turn fields;
  production carries additional metadata (`runtime` intent, `createdBy`,
  `idempotencyKey`, `metadata`, `responseOrigin`). The reductions don't
  change verb/direction/completion shape.

## Divergences from `packages/protocol/src/channels/*` (ledger)

1. **`ChannelTarget` brand.** Sim uses `Brand.nominal<ChannelTarget>()`;
   production uses `Schema.String.pipe(Schema.brand("ChannelTarget"))`
   via `makeChannelTarget`. Same nominal-brand idea.
2. **Per-session factory channels** (`SessionPromptChannel`,
   `SessionAgentOutputChannel`). Sim models the production projection
   directly — input schema carries the key (`sessionId` for prompts;
   `{ contextId, afterSequence }` for output observation, matching
   production `SessionAgentOutputRouteInputSchema`).
3. **Per-channel `Context.Tag`s omitted.** Production wires each channel
   through a `Context.Tag` service for Layer composition; the sim's
   host facade composes route descriptors directly. Shape unchanged.
4. **Schemas reduced** to the public-turn subset (no `runtime` intent
   union, no `createdBy`, no `idempotencyKey`/`metadata` fields). The
   verb/direction/completion shape is unchanged.
5. **No bidirectional channels.** No Wave C target needs one.
6. **Public field name vs durable field name.** Public client `prompt`
   field translates to durable `payload` at the dispatch site — same as
   production (`firegrid.ts:appendHostPrompt` decodes
   `PublicPromptRequest` → durable input intent row). Translation lives
   inside the client facade.

None of these divergences invalidate the proof.

## Invariants asserted (22/22 vitest tests green)

### Positive — Launch + prompt turn shape (2)
1. `client.launch` → `client.prompt` → `handle.wait.forAgentOutput`
   returns the head observation (`TextChunk`) through the router.
2. Full drive through `Terminated` using an explicit `afterSequence`
   loop on the same typed ingress (no internal cursor magic).

### Positive — Sessions turn shape (4)
3. `client.sessions.createOrLoad → handle.runTurn` drives the four
   target turn end-to-end (`TextChunk` + `Terminated`, `exitCode === 0`).
4. `createOrLoad` idempotent on `externalKey`.
5. `client.sessions.attach` is purely client-side (no channel call).
6. `client.open` returns a handle for an existing contextId.

### Positive — Permission round-trip (2)
7. `handle.wait.forPermissionRequest` → `handle.permissions.respond` →
   continuation through `session.agent_output` until `Terminated`. The
   permission observation flows on the same typed ingress as
   `forAgentOutput`; the respond call lowers to
   `host.permissions.respond`; the runtime emits the continuation
   observations after handling the response.
8. `client.permissions.respond` (top-level) resolves the request via
   the same `host.permissions.respond` route — production behavior.

### Router rejections (2)
9. Wrong verb → `ChannelRouteVerbNotSupported`.
10. Unknown target → `ChannelRouteNotFound`.

### Low-level edge parity (1)
11. `runEdgeTurn` drives the Sessions turn at the raw-dispatch tier.

### Production target mapping (4)
12. The seven target constants equal the production literals.
13. `client.ts` hardcodes the `(verb, target)` pair for each public
    method — rename without proof update fails the test loud.
14. Host facade composes exactly the seven production-keyed routes.
15. `wait.forPermissionRequest` reuses `session.agent_output` ingress
    filtered by predicate (no new route, matches production).

### Negative — file-text (6)
16. `host-facade.ts` is composition-only.
17. `edge.ts` is dispatch-only (no Math.random/randomUUID).
18. **5th negative guard:** `client.ts` is dispatch-only + no
    `Math.random`/`randomUUID` — the public-shape blackbox proof
    surface; can't grow direct substrate access without breaking the
    proof.
19. `edge.ts` no `Math.random`/`randomUUID`.
20. `runtime-routes.ts` publishes only per-target typed channels — no
    `RuntimeObservationStreams`/`callerFact`/`RuntimeAgentOutputAfterEvents`
    aggregator; `index.ts` re-export surface bounded (no handler, no
    state).
21. `runtime-routes.ts` Shape C handler signature clean
    (C2 / C5 / Cannon §1) — comment-stripped body contains zero
    `WorkflowEngine`/`WorkflowInstance`/`Activity.make`/`DurableDeferred`/
    `DurableClock`/`@effect/workflow`/`AgentSession`/`@firegrid/runtime/kernel`
    references.

### Negative — type-level (1)
22. `Effect.Effect.Context<typeof composeFiregridHost>` is `never`.

## What this means for production Wave C

The mapping table above is **the Wave C dispatch contract.** Production
Wave C (CC1) should:

1. Land runtime-side route Live implementations for the **seven target
   channels** (six already exist as protocol contracts; the runtime
   Live Layers under `composition/host-live.ts` are the cutover scope).
   The Shape C per-event handler is wired **inside** the Live for
   `host.prompt`/`session.prompt` (and observed through
   `session.agent_output`'s `Stream.tap`), NOT exported as a runtime
   symbol.
2. Replace `FiregridRuntimeHostLive`'s `RuntimeContextWorkflowRuntimeLive`
   + `RuntimeInputIntentDispatcherLive` deps with router composition
   over the runtime root from `composition/host-live.ts` (#699). Edges
   (ACP/MCP/CLI/HTTP) keep dispatching by string target.
3. **The production client SDK (`packages/client-sdk/src/firegrid.ts`)
   already routes its public methods through the seven production
   channel `Context.Tag`s.** Wave C lands the route Live Layers;
   **no client-side change is required.** The existing client surface
   IS the Wave C public turn driver.
4. Permission round-trip: production already uses
   `HostPermissionRespondChannel` from both `client.permissions.respond`
   and `handle.permissions.respond` paths. No additional route needed.
5. First Wave C proof test recommendation stays
   `sync-run-integration.test.ts --prompt` per the host-sdk triage —
   same four arrows this sim validates, against real substrate. Add a
   second proof for the permission round-trip once the route Live
   Layers are in place.

## Confidence

- 22 vitest tests green (2 Launch + 4 Sessions + 2 permission +
  2 router rejection + 1 edge parity + 4 production mapping +
  6 negative file-text + 1 type-level).
- `pnpm --filter @firegrid/tiny-firegrid exec tsc --noEmit` — clean.
- `pnpm --filter @firegrid/tiny-firegrid test` — 52/52 (22 new + 30 existing).
- `pnpm preflight` — all gates green (semgrep baseline unchanged 42/42).
- Zero production runtime / host-sdk / client-sdk files touched.

## Remaining ambiguity before production dispatch

**None on the public-turn critical path.** All eight public client
methods that drive a turn (`launch`, `prompt`, `sessions.createOrLoad`,
`sessions.attach`, `open`, `start`, `prompt`, `wait.forAgentOutput`,
`wait.forPermissionRequest`, `permissions.respond` ×2) map cleanly to
existing production channel targets with the verb/direction/completion
already declared in `packages/protocol/src/channels/*`.

**Two acknowledged out-of-scope items** that Wave C may want to
decide on before final dispatch:

1. **`client.watchContexts`** — would add a `host.contexts` ingress
   route. Mechanical; no new abstraction.
2. **`handle.snapshot`** — currently a runtime-tables-direct read in
   production. Wave C can keep that path or repoint snapshot through a
   dedicated ingress route. Not on the public-turn critical path.

Neither blocks Wave C public-turn dispatch.

## Addendum (2026-05-23): error observation — GREEN

**Question (CC1 unblock):** can a client-shaped host facade observe a
runtime/agent error through the existing channel-router path using
`session.agent_output` `wait_for` / typed observation, **without** direct
handler calls, a `RuntimeObservationStreams` surface, a new router
surface, or the workflow body driver?

**Verdict: GREEN.** The Error case is the same filtered typed source
production already uses for `PermissionRequest`. The existing
`session.agent_output / wait_for` route on `HostPlaneChannelRouter` (#703)
carries `_tag: "Error"` observations end-to-end. No new route, no new
abstraction.

### Production wiring already in place

| Production surface | Symbol / location |
|---|---|
| Agent-error event variant | `AgentErrorEventSchema` (`packages/protocol/src/agent-output/schema.ts`) — `Schema.TaggedStruct("Error", { cause: Unknown, recoverable: Boolean })`, union member of `AgentOutputEventSchema` |
| Runtime observation variant | `RuntimeAgentOutputObservationSchema` (`packages/protocol/src/session-facade/schema.ts:319-322`) — `_tag: Schema.Literal("Error")`, `event: AgentErrorEventSchema` |
| Stdio-jsonl codec emit | `recoverableError` (`packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts:42`) — appends `{ _tag: "Error", cause, recoverable: true }` into the per-context output stream |
| ACP codec emit | `recoverableError` (`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:123`) — same shape |
| Per-context observation source | `SessionAgentOutputChannel.forContext(contextId)` (`packages/protocol/src/channels/session-agent-output.ts`) — typed `IngressChannel<…>` |
| Router-registered `wait_for` route | `sessionAgentOutputObservationRoute` (`packages/runtime/src/channels/host-control-routes.ts`, registered on `HostPlaneChannelRouter` by #703) |
| Client-side waiter | `waitForAgentOutputObservation` (`packages/client-sdk/src/firegrid.ts`); `handle.wait.forAgentOutput(...)` — already returns the `RuntimeAgentOutputObservation` union (Error variant inclusive) |
| Filter-by-tag pattern | `firegrid.ts:743` `waitForPermissionRequest` uses the same `forAgentOutput` source with a predicate; mirror the predicate for `_tag === "Error"` |

### Wave C dispatch contract — error observation (mapping back to production)

| Public client behavior | Production channel target | Verb | Direction | Completion | `client/firegrid.ts` method |
|---|---|---|---|---|---|
| Observe agent error during a turn | `session.agent_output` (factory-keyed by `contextId`) | `wait_for` | `ingress` | `terminal` via `RouteCompletionReceipt` | `handle.wait.forAgentOutput(...)`; caller filters on `observation._tag === "Error"` (or wraps in a small predicate helper analogous to `waitForPermissionRequest`) |
| Observe terminal exit code after an error | same | `wait_for` | `ingress` | `terminal` | `handle.wait.forAgentOutput(...)`; same loop pattern existing tests already use, advancing the cursor past the Error observation to the `Terminated` event |
| Distinguish recoverable vs non-recoverable | — | — | — | — | The observation carries `recoverable: Boolean` directly (mirrors `AgentErrorEventSchema`). No second route needed for "fatal vs transient" |

### What this proves about CC1's sync-facade deletion

The host-sdk sync facade's body-side error behavior — currently observed
through the workflow body / mailbox bridge — can be re-expressed as a
filtered typed observation on the existing `session.agent_output`
ingress, exactly mirroring how production already implements
`waitForPermissionRequest`. Concretely:

- `RuntimeContextWorkflowNative` / `RuntimeContextWorkflowRuntime` /
  `runtime-input-deferred` are **not** required to observe the Error
  variant. The codecs already write Error events into
  `RuntimeOutputTable.events`; `RuntimeAgentOutputObservation` already
  carries the `_tag: "Error"` variant; the `session.agent_output`
  route already streams it.
- The sync-facade's "fail this run if the body emitted an Error event"
  semantics can be expressed as a small client-side predicate in the
  `forAgentOutput` loop. No public client API change is needed (the
  surface already exposes the typed observation; the Error variant is
  part of the existing union).
- No `RuntimeObservationStreams` surface, no `session.error_output`
  route, no `wait_for` predicate-tag schema extension. **No new SDD
  surface required.**

### Negative guards (in the new tests)

1. The router's exposed targets after the error path runs are exactly
   the same 7 production targets — no `session.error` /
   `session.error_output` / `session.runtime_error` route appears. The
   second test asserts `Object.keys(router.routes).sort()` matches the
   original 7.
2. The Error variant arrives on `session.agent_output` interleaved with
   `Terminated`, advancing the same `afterSequence` cursor — same
   ordering contract used by the happy-path turn (C6 typed source +
   cursor + match).
3. Both `recoverable: true` and `recoverable: false` cases observe
   correctly — the field passes through the wire-edge unchanged.

### Test command

```
pnpm --filter @firegrid/tiny-firegrid test test/shape-c-channel-router-turn/probe.test.ts
```

25/25 pass (23 from #702 + 2 new error-observation tests).

## Sources

- `docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md`
- `docs/cannon/architecture/runtime-pipeline-type-boundaries.md`
- `docs/cannon/architecture/runtime-design-constraints.md`
- `docs/architecture/host-sdk-runtime-boundary.md` (refreshed in #687)
- `docs/architecture/2026-05-22-shape-c-cutover-roadmap.md` §Wave C
- `packages/client-sdk/src/firegrid.ts` (the production surface this
  sim's `client.ts` mirrors)
- `packages/protocol/src/channels/host-control.ts`
  (`HostContextsCreateChannel`, `HostPromptChannel`,
  `HostSessionsStartChannel`, `SessionPromptChannel`,
  `HostPermissionRespondChannel`)
- `packages/protocol/src/channels/host-sessions-create-or-load.ts`
  (`HostSessionsCreateOrLoadChannel`)
- `packages/protocol/src/channels/session-agent-output.ts`
  (`SessionAgentOutputChannel`)
- `packages/protocol/src/channels/session-permission.ts`
  (`SessionPermissionChannel` — exists but not used by production
  public turn; documented for completeness)
