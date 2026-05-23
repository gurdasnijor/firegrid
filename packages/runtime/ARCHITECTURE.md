# `@firegrid/runtime` Architecture

Status: operational guide for the post Runtime Boundary Reconciliation layout.
The SDDs remain decision records; this file describes how the current runtime
package is organized and how new code should fit it.

## Package Role

`@firegrid/runtime` is the host-side runtime package. It owns runtime host
composition, local agent process execution, codec sessions, durable runtime
output and ingress authorities, workflow-engine integration,
runtime agent tools, runtime agent adapters, observation streams, and adjacent
host-only adapters such as verified webhook ingest.

Browser-safe and app-facing session observation belongs in `@firegrid/client`.
Protocol row schemas and launch/session vocabulary belong in
`@firegrid/protocol`. Generic durable stream and operator primitives belong in
`effect-durable-operators` only after a package-boundary SDD proves the
extraction is independent of Firegrid runtime vocabulary.

## Public Subpaths

The package root re-exports the current public runtime surface for existing
callers. Prefer explicit subpaths in new code:

| Import path | Role |
| --- | --- |
| `@firegrid/runtime/runtime-host` | Runtime host layers, config-derived host layers, `startRuntime`, ingress helpers, app source registration, and local-process env policy. |
| `@firegrid/runtime/workflow-engine` | Firegrid-backed `@effect/workflow` engine adapter and its durable state row types. |
| `@firegrid/runtime/workflows` | Runtime-owned workflow definitions, payload schemas, outcome schemas, and execution-id helpers. |
| `@firegrid/runtime/events` | Normalized runtime agent event contracts and envelope helpers. |
| `@firegrid/runtime/codecs` | Scoped codec session contracts and concrete ACP / stdio JSONL session layers. |
| `@firegrid/runtime/agent-tools` | Firegrid agent tool schemas as Effect AI tools, MCP projection, host-coupled tool services, and tool-use lowering. |
| `@firegrid/runtime/agent-adapters` | Adapter projections over codec sessions, including ACP adapter helpers. |
| `@firegrid/runtime/sources/sandbox` | Sandbox and local-process source helpers. App code should prefer `runtime-host` unless it truly needs source-level configuration. |

Folders under `packages/runtime/src/**` that do not appear above are internal
implementation boundaries. Avoid adding package exports for review tooling,
docs-only metadata, compatibility aliases, or tests.

## Current Layout

| Folder | Responsibility |
| --- | --- |
| `src/events/` | Normalized agent input/output events, envelope helpers, and stage contracts (pipeline layer 1). |
| `src/tables/` | Durable runtime state and event-table bindings (pipeline layer 2). |
| `src/producers/sandbox/` | Live process, byte stream, and sandbox edges (Shape A producers). |
| `src/producers/codecs/` | Protocol wire/session normalization into `AgentSession` (Shape A producers). |
| `src/producers/ingress-writers/` | Append authorities bridging live boundaries into durable rows. |
| `src/transforms/` | Pure stream/row-shaping reducers, decoders, trigger evaluation. |
| `src/channels/` | Runtime channel implementations, route projections, host-plane router. |
| `src/subscribers/runtime-context/` | Shape C per-event RuntimeContext handler. |
| `src/subscribers/runtime-context-session/` | Shape C codec-session command sink. |
| `src/subscribers/tool-dispatch/` | Shape D tool-dispatch workflow + executor capability. |
| `src/subscribers/wait-router/`, `scheduled-prompt/`, `runtime-control/`, `projections/` | Shape D/B subscriber landing zones. |
| `src/composition/` | Runtime-local Layer composition and topology checks. |
| `src/authorities/` | Runtime control-plane authorities for contexts and runs. |
| `src/workflow-engine/` | Firegrid durable-table adapter for `@effect/workflow` (legacy + Shape D workflow body home). |
| `src/producers/codecs/agent-adapters/` | Runtime-facing agent adapter facades and ACP mapping (Shape A codec-adjacent). |
| `src/verified-webhook-ingest/` | Adjacent verified webhook fact ingest adapter. |

Layer order is `events < tables < producers/transforms/channels < subscribers < composition`. See
[`docs/architecture/2026-05-22-runtime-physical-target-tree.md`](../../docs/architecture/2026-05-22-runtime-physical-target-tree.md)
for the canonical map. The legacy `src/agent-event-pipeline/` bounded context
was retired by the cleanup wave that physically moved its files into the
folders above.

## Event Pipeline Shape

The runtime event pipeline is:

```txt
sources -> codecs -> events -> transforms -> authorities
```

The arrows describe role ownership, not import permission. The live-owner
cutover moved per-context session ownership into host-sdk
`RuntimeContextWorkflowSession` adapters; runtime no longer carries a second
per-session event-loop composition.

The codec contract is an Effect service, not a retained object with an
`open(...)` method:

```ts
class AgentSession extends Context.Tag("@firegrid/runtime/AgentSession")<
  AgentSession,
  {
    readonly meta: AgentCodecMeta
    readonly toolUseMode: AgentToolUseMode
    readonly send: (event: AgentInputEvent) => Effect.Effect<void, AgentCodecError>
    readonly outputs: Stream.Stream<AgentOutputEvent, AgentCodecError>
  }
>() {}
```

Concrete codecs expose scoped `Layer` constructors, such as
`StdioJsonlSessionLive(bytes)` and `AcpSessionLive(bytes, options)`. Protocol
selection remains direct from the durable runtime context. There is no codec
registry until dynamic codec discovery is required.

`toolUseMode` is a per-session capability:

- `observation_only`: tool-shaped output is telemetry and must not be claimed
  by the runtime tool router.
- `client_result_roundtrip`: runtime subscribers may claim `ToolUse` rows and
  append `ToolResult` ingress.
- `control_channel_request_response`: protocol-owned live request/response
  paths handle the interaction.

ACP currently reports tool calls as observation-only and handles permission
requests through its live control-channel continuation. Stdio JSONL is the
client-result round-trip path.

## Effect-Native Capability Rules

Runtime capabilities should be ordinary Effect values carried by
`Context.Tag` and provided by `Layer`:

| Need | Preferred shape |
| --- | --- |
| Append-only write | `Queue.Enqueue<Row>` or a narrow service with `append(row)` when the row must be returned. |
| Stream-terminal write | `Sink.Sink<void, Row, never, E, R>`. |
| Observation/read stream | `Stream.Stream<Row, E, R>`. |
| Lookup or command | A narrow object service whose methods return `Effect`. |
| Long-lived driver with no callable service | `Layer.scopedDiscard(...)` or `Layer.Layer<never, E, R>`. |

Do not add custom runtime frameworks over `Stream`, `Sink`, `Effect`, `Layer`,
or `Context.Tag`. Do not expose generic DurableTable CRUD facades to
subscribers, transforms, or app code. Provider layers may touch table facades
internally, but production consumers should request only the smallest
capability they need.

## Durable Authorities

Runtime-owned durable writes are grouped by authority provider:

| Durable family | Authority/provider |
| --- | --- |
| Runtime output events and logs | `RuntimeAgentOutputEventsLayer` and read-side output tags in `tables/runtime-output.ts`. |
| Runtime contexts and run events | `RuntimeControlPlaneRecorderLive` in `src/authorities/`. |

Authority modules expose concrete write capabilities and concrete read
observation surfaces. The read side is a typed `Stream` capability tag.

## Static And Dynamic Reads

Static runtime subscribers consume read streams through the Effect requirement
channel. For example, tool routing consumes runtime agent-output observations
and an ingress append capability; it does not receive a runtime output table
facade.

`WaitForWorkflow` accepts a typed `RuntimeObservationSource` discriminator
(`AgentOutput` | `AgentOutputAfter` | `RuntimeRun` | `CallerFact`). The
workflow body resolves it through runtime observation streams:

```txt
typed authority stream tags (RuntimeAgentOutputEvents, RuntimeRuns, CallerOwnedFactStreams)
  -> RuntimeObservationStreamsLive (Effect requirement channel)
  -> WaitForWorkflow selects the concrete stream
```

Adding a runtime wait source is one `RuntimeObservationSource` variant, one
`RuntimeObservationStreams` field, and one workflow `switch` arm.

## Host Composition

`src/host/` is the runtime topology boundary. It owns:

- `FiregridRuntimeHostLive` and `FiregridLocalHostLive`;
- config-derived host layers such as `FiregridRuntimeHostFromConfig`;
- host session and host-owned stream URL wiring;
- `startRuntime`, `appendRuntimeIngress`, and start capability services;
- local-process env resolver policy and host app source registration;
- host-coupled tool services.

Host layers compose runtime authorities, observation streams,
workflow engine, sandbox provider, runtime config, and current host session.
Command handlers call narrow capabilities supplied by the layer; they should
not construct runtime tables per operation.

## Tools And Adapters

`src/agent-tools/` owns runtime tool definitions and host-side tool execution.
It imports shared protocol schemas, exposes Effect AI tools/toolkits, projects
them to MCP when needed, and lowers codec `ToolUse` events to effects. It is a
tool boundary, not an agent event-pipeline subscriber.

`src/producers/codecs/agent-adapters/` owns projections over codec sessions,
such as language model adapter surfaces and ACP mapping. Adapters do not own
durable runtime rows or pipeline lifecycle. (Re-homed under
`producers/codecs/` per the runtime physical target tree — the contract is
Shape A codec-bound; legacy public subpath `@firegrid/runtime/agent-adapters`
is preserved.)

## Verified Webhook Ingest

`src/verified-webhook-ingest/` is an adjacent external ingress/source adapter.
It owns verified webhook fact schemas, key encoding, table declaration, and an
ingest adapter. It can be observed by durable waits through normal source
stream patterns, but it is not part of the agent event pipeline.

## App Consumer Patterns

Factory currently composes a runtime host and a client in its app-local host
module. Its stable imports should stay on public/current surfaces:

- `@firegrid/client/firegrid` for app-facing sessions and observations;
- `@firegrid/runtime/runtime-host` for host composition, start capability,
  env policy, local-process env mapping, and app source registration;
- `@firegrid/protocol/*` for shared row schemas and launch/session vocabulary;
- app-local tables, identity, prompts, and UI vocabulary in `apps/factory`.

Factory-specific identity, dark-factory tables, planner prompts, product facts,
and UI semantics should not move into `@firegrid/runtime` or
`@firegrid/client`.

Flamecast keeps a single host-entrypoint runtime import pattern:
`@firegrid/runtime/runtime-host` for `FiregridLocalHostLive`, `startRuntime`,
and local-process env mapping. Its app flow uses `@firegrid/client` for
launching, prompting, watching, and snapshots.

## Adding Runtime Code

Before adding a new runtime module:

1. Classify the role: pipeline source, codec, event contract, transform,
   authority, subscriber, source registration, host composition, wait operator,
   workflow adapter, tool, adapter, or adjacent ingest.
2. Prefer the existing public subpath or internal bounded context for that
   role. Do not create a convenience folder that hides architecture.
3. Model dependencies as Effect requirements and layers. Keep row providers and
   table facades inside authority/provider internals.
4. Use typed `Stream` capabilities for static subscribers and for `wait_for`
   source selection (typed `RuntimeWaitSource` over `RuntimeWaitStreams`).
   There is no source-name registry.
5. Keep product semantics in apps or protocol schemas. Runtime owns host and
   durable execution semantics, not planner prompts or application facts.
