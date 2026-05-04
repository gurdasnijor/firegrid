# SDD: Choreography Facade

Status: proposal
Created: 2026-05-04
Owner: Durable Agent Substrate

## Problem

The substrate now has the durable mechanics needed for Fireline/Firepixel-style
agent runtimes:

- durable completions and run state;
- event-plane producers and projections;
- snapshot/stream/until projection observation;
- durable subscribers for timer, scheduled work, and projection-match
  completions;
- claim-before-side-effect work pipelines.

The remaining gap is ergonomic and semantic. A runtime or agent tool layer
should not have to manually thread completion ids, run ids, projection rows,
subscriber scan results, and claim mechanics to express:

```text
sleep(duration)
wait_for(trigger, timeout?)
schedule_me(when, prompt)
await permission or required action
```

Those operations are the choreography surface described by the Firepixel RFC.
They should be available as both:

- an Effect-native runtime API for host/runtime code; and
- agent-visible tool bindings for runtimes that expose choreography tools to
  agents.

This SDD proposes that facade without making Fireline, Firepixel, ACP, tool
calls, sessions, or prompts substrate-native concepts.

## Design Inputs

This proposal is informed by these existing documents and code paths:

- `/Users/gnijor/gurdasnijor/firepixel/rfc/concepts/choreography-and-combinators.md`
  defines the choreography-first application layer and the canonical tools:
  `sleep`, `wait_for`, `spawn`, `spawn_all`, `schedule_me`, and `execute`.
- `/Users/gnijor/gurdasnijor/firepixel/rfc/internals/durable-state-awaitables-approvals-timers.md`
  defines durable promises/awaitables, completion keys, snapshot-first
  reconstruction, and required-action permission waits.
- `/Users/gnijor/gurdasnijor/firepixel/rfc/operating/observability.md`
  requires choreography invocations to emit durable trace/session records
  readable through projections.
- `/Users/gnijor/gurdasnijor/fireline/rfc/concepts/choreography-and-combinators.fireline.md`
  documents the current Fireline tool names, input/output shapes, suspension
  sentinel pattern, and `fireline.agent.suspended` / `fireline.agent.resumed`
  behavior. This is useful prior art, not a substrate naming requirement.

## Layer Boundary

The choreography facade is above the substrate kernel and below
Fireline/Firepixel runtime adapters:

```text
Firepixel / Fireline runtime adapters and agent tool layers
  -> Choreography facade
    -> EventPlane / Projection / DurableWaits / subscribers / Work
      -> durable.run / durable.completion / durable.claim.attempt
      -> Durable Streams + Durable Streams State
```

The facade may compose existing substrate APIs. It must not:

- introduce ACP, session, prompt, permission, provider, sandbox, or tool-call
  rows into substrate-native state;
- make projection rows hidden substitutes for durable completions or ownership;
- expose raw Durable Streams append, raw StreamDB collections, claim folds, or
  run builders as the normal choreography API;
- require a workflow engine or developer-authored DAG as the primary model.

## Core Concepts

### Current Work Context

The facade needs a current durable work context supplied by the hosting runtime.
This context hides ids that callers should not manually thread.

Conceptually:

```ts
interface CurrentWorkContext {
  readonly workId: string
  readonly ownerId: string
  readonly correlationId?: string
  readonly causationId?: string
  readonly trace?: Readonly<Record<string, string>>
}
```

Runtime code should not normally write:

```ts
const work = yield* DurableWork.start(...)
const wait = yield* DurableWaits.awakeable({ workId: work.workId, name })
yield* DurableWork.blockOn({ workId: work.workId, completionId: wait.completionId })
```

Instead, the runtime provides `CurrentWorkContext`, and the choreography call
lowers through that context.

### Choreography Operation

A choreography operation is not a new authority row. It is an API-level command
that lowers to existing substrate facts:

```text
operation invoked
  -> durable trace/domain observation row is emitted when applicable
  -> durable.completion pending row is created
  -> current durable.run records blockedOnCompletionId
  -> subscriber / external actor / projection match resolves the completion
  -> ready work is derived
  -> worker claims and resumes/continues according to runtime policy
```

The current substrate already supports each individual step. The facade's job
is to make the composition coherent and hard to misuse.

### Trigger

`waitFor` needs a typed trigger. A trigger is a small value that explains how a
completion may become resolved. It is not a global registry.

Initial trigger profiles:

```ts
type ChoreographyTrigger<A> =
  | ProjectionMatchTrigger<A>
  | AwakeableTrigger<A>
```

Projection-match triggers reference caller-owned event planes and projection
queries. Awakeable triggers reference stable semantic keys for externally
resolved waits.

### Tool Binding

Agent-visible tools and host-runtime APIs should share lowering semantics.

The agent tool:

```text
wait_for(trigger, timeoutMs?)
```

and the Effect API:

```ts
yield* Choreography.waitFor(trigger, { timeout })
```

should create the same durable shape. They may differ in presentation:

- agent tools often return a suspension sentinel immediately;
- host-runtime Effect programs may be interpreted by a runtime that suspends
  and later resumes.

The durable records underneath should not fork.

## Proposed API Shape

Names are provisional. The important part is the shape and responsibility
boundary.

### Runtime API

```ts
import { Duration, Effect } from "effect"
import { Choreography } from "@durable-agent-substrate/substrate"

const program = Effect.gen(function* () {
  yield* Choreography.sleep(Duration.seconds(5))

  const decision = yield* Choreography.waitFor(
    FirepixelRequiredActions.permissionResolved({ permissionId }),
    { timeout: Duration.minutes(10) },
  )

  yield* Choreography.scheduleMe({
    at: new Date("2026-05-04T17:00:00.000Z"),
    input: { prompt: "Follow up on the review" },
  })

  return decision
})
```

Callers do not pass `workId`, `completionId`, stream URL, claim id, or raw row
envelopes. Those are provided by layers and the current work context.

### Trigger Definition

Caller-owned planes define caller-owned triggers:

```ts
const permissionResolved = (input: { permissionId: string }) =>
  ChoreographyTrigger.projectionMatch({
    label: `permission-resolved:${input.permissionId}`,
    projection: FirepixelRequiredActionPlane.projections.byId(input.permissionId),
    match: (row): row is PermissionResolvedRow =>
      row !== undefined && row.state === "resolved",
  })
```

The trigger refers to a plane projection. The substrate does not know that this
is a permission or ACP tool-call decision.

### Tool Binding API

The same facade should be bindable as agent tools:

```ts
const tools = ChoreographyTools.make({
  sleep: Choreography.sleepTool(),
  wait_for: Choreography.waitForTool(triggerDecoder),
  schedule_me: Choreography.scheduleMeTool(),
})
```

The exact tool descriptor format is adapter-owned. The binding must preserve
these invariants:

- tool descriptors are transport-agnostic;
- tool call inputs are decoded with Effect Schema;
- invoking a tool appends durable trace/intent before returning suspension;
- the tool result shape maps back to the same result type as the runtime API.

## Lowering Semantics

| Operation | Facade contract | Existing substrate lowering |
| --- | --- | --- |
| `sleep(duration)` | Durably wait until a duration elapses. | `DurableWaits.sleep` creates a `timer` completion with `dueAtMs`; current run blocks on it; timer subscriber resolves it; ready work is derived. |
| `waitFor(trigger, timeout?)` | Durably wait until a typed trigger matches or timeout wins. | `DurableWaits.waitFor` creates a `projection_match` completion with durable trigger/deadline data; projection-match subscriber resolves or cancels it; current run blocks on the completion. |
| `scheduleMe({ at, input })` | Queue future self-directed work without launching it early. | `DurableWaits.scheduleWork` creates a `scheduled_work` completion; scheduled-work subscriber resolves at due time; Fireline/Firepixel runtime maps the resolved completion into a self-prompt only after live promptability / runtime policy checks pass. |
| `awaitAwakeable(key)` | Wait for an external actor to resolve a stable semantic key. | `DurableWaits.awakeable` creates an externally resolved completion; external UI/policy/adapter resolves through `CompletionProducer`; current run blocks on the completion. |
| permission / required action | Wait for caller-owned permission state to terminalize. | Caller emits required-action rows through `EventPlane`; UI/policy emits resolution rows; facade waits through a projection-match trigger or stable awakeable, depending on the domain profile. |

`spawn`, `spawnAll`, and `execute` should use the same pattern later, but they
also require runtime/provider/session/tool policies. They should be specified
after the first `sleep` / `waitFor` / `scheduleMe` / permission slice proves the
facade boundary.

## Suspension Semantics

There are two valid presentations of the same durable operation.

### Agent Tool Presentation

An agent calls a choreography tool. The tool handler appends durable intent,
creates the completion, blocks the current run, and returns a suspension
sentinel to the agent adapter.

```text
tool call accepted
  -> durable intent + completion + blocked run
  -> return SuspensionSentinel
  -> later resume/result is delivered by runtime adapter
```

This matches the existing Fireline direction documented in
`choreography-and-combinators.fireline.md`.

### Effect Runtime Presentation

Host code uses `yield* Choreography.sleep(...)`. This only works inside a
runtime interpreter that understands durable suspension.

```text
program yields choreography operation
  -> interpreter lowers it to durable facts
  -> interpreter returns suspended outcome to host
  -> later ready work invokes the resume path
```

The facade should make this shape possible, but the first implementation does
not need to solve general JavaScript continuation replay. Firepixel and
Fireline long-lived agent runtimes may resume at adapter/session boundaries
instead of replaying arbitrary JS call stacks.

The important invariant is:

```text
the durable wait survives process death even if the in-memory Effect fiber does not
```

## Observability

Every choreography operation should emit durable trace or caller-owned domain
observation records sufficient to explain:

- operation kind;
- current work id;
- semantic key or trigger label;
- completion id;
- timeout/deadline when applicable;
- causation/correlation metadata;
- terminal outcome.

Trace rows are observational. They do not replace `durable.completion`,
`durable.run`, or `durable.claim.attempt` authority.

Agent-side introspection should be implemented as projection queries over these
records, not by reading runtime memory.

## Concrete Use Cases

### ACP Permission Request

```text
ACP adapter observes session/request_permission
  -> Firepixel ACP event plane emits permission requested/update rows
  -> required-action projection exposes pending permission
  -> Choreography.waitFor(permissionResolved(permissionId), timeout)
  -> approval UI emits permission resolution row
  -> projection-match subscriber resolves completion
  -> current work becomes ready and runtime maps decision back to ACP response
```

ACP is adapter vocabulary. The substrate sees event-plane rows,
projection-match completions, run blocking, ready work, claims, and terminal
results.

### Delayed Self Prompt

```text
agent/tool/runtime calls schedule_me(when, prompt)
  -> scheduled_work completion is created
  -> run records durable scheduled intent / trace
  -> scheduled-work subscriber resolves when due
  -> Firepixel runtime checks live promptability
  -> runtime appends prompt intent or re-waits on promptability policy
```

The substrate resolves "time reached." It does not decide whether a live agent
session is promptable.

### Wait For Projected Session State

```text
runtime defines session event plane
adapter emits session update rows
runtime calls waitFor(sessionTerminal(requestId), timeout)
projection-match subscriber resolves when terminal row appears
```

The trigger is caller-defined; the facade supplies durable waiting semantics.

### Tool-Layer Sleep

```text
agent calls sleep({ durationMs, reason })
tool binding decodes input
tool binding invokes Choreography.sleep
runtime returns suspension sentinel
timer subscriber later resolves
agent receives resumed result through adapter-specific channel
```

The tool binding and runtime API lower to the same timer completion.

## First Implementation Slice

The first slice should prove only:

1. a `Choreography` Effect service that reads `CurrentWorkContext`;
2. `sleep`, `waitFor`, `scheduleMe`, and `awakeable` facade methods that create
   completions through existing `DurableWaits`;
3. current-run blocking without caller-threaded ids;
4. durable trace/intent emission as observational records;
5. a simple tool-binding harness proving tool input -> choreography operation
   -> suspension sentinel;
6. an ACP-permission-shaped example using a fake event plane, not ACP code.

It should not implement:

- `spawn`, `spawnAll`, or `execute`;
- ACP/MCP/Claude/Codex adapters;
- process launch or live session ownership;
- general JS continuation replay;
- a workflow SDK or registry;
- new substrate authority row families.

## Open Questions

1. Should the first implementation expose the runtime API and tool-binding API
   in one module, or separate `Choreography` and `ChoreographyTools` modules?
2. Should current-run blocking be a small new internal service over
   `durable.run`, or should it reuse existing internal state-machine builders
   behind the facade?
3. What is the minimum trace row schema needed for agent-side introspection
   without making Fireline-specific `agent.suspended` / `agent.resumed` rows
   substrate-native?
4. Should `waitFor` require projection-match triggers only in v1, or also
   expose awakeable-key triggers through the same function?
5. Should the first tool-binding proof return a Fireline-style
   `SuspensionSentinel`, or a neutral substrate sentinel that Fireline maps to
   its profile?
