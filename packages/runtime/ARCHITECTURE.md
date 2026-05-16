# `@firegrid/runtime` Architecture

Status: operational guide for the post Runtime Boundary Reconciliation layout.
The SDDs remain decision records; this file describes how the current runtime
package is organized and how new code should fit it.

## Package Role

`@firegrid/runtime` is the host-side runtime package. It owns runtime host
composition, local agent process execution, codec sessions, durable runtime
output and ingress authorities, durable waits, workflow-engine integration,
runtime agent tools, runtime agent adapters, source registration, and adjacent
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
| `@firegrid/runtime/durable-tools` | Runtime durable coordination operators, currently `WaitFor.match`, source registration primitives, and wait row capabilities. |
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
| `src/agent-event-pipeline/` | Agent runtime event pipeline bounded context. |
| `src/agent-event-pipeline/sources/` | Live process, byte stream, sandbox, and raw stdin delivery edges. |
| `src/agent-event-pipeline/codecs/` | Protocol wire/session normalization into `AgentSession`. |
| `src/agent-event-pipeline/events/` | Normalized agent input/output events, envelope helpers, and stage contracts. |
| `src/agent-event-pipeline/transforms/` | Pure stream and row-shaping functions shared by pipeline components. |
| `src/agent-event-pipeline/authorities/` | Runtime output, ingress input, and ingress delivery durable capability providers. |
| `src/agent-event-pipeline/subscribers/` | Host-scoped drivers over durable observations, such as ingress delivery and tool routing. |
| `src/agent-event-pipeline/session-runtime.ts` | Per-session composition for source, codec session, subscribers, and output journal. |
| `src/authorities/` | Runtime control-plane authorities for contexts, runs, and runtime observation source names. |
| `src/source-registration/` | Dynamic `SourceCollectionHandle` registrations for wait-for source lookup. |
| `src/host/` | Runtime host topology, command entrypoints, config-derived layers, host-owned table wiring, and host-coupled tool services. |
| `src/waits/` | Durable `WaitFor.match` operator, wait row authority, source collection registry, and wait router. |
| `src/workflow-engine/` | Firegrid durable-table adapter for `@effect/workflow`. |
| `src/agent-tools/` | Runtime tool catalog, MCP host projection, scheduled input workflow, and tool lowering. |
| `src/agent-adapters/` | Runtime-facing agent adapter facades and ACP mapping. |
| `src/verified-webhook-ingest/` | Adjacent verified webhook fact ingest adapter. |

`agent-event-pipeline/` is the only folder that should grow stage-like runtime
event pipeline code. Host, waits, workflow engine, tools, adapters, source
registration, verified ingest, and control-plane authorities are adjacent
bounded contexts, not pipeline stages.

## Event Pipeline Shape

The runtime event pipeline is:

```txt
sources -> codecs -> events -> transforms -> authorities -> subscribers
                          \                         /
                           session-runtime
```

The arrows describe role ownership, not import permission. `session-runtime.ts`
selects the active protocol session layer, starts scoped subscribers, writes
normalized output through the output authority sink, and returns terminal
evidence. Growth in `session-runtime.ts` is a signal to move behavior into a
role-specific folder.

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
| Runtime output events and logs | `RuntimeOutputJournalLayer` in `agent-event-pipeline/authorities/runtime-output-journal.ts`. |
| Runtime ingress input rows | `RuntimeIngressAppenderLayer` and `RuntimeIngressAppendAndGet`. |
| Runtime ingress delivery claim/completion rows | `RuntimeIngressDeliveryTrackerLayer` and `RuntimeIngressDeliveryClaimAndComplete`. |
| Runtime contexts and run events | `RuntimeControlPlaneRecorderLive` in `src/authorities/`. |
| Durable wait rows and completions | `DurableWaitStoreLive` in `src/waits/`. |

Authority modules expose concrete write capabilities and concrete read
observation surfaces. The read side is usually a `Stream` capability tag. The
dynamic wait-for read side is a `SourceCollectionHandle` registered by
`src/source-registration/`.

## Static And Dynamic Reads

Static runtime subscribers consume read streams through the Effect requirement
channel. For example, tool routing consumes runtime agent-output observations
and an ingress append capability; it does not receive a runtime output table
facade.

Dynamic `WaitFor.match` lookup uses named `SourceCollectionHandle`
registrations:

```txt
authority/provider stream tag -> source-registration layer
  -> SourceCollections.register(sourceCollectionStreamHandle(name, stream))
  -> wait router awaits source by name
```

`src/source-registration/` owns runtime source-handle registration for current
runtime output, ingress, and control-plane observation streams. Host
composition supplies `RuntimeSourceRegistrationsLive`; it does not enumerate
every authority stream inline. App-owned wait sources use
`registerRuntimeHostAppSource` or `RuntimeHostAppSourceRegistrationsLive` from
`runtime-host`.

Use `SourceCollectionHandle` only for dynamic source-name lookup. It is not the
universal read abstraction for subscribers that can depend on a typed `Stream`
capability.

## Waits

`src/waits/` is a durable coordination operator boundary, not an agent event
pipeline subscriber folder.

The split is:

- `WaitFor.match` is the workflow-handler operator. It writes or updates a wait
  row, races workflow deferred completion with optional timeout, decodes the
  matched payload at the call site, and returns `Match | Timeout`.
- Durable wait row capability tags expose row lookup, row upsert, completion
  lookup, completion upsert, and row streams without encoding lifecycle policy
  into the provider.
- The wait router is a wait-owned scoped driver. It observes active waits,
  resolves registered source handles by name, evaluates triggers against source
  rows, writes completion rows, updates wait status, and resolves workflow
  deferreds.
- Host-owned durable tools are composed under `src/host/` so wait rows use the
  host's stream prefix.

`docs/sdds/SDD_FIREGRID_DURABLE_WAIT_EXTRACTION.md` is a staged roadmap for
possible extraction to `effect-durable-operators`. No wait code moves until a
second consumer or extraction trigger proves the generic boundary. Firegrid
runtime keeps source registration layers, runtime source names, tool bindings,
and host adapters that depend on Firegrid vocabulary.

## Host Composition

`src/host/` is the runtime topology boundary. It owns:

- `FiregridRuntimeHostLive` and `FiregridLocalHostLive`;
- config-derived host layers such as `FiregridRuntimeHostFromConfig`;
- host session and host-owned stream URL wiring;
- `startRuntime`, `appendRuntimeIngress`, and start capability services;
- local-process env resolver policy and host app source registration;
- host-coupled tool services.

Host layers compose runtime authorities, source registrations, durable waits,
workflow engine, sandbox provider, runtime config, and current host session.
Command handlers call narrow capabilities supplied by the layer; they should
not construct runtime tables per operation.

## Tools And Adapters

`src/agent-tools/` owns runtime tool definitions and host-side tool execution.
It imports shared protocol schemas, exposes Effect AI tools/toolkits, projects
them to MCP when needed, and lowers codec `ToolUse` events to effects. It is a
tool boundary, not an agent event-pipeline subscriber.

`src/agent-adapters/` owns projections over codec sessions, such as language
model adapter surfaces and ACP mapping. Adapters do not own durable runtime
rows or pipeline lifecycle.

## Verified Webhook Ingest

`src/verified-webhook-ingest/` is an adjacent external ingress/source adapter.
It owns verified webhook fact schemas, key encoding, table declaration, and an
ingest adapter. It can be observed by durable waits through normal source
registration patterns, but it is not part of the agent event pipeline.

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
4. Use typed `Stream` capabilities for static subscribers. Use
   `SourceCollectionHandle` only for dynamic wait source lookup.
5. Keep product semantics in apps or protocol schemas. Runtime owns host and
   durable execution semantics, not planner prompts or application facts.
