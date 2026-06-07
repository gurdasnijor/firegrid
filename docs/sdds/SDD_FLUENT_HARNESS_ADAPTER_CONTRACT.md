# SDD_FLUENT_HARNESS_ADAPTER_CONTRACT

Doc-Class: internal-contract
Status: active
Date: 2026-06-05
Owner: Firegrid Architecture

## Purpose

This SDD locks the fluent harness adapter boundary so adapter work can proceed
without rebuilding `packages/runtime`, Durable Streams, or a model-loop runtime
under a new name.

The load-bearing rule is:

> Firegrid owns durable coordination around the agent loop. The external
> harness owns the agent loop.

Firegrid has two ACP roles, and they must stay explicit:

- When Firegrid launches a downstream ACP harness, Firegrid is the ACP client.
  The external process owner supplies a process-backed ACP stream; Firegrid
  supplies the `acp.Client` implementation and wires that client to
  `packages/fluent-runtime`.
- When Zed or another editor launches Firegrid as an external ACP agent,
  Firegrid is an ACP conductor: it presents as an `acp.Agent` to the editor,
  owns the bridge to fluent-runtime, and may delegate to downstream ACP
  components through the separate Firegrid ACP client path.

Do not export a broad `Client | Agent` union. Export role-specific boundaries.
Non-ACP harnesses may still need a native lowering adapter, but ACP is the
narrow first-class path.

This document refines, but does not replace,
`docs/cannon/architecture/fluent/architecture.md`.

## Actors And Ownership

| Actor | Owns | Must not own |
|---|---|---|
| External harness | Native model loop, native tool protocol, native permission/cancel/interrupt semantics | Durable Streams writes, Firegrid wait/timer/child semantics, session projection schemas |
| Zed / editor ACP client | ACP client role over stdio when Firegrid is launched as an external agent | Firegrid session authority, Durable Streams writes, Firegrid coordination semantics |
| Firegrid ACP conductor | ACP `Agent` role facing Zed/editor clients, stdio protocol discipline, ordered routing, fluent-runtime session binding, optional downstream delegation | Zed/editor UI policy, Durable Streams substrate mechanics, downstream process internals |
| ACP process owner / bridge | Spawn/stop/restart the ACP process, expose its ACP stream, perform ACP initialize/session lifecycle calls requested by Firegrid | Firegrid coordination decisions, Layer 1 persistence, wait predicate evaluation, timer scheduling, child-session lifecycle, Durable Streams consumer mechanics |
| Firegrid ACP client | ACP `Client` callbacks, Layer 1 observation, permission/cancel/interrupt fidelity, filesystem/terminal policy, extension-method dispatch into Firegrid services | ACP process spawning, native model loop, Durable Streams substrate mechanics |
| `packages/fluent-runtime` | Layer 2 coordination facts, durable tool semantics, CEL wait matching, post-wake redrive, committed tool outcomes, MCP/tool dispatch semantics, Firegrid ACP client construction | Native model loop, native process internals, Durable Streams lease/cursor/retry/webhook mechanics |
| Durable Streams | Streams, offsets, close/fork, producer fencing, named consumer cursors, claim/ack/release, webhook wake delivery | Firegrid product facts, CEL meaning, harness protocol translation |
| Projections / UI / firelab | Queryable read models and acceptance observations derived from the stream | Authoritative session state, raw history mutation, ACP process ownership |

The raw external harness writes no Durable Streams records. For ACP harnesses,
the process owner should not append records either; it hands Firegrid an ACP
stream and Firegrid's ACP client records Layer 1 facts.

## Event Layers

The session stream carries two product layers over the same Durable Streams log.

Layer 1 is harness observation. For ACP harnesses, it is written by Firegrid's
ACP client from ACP callbacks and preserves what the harness did or asked for:

- user intents forwarded to the harness;
- raw agent output;
- native tool calls;
- native permission requests;
- native turn-complete events;
- native lifecycle events such as started, resumed, ended, or failed.

Layer 2 is Firegrid coordination. It is written by `packages/fluent-runtime`
after a Firegrid-owned decision has been durably made:

- accepted durable tool outcome;
- `WaitIntent` and `wait_matched`;
- `TimerScheduled` and `TimerFired`;
- child/fork lifecycle facts;
- committed execute/activity result;
- terminal, continuation, cancellation, or interruption outcome.

Layer 1 is observation. Layer 2 is host commitment. A Firegrid durable tool call
crosses the boundary as:

```text
harness native tool_call or ACP client callback
  -> Firegrid ACP client appends Layer 1 observation
  -> fluent-runtime evaluates Firegrid semantics
  -> fluent-runtime appends Layer 2 committed outcome
  -> Firegrid returns the committed outcome through the ACP/native result path
```

For Zed/editor-facing flows, Firegrid receives ACP `Agent` calls and emits ACP
`Client` callbacks:

```text
Zed ACP client
  -> FiregridAcpConductor implements ACP Agent
  -> fluent-runtime records accepted user/control intent and L1/L2 facts
  -> optional downstream FiregridAcpClient delegates to a spawned ACP agent
  -> FiregridAcpConductor sends session/update and permission responses to Zed
```

## Schema Ownership

The ACP adapter work must not collapse protocol schemas, durable session facts,
and UI/query projections into one package.

| Schema family | Owner | Notes |
|---|---|---|
| ACP protocol schema | ACP SDK | Firegrid implements ACP `Client`; it does not fork ACP request/notification shapes. |
| Layer 1 observation fact schema | `packages/fluent-runtime` | The stream truth for recorded harness observations. It can include raw ACP payloads plus Firegrid envelope metadata. |
| Layer 2 coordination fact schema | `packages/fluent-runtime` | Wait intents, timer facts, child facts, committed tool outcomes, cancellation/terminal facts. |
| Agent DB / queryable row schema | Projection/read-model layer | Derived view over Layer 1 and Layer 2 facts. It is not the durable source of truth and not adapter-core authority. |

`/Users/gnijor/gurdasnijor/coding-agents/src/agent-db-schema.ts` is in the last
category. It is useful prior art for queryable collections such as sessions,
messages, turns, tool calls, permission requests, approvals, and debug events.
If imported into Firegrid, it should land as projection/read-model work, for
example `packages/fluent-runtime/src/projections/*` while small, or a sibling
package such as `packages/fluent-agent-projections` once it grows.

It must not live in the ACP process owner package. The process owner should not
own Firegrid's queryable state model just because it spawns the ACP process.

## ACP Client Contract

For ACP harnesses, Firegrid exports the boundary the process owner builds
against. Source check: `agentclientprotocol/typescript-sdk/src/acp.ts`
defines `export interface Client` at line 1725. Firegrid implements that ACP
`Client` interface rather than asking the ACP process package to implement a
Firegrid-shaped adapter.

```ts
export class FiregridAcpClient implements acp.Client {
  // Implements the full ACP Client interface from the SDK:
  // requestPermission, sessionUpdate, optional filesystem methods,
  // optional terminal methods, unstable elicitation hooks when enabled,
  // and extension methods/notifications.
}

export function connectFiregridAcp(input: {
  readonly sessionId: SessionId
  readonly stream: acp.Stream
  readonly runtime: FluentRuntimeServices
}): Effect.Effect<FiregridAcpConnection, FiregridAcpError>

export interface FiregridAcpConnection {
  readonly agent: acp.Agent
  readonly client: FiregridAcpClient
  readonly close: Effect.Effect<void>
}
```

`connectFiregridAcp` owns the ACP `ClientSideConnection` wiring. The process
owner must not reimplement Firegrid's ACP client callbacks or import
`packages/fluent-runtime` internals.

The ACP process owner implements only the outside of that boundary:

```ts
interface AcpHarnessProcessOwner {
  spawn(input: AcpSpawnInput): Effect.Effect<{
    readonly stream: acp.Stream
    readonly kill: Effect.Effect<void>
  }, AcpProcessError>
}
```

The Firegrid ACP client may normalize native events enough to append Layer 1
facts, but durable queryable projections are a separate read-model concern. A
codec or projection change must not require rewriting raw Layer 1 history.

## ACP Conductor Contract

For Zed and other editor-launched ACP flows, Firegrid exports a conductor
boundary. Source checks:

- `agentclientprotocol/typescript-sdk/src/acp.ts` defines `export interface
  Agent` at line 1904. Firegrid implements this interface for editor-facing ACP
  stdio.
- `/Users/gnijor/gurdasnijor/firepixel/packages/conductor/src/conductor.ts`
  is useful prior art: `ConductorImpl` implements the ACP SDK `Agent`, attaches
  an outer `AgentSideConnection`, and uses `ClientSideConnection` to route to
  downstream components.
- ACP Rust conductor docs describe the same role: the conductor presents as a
  normal ACP agent to the editor and routes all messages through a central loop.

```ts
export class FiregridAcpConductor implements acp.Agent {
  // Implements the full ACP Agent interface from the SDK:
  // initialize, newSession, prompt, cancel, session lifecycle methods,
  // optional fork/list/resume/delete/close/config methods, and extension hooks.
}

export function connectFiregridAcpConductorStdio(input: {
  readonly runtime: FluentRuntimeServices
  readonly stdio: AcpStdioTransport
  readonly downstream?: FiregridAcpClientConnection
}): Effect.Effect<FiregridAcpConductorConnection, FiregridAcpError>

export interface FiregridAcpConductorConnection {
  readonly agent: FiregridAcpConductor
  readonly close: Effect.Effect<void>
}
```

`FiregridAcpConductor` owns stdio protocol discipline for the Zed path. Stdout
is ACP-only after ACP stdio mode starts. Logs, ready records, stream URLs, and
human diagnostics must not be written to ACP stdout.

The conductor may route to downstream ACP agents, but that delegation uses
`FiregridAcpClient`; it is not a union type. The conductor is the composition
point that can hold both roles internally while keeping public exports
role-specific.

## Required Flows

### Start Or Resume

1. Durable Streams delivers or grants a wake.
2. `packages/fluent-runtime` reads the provided offsets and materializes the
   session stream.
3. `packages/fluent-runtime` prepares the native resume context needed for the
   ACP session lifecycle.
4. The process owner starts or resumes the real ACP harness and returns an ACP
   stream.
5. `packages/fluent-runtime` connects `FiregridAcpClient` to that stream and
   drives ACP initialize/session/prompt/control calls through the returned
   `acp.Agent`.

No hidden Firegrid model loop is started.

### Zed ACP Stdio

When Zed launches Firegrid as an external ACP agent:

1. Zed is the ACP client and owns the editor UI.
2. Firegrid starts in ACP stdio mode and presents `FiregridAcpConductor` as the
   ACP agent.
3. ACP stdout carries only ACP protocol frames.
4. Firegrid binds ACP session calls to fluent-runtime session authority.
5. `session/prompt` appends accepted user intent and drives the fluent host.
6. `session/cancel` records durable cancellation or continuation evidence.
7. If Firegrid delegates to a downstream ACP agent, that downstream path goes
   through `FiregridAcpClient`.

### Observation

The Firegrid ACP client records Layer 1 observations before projections or
Layer 2 outcomes depend on them. It must preserve ACP permission, cancel,
interrupt, extension, and tool request shape enough for replay, projection, and
human review.

### Firegrid Durable Tool Call

When the harness invokes a Firegrid durable tool:

1. `FiregridAcpClient` records the ACP/native tool request as Layer 1.
2. `FiregridAcpClient` invokes the fluent-runtime tool binding.
3. The runtime appends the Layer 2 committed outcome.
4. Firegrid returns the committed result through the ACP/native result path.

The ACP process owner does not evaluate CEL, decide timeout races, schedule
timers, fork children, or execute sandbox activities on its own.

### Parking Tool

For `wait_for`, durable sleep, child wait, or any other parking tool:

1. The ACP/native tool call is recorded as Layer 1.
2. The runtime appends the Layer 2 intent before parking.
3. Firegrid returns the harness-specific end-of-turn or pending response through
   the ACP/native boundary.
4. The process owner does not keep a hidden in-process model loop alive.
5. A later Durable Streams wake causes `packages/fluent-runtime` to redrive the
   session and return the recorded committed outcome through the native path.

### Resume Without Duplicate Effects

After restart, already-observed Layer 1 side effects must not execute again.
This covers both:

- Firegrid-mediated durable tool calls, which are paired with recorded Layer 2
  results; and
- harness-native side effects such as shell, file edits, tests, or provider
  calls, which require native resume or explicit replay suppression by the
  Firegrid ACP client or native lowering adapter.

This is the hardest adapter proof. Prompt replay into a fresh process is not a
native resume proof unless it also proves observed side effects are suppressed.

### Cancel And Interrupt

Cancel during a parked wait and interrupt during an active turn are separate
paths. Both must leave durable evidence before teardown and must not duplicate
observed side effects on redrive.

The Firegrid ACP client preserves the ACP protocol shape.
`packages/fluent-runtime` records the Firegrid coordination outcome.

## MCP And Tool Binding

The MCP/tool edge is a thin schema, auth, and dispatch surface. It exposes
Firegrid durable tools to a harness, but it does not own their semantics.

```text
harness tool call
  -> Firegrid ACP client records Layer 1
  -> MCP/tool edge decodes and authorizes
  -> fluent-runtime service appends Layer 2 outcome
  -> Firegrid returns native tool result
```

Tool binding may use Effect `Tool`, `Toolkit`, or `McpServer` shapes, but those
are edge shapes. Durable semantics remain in `packages/fluent-runtime`; native
protocol fidelity remains in Firegrid's ACP client or the native lowering
adapter for non-ACP harnesses.

## Safety Invariants

| ID | Invariant |
|---|---|
| F-A1 | The raw harness writes no Durable Streams records directly. |
| F-A2 | Firegrid's ACP client records Layer 1 observation before any Layer 2 committed outcome depends on it. |
| F-A3 | `packages/fluent-runtime` records Layer 2 committed outcomes before Firegrid returns them to the harness. |
| F-A4 | The ACP process owner never evaluates wait predicates, decides timer/timeout races, forks child sessions, or owns execute/activity semantics. |
| F-A5 | Parking tools append durable intent before returning a native end-of-turn or pending response. |
| F-A6 | Resume must not duplicate any already-observed Layer 1 side effect. |
| F-A7 | Native turn completion controls prompt sequencing. |
| F-A8 | Cancel and interrupt preserve native protocol fidelity and durable Firegrid evidence. |
| F-A9 | Raw observations are durable enough to re-project without rewriting history. |
| F-A10 | Fake adapters are unit-test aids only; they are not end-to-end acceptance proof. |
| F-A11 | ACP harness packages import the Firegrid ACP subpath only; they do not import fluent-runtime Store, Host, EventIngress, or Sources internals. |
| F-A12 | Agent DB/queryable row schemas are projection-owned; ACP process packages must not own or export them as adapter-core state. |
| F-A13 | Zed/editor-facing ACP exports use `FiregridAcpConductor implements acp.Agent`; downstream harness exports use `FiregridAcpClient implements acp.Client`; no public `Client | Agent` union is the primary boundary. |
| F-A14 | ACP stdio mode writes only ACP protocol frames to stdout. |

## Acceptance Specs

The binding acceptance surface is in:

- `features/fluent/agent-binding/fluent-harness-adapter-boundary.feature`
- `features/fluent/agent-binding/fluent-firegrid-acp-client.feature`
- `features/fluent/agent-binding/fluent-firegrid-acp-conductor.feature`
- `features/fluent/agent-binding/fluent-agent-adapter-contract.feature`
- `features/fluent/agent-binding/fluent-native-resume.feature`
- `features/fluent/agent-binding/fluent-park-interface.feature`
- `features/fluent/agent-binding/fluent-mcp-tools-out.feature`

Those specs are intentionally product-observable. Passing evidence is stream
contents, native process behavior, committed Layer 2 outcomes, resumed output,
and no duplicate side effect. OTel spans may diagnose failures but are not the
verdict surface.

## Build Order

1. Export `FiregridAcpClient` and `connectFiregridAcp` from a narrow
   fluent-runtime ACP subpath.
2. Real ACP harness spawn through a process owner and Layer 1 observation
   through `FiregridAcpClient`.
3. Export `FiregridAcpConductor` and `connectFiregridAcpConductorStdio` for
   Zed/editor ACP stdio mode.
4. One non-parking Firegrid tool call round trip: Layer 1 call, Layer 2 committed
   result, native tool-result response.
5. Parking tool boundary after durable wait/sleep exists.
6. Native resume proof with no duplicate observed Layer 1 side effect.
7. Cancel/interrupt proof across parked and active turns.

## Non-Goals

- Do not rebuild Durable Streams claim, lease, cursor, retry, webhook wake, or
  signing-key discovery mechanics in the adapter.
- Do not import or design against legacy `packages/runtime/src/sources` as the
  architecture model. Mine it only for integration edge cases.
- Do not make the adapter a projection authority.
- Do not make MCP the runtime. MCP/tool binding is an edge.
- Do not accept a fake harness as proof of non-invasive binding.
- Do not make ACP harness packages depend on broad fluent-runtime internals.
- Do not export a public `acp.Client | acp.Agent` union as the main ACP boundary.
