# Firegrid Patterns

This folder contains concrete reference shapes for common Firegrid integration
choices. Feature specs under `features/` remain the source of truth; pattern
docs cite ACIDs and show the app-level code shape those ACIDs authorize.

Use these docs when an implementation question is really a placement question:
which package imports what, where a runtime Layer is provided, and which public
client surface a browser should use.

## Decision Tree

| Question | Default answer | ACID |
| --- | --- | --- |
| Where does runtime handler logic run? | Node-tier runtime host; never browser code or a browser-bundler plugin | `firegrid-platform-invariants.LOCALITY.1`; `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.1`, `.5` |
| How does local app dev start? | Embedded app dev may start or coordinate local Firegrid infrastructure; attached `firegrid` mode is a separate advanced path | `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.1`; `firegrid-runtime-process.CONFIG_SURFACE.*` |
| Where does the UI run? | Browser or edge, using `@firegrid/client` and approved browser-safe client subpaths | `firegrid-platform-invariants.LOCALITY.2`; `firegrid-client-projection-api.BROWSER_SAFE_FACADE.1` |
| What carries ordered history? | `EventStream.define` plus `FiregridClient.emit` and `FiregridClient.events` | `firegrid-event-streams.*`; `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.1`, `.2` |
| What carries keyed read models? | App-owned EventPlane descriptors, read in browser through `@firegrid/client/projection-query` | `firegrid-client-projection-api.BROWSER_SAFE_FACADE.*`; `firegrid-projection-query.QUERY_HANDLES.*` |
| How does a runtime handler emit timeline/progress rows? | Provide `FiregridClientLive` once in `Firegrid.composeRuntime({ provide })`; inside the handler yield `FiregridClient` and call `client.emit(...)` | `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.*`; `firegrid-agent-runtime-substrate.MULTI_WAIT_RESUME.2` |
| How do runtime subscribers react? | `Firegrid.subscribers.projectionMatch` for projection waits; `Firegrid.eventStream` for EventStream materialization | `run-wait-primitives.*`; `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.2` |

## Patterns

- [Runtime handler emits app-owned EventStream rows](./node-runtime-with-client-emit.md)
- [Browser reads app-owned projection state](./browser-eventplane-projection.md)
- [Browser reads a live list](./eventstream-folded-as-list.md)
- [Runtime host is Node-tier, not a browser dev-server plugin](./node-runtime-as-separate-process.md)

## Anti-Patterns

| Anti-pattern | Why it is wrong | ACID |
| --- | --- | --- |
| Browser fetches a generated `public/topology.json` to discover runtime state | Runtime configuration is an app/backend contract, not a generated browser-public file handoff | `firegrid-agent-runtime-substrate.RECONNECT_REPLAY.5`; `firegrid-client-projection-api.BROWSER_SAFE_FACADE.1` |
| App product code calls `@durable-streams/client` to create/head streams | Firegrid public client/runtime APIs are the product boundary; direct Durable Streams control belongs below Firegrid or in test harnesses | `firegrid-platform-invariants.LOCALITY.5`; `firegrid-platform-invariants.AUTHORITY.7` |
| Vite plugin imports `@firegrid/runtime` into the browser dev server | Runtime is Node-tier and should be hosted by an app runtime/dev orchestrator, not the browser bundler | `firegrid-platform-invariants.LOCALITY.1`; `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.5` |
| Runtime handler constructs `FiregridClientLive` inside every helper call | Client Layer should be provided once at runtime composition boundary | `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.1` |
| Treating `Firegrid.eventStream(...)` as an EventStream emit primitive | It is a materializer/subscriber; the emitter is `FiregridClient.emit` | `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.2` |
| Browser code imports `@firegrid/runtime` or `@firegrid/substrate/kernel` | Runtime and kernel are not browser app surfaces | `firegrid-platform-invariants.LOCALITY.1`; `firegrid-platform-invariants.LOCALITY.5` |
| Runtime code writes raw terminal rows to fake operation completion | Terminalization is handler return or `Effect.fail` only | `firegrid-platform-invariants.AUTHORITY.1`, `.2`, `.3` |
| Fake assistant/provider output in a replatforming proof | Product adapters own provider semantics; Firegrid only carries durable mechanics | `flamecast-product-contract.EVENTS.*`; `flamecast-product-contract.LOWERING.7` |

## Adding Patterns

Add a pattern when ACIDs already authorize a shape but implementers keep
choosing the wrong seam. A pattern should cite complete ACIDs, show concrete
imports and composition, and stay short enough to use during implementation.
