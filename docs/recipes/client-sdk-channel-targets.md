# Client SDK ↔ Channel Targets

Audience: anyone adding a method to the public client SDK
(`packages/client-sdk/src/firegrid.ts`) or any host integrator wiring an
alternative client/edge over the existing channel router.

**TL;DR.** Every public client method routes through a typed `ChannelTarget`
on the `HostPlaneChannelRouter`. Adding a new method = pick a verb +
target + completion semantics, lower from public schema to channel input
schema, register the route. There is no other path into the runtime
through the client.

## The dispatch contract

| Public client method | Channel target | Verb | Direction | Completion |
|---|---|---|---|---|
| `client.launch({ contextId })` | `host.contexts.create` | `call` | call | terminal (response schema) |
| `client.prompt({ contextId, inputId, prompt })` | `host.prompt` | `send` | egress | acknowledgement (input intent row receipt) |
| `client.sessions.createOrLoad({ externalKey })` | `host.sessions.create_or_load` | `call` | call | terminal (`SessionHandleReference`) |
| `client.sessions.attach({ sessionId })` | — | — | — | — (pure client-side handle) |
| `client.open(contextId)` | — | — | — | — (pure client-side handle; reads runtime tables for snapshot) |
| `handle.start()` | `host.sessions.start` | `call` | call | terminal (`RuntimeStartRequestAck`) |
| `handle.prompt({ inputId, prompt })` | `session.prompt` | `send` | egress | acknowledgement |
| `handle.wait.forAgentOutput({ afterSequence })` | `session.agent_output` | `wait_for` | ingress | terminal (via `RouteCompletionReceipt`) |
| `handle.wait.forPermissionRequest({ afterSequence })` | `session.agent_output` | `wait_for` | ingress | terminal — **same ingress, predicate-filtered for `PermissionRequest`** |
| `handle.permissions.respond({ permissionRequestId, decision })` | `host.permissions.respond` | `call` | call | terminal — handle bakes `contextId` in |
| `client.permissions.respond({ contextId, permissionRequestId, decision })` | `host.permissions.respond` | `call` | call | terminal — same target as the handle-scoped path |
| Agent error observation | `session.agent_output` | `wait_for` | ingress | terminal — **same ingress, predicate-filtered for `_tag === "Error"`**. Variant carries `recoverable: boolean` |

Out of scope today (mechanical to add — no new abstraction needed):

- `client.watchContexts(predicate)` → would add a `host.contexts` ingress route.
- `handle.snapshot` → currently reads runtime tables (`runtime-output`, `runtime-control-plane`) directly. Can stay table-direct or repoint through a dedicated ingress route later. Not on the public-turn critical path.

## Where the targets live

| Target | Channel constructor + Tag |
| --- | --- |
| `host.contexts.create` | `HostContextsCreateChannel` — `packages/protocol/src/channels/host-control.ts` |
| `host.prompt` | `HostPromptChannel` — `packages/protocol/src/channels/host-control.ts` |
| `host.sessions.create_or_load` | `HostSessionsCreateOrLoadChannel` — `packages/protocol/src/channels/host-sessions-create-or-load.ts` |
| `host.sessions.start` | `HostSessionsStartChannel` — `packages/protocol/src/channels/host-control.ts` |
| `host.permissions.respond` | `HostPermissionRespondChannel` — `packages/protocol/src/channels/host-control.ts` |
| `session.prompt` | `SessionPromptChannel` — `packages/protocol/src/channels/host-control.ts` (per-session factory via `.forSession(sessionId)`) |
| `session.agent_output` | `SessionAgentOutputChannel` — `packages/protocol/src/channels/session-agent-output.ts` (per-context factory via `.forContext(contextId)`) |

`SessionPermissionChannel` (`session-permission.ts`) exists but the
production client does **not** use it on the public turn — both respond
paths go through `host.permissions.respond`. Document if you find a
use case; don't reach for it without one.

## Adding a new client method

1. **Pick the shape.** Which verb? `call` (request/response), `send`
   (egress fire-and-acknowledge), `wait_for` (ingress stream observe)?
2. **Pick or add the channel target.** If an existing target already
   serves the data (e.g., a new agent-output predicate filter), reuse it
   — that's how `wait.forPermissionRequest` and the error observation
   work. If you genuinely need a new wire-edge concern, declare a new
   target in `packages/protocol/src/channels/<area>.ts` using
   `makeChannelTarget("...")` and one of `makeIngressChannel` /
   `makeEgressChannel` / `makeCallableChannel` /
   `makeBidirectionalChannel`.
3. **Lower public → channel input schema.** Public schemas often differ
   from the durable wire shape (e.g., `client.prompt` carries `prompt`
   but `HostPromptChannel` carries `payload`). Lower at the client-facing
   facade, never inside the channel itself.
4. **Register the route on `HostPlaneChannelRouter`.** Runtime-side Live
   layers under `packages/runtime/src/channels/<channel>/live.ts` and
   `packages/runtime/src/channels/host-control-routes.ts` are the
   composition seam.
5. **Dispatch from the client.** Read the channel `Context.Tag` and
   call `binding.{call, append, stream}`. Don't construct a separate
   transport.

## Existing extension patterns (reuse first)

- **Predicate-filtered ingress.** `handle.wait.forPermissionRequest`
  and agent-error observation both reuse `session.agent_output` with a
  predicate. If your new method is "observe a subset of an existing
  stream," do this — don't add a new route.
- **Per-key factory channels.** `SessionAgentOutputChannel.forContext(contextId)`
  and `SessionPromptChannel.forSession(sessionId)` are factory-keyed.
  Input schemas carry the key (e.g., `SessionAgentOutputRouteInputSchema`).
- **Pure client-side handles.** `client.sessions.attach`, `client.open`,
  and `handle.snapshot` perform no channel dispatch — they construct a
  handle or read tables directly. Use this when the operation truly is
  read-only or handle-construction.

## Regression evidence

The mapping table above is asserted as a structural contract by the
firelab simulation:

```
pnpm --filter firelab test test/shape-c-channel-router-turn/probe.test.ts
```

(25/25 vitest tests as of the FINDING reference below.) The simulation
binds a blackbox client that mirrors the production `firegrid.ts`
through the seven targets, asserts file-text guards that prevent client
code from drifting into substrate access, and exercises the full
public-turn including permission round-trip and agent-error observation.
If a future PR changes the public client shape, this is the test that
fails loud.

## Ground Truth

- `packages/firelab/src/simulations/shape-c-channel-router-turn/FINDING.md`
  — the verdict, the mapping derivation, the negative guards, the
  out-of-scope decisions.
- `packages/client-sdk/src/firegrid.ts` — the production surface.
- `packages/protocol/src/channels/` — channel target declarations and
  `Context.Tag`s.
- `packages/runtime/src/channels/router/live.ts` — `HostPlaneChannelRouter`
  composition.
- `packages/runtime/src/channels/host-control-routes.ts` — runtime
  route registrations (the `*Route` modules).
- `docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md` — the dispatch
  router SDD.
- `docs/architecture/2026-05-22-shape-c-cutover-roadmap.md` § Wave C —
  the cutover that landed this contract.

## Do Not Reimplement

- **No alternative dispatch path.** The router is the only seam.
  Bypassing it (direct service calls, direct table reads from client
  code, etc.) is a Shape C boundary violation; the simulation's
  negative file-text guards (`client.ts` is dispatch-only, no
  `Math.random`/`randomUUID`) are the gate.
- **No client-side runtime imports.** The public client must not import
  `@firegrid/runtime/*` directly. Channel `Context.Tag`s live in
  `@firegrid/protocol`; that's the only protocol-level boundary the
  client crosses.
- **No new "permission channel" or "error channel."** Both reuse
  `session.agent_output` with a predicate filter. Adding a parallel
  ingress route for a subset of an existing typed source is the
  reinvention pattern this recipe exists to prevent.

## Related Recipes

- [Durable webhook facts and `wait_for`](durable-webhook-facts-and-wait-for.md) —
  same channel-as-observation pattern for external webhook providers.
- [Runtime permission resume](runtime-permission-resume.md) — the
  permission round-trip that uses `host.permissions.respond` + the
  predicate-filtered `session.agent_output` ingress.
