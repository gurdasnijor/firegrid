# Managed Agent Control Surface Inventory

Status: draft architecture inventory

Date: 2026-05-11

Related artifacts:

- Anthropic Engineering, [Scaling Managed Agents: Decoupling the brain from
  the hands](https://www.anthropic.com/engineering/managed-agents)
- `docs/architecture/managed-agent-runtime-target-durable-facts.md`
- `docs/research/durable-execution-api-design-survey.md`
- `docs/SDD_FIREGRID_CLIENT_API.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/concepts/managed-agent-primitives.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/internals/session-prompt-adapters.md`
- `docs/tracers/006-runtime-host-root-and-launch-boundary.md`
- `docs/tracers/010-workflow-backed-tools.md`
- `docs/tracers/012-agent-ingress-prompt-stream.md`
- `docs/tracers/013-reactive-workflow-operators.md`
- `features/firegrid/firegrid-client-api.feature.yaml`
- `features/firegrid/firegrid-agent-ingress.feature.yaml`
- `features/firegrid/firegrid-platform-invariants.feature.yaml`
- `features/firegrid/firegrid-scheduling-tool-bindings.feature.yaml`
- `features/firegrid/durable-waits-and-scheduling.feature.yaml`

## Purpose

Firegrid's high-level architecture has been hard to reason about partly because
the actual user and runtime control surface is still implicit. This document
catalogues the operations the system should eventually support and assigns
each operation to an authority boundary.

The core rule is:

```txt
external caller or runtime capability
  -> append durable intent/fact through an authorized surface
  -> host-owned operator, adapter, or workflow reacts
  -> durable output/projection exposes the result
```

External clients, agents, and tools do not launch durable workflows directly.
They append facts or call capability APIs that lower to facts. Runtime-host
operators and adapters own workflow execution, durable waits, provider delivery,
and materialization. This is the control-surface form of
`firegrid-platform-invariants.AUTHORITY.8`.

## Operation Planes

Firegrid should not have one giant API. It should have a small number of
operation planes, each with a clear authority boundary.

These planes are not necessarily package directories. They are a way to answer
"who is allowed to do what?" before choosing module layout.

```txt
Host Plane
  chooses topology, adapters, materialization, dispatchers, workflow substrate
  starts dispatchers/subscribers that react to durable streams

Session Plane
  records user/agent/runtime interaction facts
  carries session lifecycle, prompt/turn, agent update, tool result, and
  terminal facts

Coordination Plane
  records durable waits, timers, predicates, decisions, and operator progress
  reacts to host/session facts and emits follow-up facts through existing
  authority surfaces
```

The planes intentionally overlap at runtime through durable facts. The boundary
is authority, not physical isolation.

### Host Plane

Audience: deployable runtime process, scenario host, future service runtime.

Responsibilities:

- choose stream topology;
- choose workflow engine implementation;
- choose materialization strategy;
- choose provider adapters;
- choose runtime dispatchers/subscribers;
- choose coordination predicates only as part of configured coordination
  capabilities, not as a standalone top-level host API;
- start runtime work from durable context facts;
- supervise long-running dispatchers/subscribers that react to durable facts,
  time, or projections.

Current ground truth:

- `FiregridRuntimeHostLive` owns workflow, control-plane, runtime-output, and
  optional session-input streams.
- `startRuntime({ contextId })` runs through the host-owned workflow/control
  and provider composition.
- `appendSessionInput(request)` appends host-owned session input facts.

Likely eventual host capabilities:

| Host Capability | Purpose | Public To Client? |
| --- | --- | --- |
| `startRuntime` | Start or resume execution for a runtime context. | No. |
| `appendSessionInput` | Append provider-neutral runtime input facts. | Package/app boundary only. |
| `startDispatchers` | Start long-running subscribers that route durable facts to workflows, adapters, materializers, or follow-up facts. | No. |
| `startMaterializers` | Start configured projection/materialization workers. | No. |
| `configureAdapters` | Install runtime/provider adapters such as local process, stdio, ACP, HTTP, or vendor-specific adapters. | No. |
| `configureCoordination` | Install coordination capabilities such as wait predicates, timer handling, and decision routing. | No. |

The host plane is a composition and authority plane, not a product client API.
It is where runtime choices are made once for a configured runtime instance.
Dispatcher startup is process lifecycle, not a top-level user control event.
Once running, dispatchers react to streams; callers do not invoke individual
operators by RPC.

The host plane should avoid exposing implementation nouns such as "matcher" as
top-level surface area. Predicate evaluation is real, but it belongs inside
coordination capability configuration, where a durable wait says "which
predicate family and parameters" and a dispatcher knows how to evaluate it.

### Session Plane

Audience: browser code, app servers, scenario clients, product integrations,
provider adapters, materializers.

The session plane should align with the managed-agent Session primitive:
durable identity plus append-only event log. In Anthropic's managed-agent
framing, the session is recoverable context storage outside the harness; the
harness can replay or slice events and decide how to feed them back to the
model. The local RFC mirrors this with `getSession`, `getEvents`, and
`emitEvent` semantics. Firegrid should not copy that interface literally into
the control surface: `getEvents(cursor)` is an observation/read primitive, not a
session control operation.

Responsibilities:

- record durable session lifecycle facts;
- record user/workflow-authored input requests;
- record runtime-authored agent/provider updates and terminal prompt facts;
- never pass runtime topology, workflow engine selection, provider registries,
  coordination predicate code, or dispatcher graphs.

Current ground truth:

- `@firegrid/client` exposes `launch(request)` and `open(contextId)`.
- Session input rows support `message`, `control`, `tool_result`, and
  `required_action_result` inputs.
- Runtime output rows are durable facts consumed by materialization strategies.

Likely eventual session control operations:

| Operation | Caller Intent | Durable Fact Family | Actor That Reacts |
| --- | --- | --- | --- |
| `request_session` / `launch` | Create or request one managed agent session/runtime context. | Session lifecycle or runtime context request fact. | Host launch/session operator. |
| `send_input` / `prompt` | Send user, workflow, or system-authored input to the session. | Session input or prompt request fact. | Prompt/session adapter operator. |

Runtime-authored session facts are not user control operations:

| Fact Class | Writer | Purpose |
| --- | --- | --- |
| Session ready/not-live/closed/failed | Host or adapter | Expose durable lifecycle and promptability state. |
| Prompt/turn started | Prompt/session adapter operator | Mark the winning prompt work as active. |
| Agent update/chunk | Adapter | Record ordered model/provider output. |
| Tool call/update/result observed by the agent protocol | Adapter or harness | Preserve transcript-visible tool progress. |
| Prompt/turn terminal | Adapter/operator | Record completion, failure, cancellation, or stop reason. |

Open design question:

- Should browser-safe client prompt/decision APIs append directly to durable
  streams using configured public stream endpoints, or should a runtime-host
  HTTP/app boundary append those facts? The invariant is the same either way:
  clients append intent; they do not call workflow handles.

Historical term cleanup:

- `open` / `observe` are SDK convenience verbs for attaching to read models.
  They are not session-plane control operations.
- `get_events(cursor)` is useful managed-agent substrate vocabulary, but in
  Firegrid it belongs to observation/replay APIs and materializer inputs, not
  the session control plane.
- `deliver` is adapter/operator progress, not a user-level session operation.
  It should become implementation vocabulary such as "dispatch prompt to live
  adapter" or "record adapter delivery progress", not a first-class client or
  session-plane verb.
- `firegrid.session.input` is the current implementation row family.
  Historical `runtime_ingress` names are not public architectural concepts.
- Tracer 019 deleted `runtime_ingress` physical vocabulary while
  exposing the session-plane control concept as prompt/session input facts.
  Client and runtime host append surfaces share the same durable row schema;
  host-owned runtime code performs delivery.
- Cancellation, interruption, and close semantics are deliberately not listed
  as session control operations yet. They require provider-specific
  promptability, terminal-state, and recovery semantics before becoming stable
  Firegrid operations.

### Coordination Plane

Audience: workflow handlers, runtime tools, managed-agent runtime code, runtime
operators.

Responsibilities:

- express durable waits, time, predicates, decisions, and retries;
- lower workflow/tool capabilities to durable facts and host-owned operators;
- react to session-plane facts and projections;
- emit follow-up facts back through session or host authority surfaces;
- never introduce a workflow-specific endpoint or separate private data plane.

The name "coordination" is meant to distinguish this from the host plane. The
host plane owns process configuration and authority. The coordination plane
owns durable control flow within and between agent runtimes.

Target capability verbs:

| Capability | Meaning | Durable Lowering |
| --- | --- | --- |
| `sleep(duration)` | Suspend until durable time reaches a deadline. | Durable timer/wait descriptor plus workflow resume. |
| `wait_for(trigger, timeout?)` | Suspend until a named event/projection predicate resolves. | Durable wait descriptor, snapshot-first projection check, live follow after cursor, optional timeout. |
| `schedule_me(when, prompt)` | Queue a future self-prompt. | Durable timer intent; timer operator appends `firegrid.session.input` when due. |
| `spawn(agent, prompt)` | Start a child runtime and wait for terminal state. | Launch intent/control facts plus child session input; projection/operator resolves parent wait. |
| `spawn_all(tasks)` | Fan out child runtimes and wait for all terminal states. | N child intents or one expansion intent plus aggregate projection. |
| `execute(target, input)` | Call a named tool/sandbox/provider target. | Claim-visible work first, execute adapter, append durable result/failure facts. |
| `request_decision` | Ask for external approval or input. | Required-action/request facts plus named wait for a durable decision. |

These are runtime capability APIs, not public client workflow endpoints. Tool
bindings should use the same durable lowering as the equivalent runtime API,
per `firegrid-scheduling-tool-bindings.IDENTICAL_DURABLE_LOWERING.*`.

### Observation Surface

Observation is cross-plane rather than its own authority plane.

Audience: clients, apps, tests, dashboards, operators.

Responsibilities:

- provide read-only handles over durable state and projections;
- expose Effect for one-shot reads and Stream for live observation;
- avoid hidden authority, workflow handles, or raw completion mutation.

Likely observations:

| Query | Source |
| --- | --- |
| Runtime context snapshot | Runtime context/control state plus runtime output journal. |
| Session events after cursor | Durable session/runtime output facts. |
| Runtime output facts | Runtime output durable stream. |
| Session projection | Materialization strategy target. |
| Pending decisions | Required-action projection or fact fold. |
| Wait status | Wait descriptor/progress projection. |
| Operator progress | Operator progress stream/projection. |
| Child runtime tree | Runtime context/run projections keyed by parent. |

Observation APIs can be broad and ergonomic because they are read-only. The
authority boundary concern is mostly about write/control APIs.

## Operation Catalogue

The table below is intentionally broader than current implementation. It is a
working inventory for future tracer selection.

| Operation | Plane | Current Status | Next Design Pressure |
| --- | --- | --- | --- |
| Launch/request session | Session plus Host | Implemented as client launch plus runtime host start. | Align launch naming with session lifecycle and initial prompt lowering. |
| Start runtime worker | Host | Implemented as `startRuntime`. | Keep host-owned; do not expose workflow start endpoint. |
| Send input / prompt | Session | Runtime host session input exists; client API missing. | Rename toward prompt/turn semantics and decide client vs host append boundary. |
| Dispatch prompt to adapter | Host plus Session | Implemented for one provider path. | Treat as adapter/operator progress, not session-plane public API. |
| Record session update/output | Session | Implemented with stream-native runtime output rows. | Align runtime-output rows with session update/prompt terminal vocabulary. |
| Materialize session | Session observation | Implemented for raw-fold, State Protocol, Materialize. | Align strategy selection with host configuration. |
| Required decision | Coordination plus Session | Partially implemented; topology intentionally blocked. | Recast as generic wait/decision over operator substrate. |
| Resolve decision | Session or Coordination input | Required-action-specific path exists. | Should append decision fact, not wake workflow directly. |
| Sleep | Coordination | Planned. | Use workflow durable clock/timer operator, no bespoke plane. |
| Wait for event/projection | Coordination | Planned. | Define named wait descriptor and coordination predicate model. |
| Schedule self prompt | Coordination to Session | Planned. | Timer operator appends session input. |
| Spawn child runtime | Coordination to Session/Host | Planned. | Reuse launch + session input + projection wait. |
| Execute tool/sandbox | Coordination plus Host provider | Sandbox provider exists; tool execution model planned. | Claim-before-side-effect and durable result facts. |
| Cancel/interrupt/pause | Undecided | Not designed. | Needs provider-specific promptability, terminal-state, and recovery semantics before placement. |
| Replay/reprocess | Host admin | Not designed. | Needs operator progress/cursor model. |

## Architectural Implications

1. The control surface is fact-oriented, not workflow-oriented.
   Public APIs should append intent facts or observe projections. Workflow
   execution remains downstream host authority.

2. Runtime host configuration is not launch request data.
   Launch and prompt requests describe one desired runtime interaction. Stream
   topology, materialization strategy, provider registry, coordination
   predicates, and dispatchers are configured on the runtime host.

3. Capabilities are higher-level than durable streams.
   `sleep`, `wait_for`, `spawn`, and `schedule_me` should be ergonomic runtime
   capability APIs, but their implementations should lower to durable facts,
   durable time, and operators using `effect-durable-streams`.

4. Required actions should not be the pattern.
   Required actions are one consumer of the generic decision/wait/operator
   model. They should not define host topology, a standalone plane, or a
   special workflow launch path.

5. Materialization is read/query infrastructure, not control authority.
   Materialized views can drive wait predicates and observation, but they
   should not become write authority for client or workflow commands.

## Candidate Next Tracers

The next tracers should be chosen to clarify this control surface rather than
add isolated feature modules.

### A. Client Prompt Control Surface

Prove:

```txt
client/app prompt call
  -> durable session input fact
  -> provider adapter consumes
  -> runtime-output fact proves delivery/effect
```

Design questions:

- Is the first public prompt surface in `@firegrid/client`, `@firegrid/runtime`,
  or an app/server facade over runtime host?
- How does initial launch input lower to the same session input path?
- Which idempotency key rules belong to the client contract?

### B. Generic Wait Descriptor And Matcher Registry

Prove:

```txt
workflow capability wait_for(...)
  -> durable named wait descriptor
  -> operator evaluates snapshot-first and then live stream
  -> workflow resumes through @effect/workflow primitive
```

Design questions:

- What is the minimal serializable wait descriptor?
- How does the host configure supported coordination predicates without making
  predicate code part of client or launch data?
- How are cursors stored so retained snapshot and live follow have no gap?

### C. Required Action As A Consumer Of Generic Waits

Prove:

```txt
required-action request
  -> durable decision/wait facts
  -> external decision fact
  -> generic operator resumes workflow
```

Design questions:

- Which required-action-specific rows remain after generic wait/decision rows
  exist?
- What does the public decision API look like if it only appends facts?

### D. Schedule Me Over Timer Plus Session Input

Prove:

```txt
schedule_me(when, prompt)
  -> durable timer intent
  -> timer operator fires
  -> firegrid.session.input is appended
  -> provider output proves prompt delivery
```

Design questions:

- Does timer progress share the generic operator progress stream?
- How are live promptability checks represented?

### E. Spawn As Launch Plus Wait

Prove:

```txt
spawn(agent, prompt)
  -> child runtime launch intent
  -> child prompt session input
  -> projection observes child terminal state
  -> parent wait resolves
```

Design questions:

- How are parent/child context relationships represented?
- Does spawn use the same public launch normalization as clients?

## Current Gaps To Track

- `@firegrid/client` has no prompt/session input API.
- Current session input append lives on `FiregridRuntimeHost`; that is useful
  for package-level proof but not yet a complete external control surface.
- Required-action work is still not fully aligned with the generic operator
  model and should stay blocked from becoming the pattern.
- The generic wait descriptor, coordination predicate model, dispatcher
  progress, and projection predicate model are not yet implemented.
- Cancellation, interruption, reattach, replay, and host-admin controls are not
  designed.
