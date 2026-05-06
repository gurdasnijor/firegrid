# Firegrid Patterns

This folder contains runnable reference shapes for common Firegrid integration
decisions. Each pattern doc is the canonical answer to one "where do I put
this?" question and cites the specific Acai ACIDs that authorize the shape.

Authority order is unchanged: feature specs under `features/` are the source of
truth; pattern docs cite ACIDs and never introduce new behavior. Where a pattern
seems to conflict with a spec, the spec wins and the pattern doc must be
updated.

## Topology Decision Tree

When integrating Firegrid into a new product, answer these questions in order
before writing code:

| Question | Answer | ACID |
| --- | --- | --- |
| Where does runtime handler logic run? | Node-tier process; not a browser, edge worker, Cloudflare Worker, or browser-bundler plugin | `firegrid-platform-invariants.LOCALITY.1`; `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.1`, `.5` |
| Where does the UI run? | Browser or edge; uses `@firegrid/client` | `firegrid-platform-invariants.LOCALITY.2` |
| What primitive carries ordered history? | `EventStream.define` plus `FiregridClient.emit` and `FiregridClient.events` | `firegrid-event-streams.*`; `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.1`, `.2` |
| What primitive carries keyed state? | `EventPlane.define` plus `EventPlane.layer` (Producer + Projection) | `client-event-plane-registration.*`; `firegrid-platform-invariants.LOCALITY.5`, `.7` |
| How do runtime subscribers react to events? | `Firegrid.subscribers.projectionMatch` for projection waits; `Firegrid.eventStream` to materialize EventStream entries | `run-wait-primitives.*`; `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.2` |
| How do browser readers consume EventPlane state? | `EventPlane.layer({ streamUrl })` from `@firegrid/substrate/event-plane` plus the typed `PlaneProjection` Tag | `firegrid-platform-invariants.LOCALITY.5`, `.7`; `firegrid-projection-query.QUERY_HANDLES.*` |
| How does the runtime emit app-owned EventStream rows mid-handler? | `FiregridClient.emit(stream, event)` from `@firegrid/client` imported in the same Node entrypoint that uses `@firegrid/runtime` | `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.1`, `.3`; `firegrid-platform-invariants.LOCALITY.3-note` |

## Patterns

- [Node runtime emits app-owned EventStream rows from handlers](./node-runtime-with-client-emit.md)
- [Browser reads app-owned EventPlane projection](./browser-eventplane-projection.md)
- [Browser folds app-owned EventStream into a list](./eventstream-folded-as-list.md)
- [Node runtime as a separate process from the browser dev server](./node-runtime-as-separate-process.md)

## Anti-Patterns

These shapes look attractive at first read but violate boundary or topology
ACIDs. Do not use them.

| Anti-pattern | Why it is wrong | ACID |
| --- | --- | --- |
| Vite plugin that imports `@firegrid/runtime` into the browser dev server process | The runtime is Node-tier and must run in a separate process; pulling it into a bundler plugin loads `dist`-only exports before they are built and conflates browser bundling with runtime execution | `firegrid-platform-invariants.LOCALITY.1`; `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.1`, `.5` |
| Browser code that reaches for `@firegrid/substrate/kernel` to read durable rows | The kernel is not application-facing | `firegrid-platform-invariants.LOCALITY.5` |
| Runtime code that writes raw `durable.run` envelope rows to fake terminalization | Terminalization is the handler authority path only | `firegrid-platform-invariants.AUTHORITY.1`, `.2`, `.3` |
| Synthesizing `_tag: "Completed"` or `_tag: "Failed"` outside the handler return path | Same | `firegrid-platform-invariants.AUTHORITY.2` |
| `Effect.sleep` between handler emit and `RunWait.for` in a test or smoke | Hides whether the wait actually fired | `firegrid-platform-invariants.AUTHORITY.5`, `.6` |
| Treating `Firegrid.eventStream(...)` as an EventStream emit primitive | It is a materializer/subscriber, not an emitter; emit is `FiregridClient.emit` | `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.2` |
| Adding `@firegrid/runtime` to `@firegrid/client`'s `package.json` dependencies (or vice versa) so a runtime helper can call a client helper | The package-manifest edge is forbidden; do the import at application level instead | `firegrid-platform-invariants.LOCALITY.3`, `.4`, `.3-note` |

## How to Add a Pattern

A pattern doc is added when an implementer hits friction that ACIDs already
authorize but the canonical shape was not obvious. The doc must:

- cite every ACID the pattern relies on by full identifier;
- show a concrete code shape with explicit imports and explicit composition,
  not pseudocode;
- include the project-layout context where placement matters (Node entrypoint
  path, dev-script wiring, package-manifest dependencies);
- list the anti-patterns the implementer might have tried first;
- stay short — patterns are decision anchors, not tutorials.
