# channels/

Logical pipeline position: **5** (peer with `producers/`, `transforms/`). May
import `events/` and `tables/` as needed for channel bindings. Peers do not
import each other. Must not import `subscribers/` or `composition/`.

Source: `docs/architecture/2026-05-22-runtime-physical-target-tree.md`,
`docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md`.

## Owns

Channel capability bindings and wire-edge dispatch. Target layout:

- `host-control/` — host-control channel implementations
- `session/` — session-scoped channel implementations (agent output,
  permission, logs, self)
- `routes/` — typed channel registrations projected to router routes
- `router.ts` — `HostPlaneChannelRouter` / `RuntimeChannelRouter`; schema
  parsing, direction/verb checks, route invocation
- `observation-streams/` — typed observation-source capability tags used by
  wait/router subscribers

Channels are typed semantic capabilities. A channel folder defines an
`IngressChannel`, `EgressChannel`, `CallableChannel`, or
`BidirectionalChannel` service and the route projection that registers it.

## May import

- `events/`, `tables/`
- protocol channel contracts (`@firegrid/protocol/channels/*`)
- `effect`, `effect/Stream`

## Must not import

- peer-tier `producers/`, `transforms/`
- `subscribers/`, `composition/`. Subscribers consume channel tags through
  their `R` channel; the channels folder does not call subscribers.

## DO

```ts
// session/agent-output/index.ts
export const sessionAgentOutputChannel =
  Context.GenericTag<SessionAgentOutputChannelService>("...")
// session/agent-output/route.ts projects a route over the tag
```

## DO NOT

```ts
// router.ts
import { handleRuntimeContextEvent } from "../subscribers/runtime-context/handler.ts" // direction violation
```

## Scaffold status

Empty `host-control/`, `session/`, and `routes/` subfolders are staged as
Wave 2 destinations. The current top-level `.ts` files (`router.ts`,
`session-agent-output.ts`, `session-permission.ts`, `session-log.ts`,
`host-control.ts`, `session-agent-output-route.ts`,
`host-control-routes.ts`) are the live pre-cutover layout. Wave 2 sorts them
into the subfolders; the public `@firegrid/runtime/channels` barrel stays
stable.
