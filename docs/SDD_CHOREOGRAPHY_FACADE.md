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
  argues that choreography must be observable and that durable state remains
  the reconstruction source. In this substrate SDD, that is treated as an
  architectural requirement for instrumentation and projection access, not a
  requirement to put trace rows into the core choreography data path.
- `/Users/gnijor/gurdasnijor/fireline/rfc/concepts/choreography-and-combinators.fireline.md`
  documents the current Fireline tool names, input/output shapes, suspension
  sentinel pattern, and `fireline.agent.suspended` / `fireline.agent.resumed`
  behavior. This is useful prior art, not a substrate naming requirement.
- `/Users/gnijor/gurdasnijor/fireline/vault/sdds/shipped/observability-integration.md`
  treats OpenTelemetry spans and W3C trace context propagation as the lineage
  mechanism, while agent-layer rows remain the source of durable state.

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
  readonly workId: WorkId
  readonly ownerId: OwnerId
  readonly correlationId?: string
  readonly causationId?: string
  readonly telemetry?: Readonly<Record<string, string>>
}
```

For v1, `workId` is a brand over the same string identity as the current
`durable.run` `runId`. The facade does not introduce a separate work row; it
only hides the current run identity from normal choreography callers.

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
  -> instrumentation boundary records span/log metadata when configured
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
```

Projection-match triggers reference caller-owned event planes and projection
queries. Externally resolved awakeable waits remain a separate facade method in
v1.

Trigger values must be described by Effect Schema so the runtime API and tool
binding API can share decoding and avoid parallel hand-written input shapes.
Non-serializable matcher predicates are registered in a layer-scoped matcher
service and referenced by stable matcher id. There is no global matcher
registry.

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

The durable lowering underneath should not diverge. A runtime call to
`Choreography.sleep` and an agent tool call to `sleep` should produce the same
substrate state transition shape.

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

  yield* Choreography.scheduleAt({
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
const permissionResolved = (input: { permissionId: PermissionId }) =>
  ChoreographyTrigger.projectionMatch({
    label: `permission-resolved:${input.permissionId}`,
    projectionKey: FirepixelRequiredActionPlane.projections.byId(input.permissionId).key,
    matcherId: "firepixel.required_action.permission_resolved",
  })
```

The trigger refers to a plane projection. The substrate does not know that this
is a permission or ACP tool-call decision. The matcher implementation is
provided by a layer:

```ts
const PermissionMatchersLive = TriggerMatchers.layer({
  "firepixel.required_action.permission_resolved": (snapshot, trigger) =>
    Effect.succeed(matchPermissionResolution(snapshot, trigger)),
})
```

### Tool Binding API

The same facade should be bindable as agent tools:

```ts
const tools = ChoreographyTools.make({
  sleep: Choreography.sleepTool(),
  wait_for: Choreography.waitForTool(triggerDecoder),
  schedule_me: Choreography.scheduleAtTool(),
})
```

The exact tool descriptor format is adapter-owned. The binding must preserve
these invariants:

- tool descriptors are transport-agnostic;
- tool call inputs are decoded with Effect Schema;
- invoking a tool creates the durable completion and blocked run before
  returning suspension;
- tool calls are ordinary model-visible tool calls, so the adapter/runtime can
  observe them without requiring substrate trace rows;
- the tool result shape maps back to the same result type as the runtime API.

## Lowering Semantics

| Operation | Facade contract | Existing substrate lowering |
| --- | --- | --- |
| `sleep(duration)` | Durably wait until a duration elapses. | `DurableWaits.sleep` creates a `timer` completion with `dueAtMs`; current run blocks on it; timer subscriber resolves it; ready work is derived. |
| `waitFor(trigger, timeout?)` | Durably wait until a typed trigger matches or timeout wins. | `DurableWaits.waitFor` creates a `projection_match` completion with durable trigger/deadline data; projection-match subscriber resolves or cancels it; current run blocks on the completion. |
| `scheduleAt({ at, input })` | Queue future scheduled work without launching it early. | `DurableWaits.scheduleWork` creates a `scheduled_work` completion; scheduled-work subscriber resolves at due time; Fireline/Firepixel runtime maps the resolved completion into a self-prompt only after live promptability / runtime policy checks pass. The calling run does not block. |
| `awaitAwakeable({ name })` | Wait for an external actor to resolve a stable work-scoped semantic key. | `DurableWaits.awakeable` creates an externally resolved completion scoped by current `workId` and `name`; external UI/policy/adapter resolves through `CompletionProducer`; current run blocks on the completion. Global awakeables stay on `DurableWaits.awakeableGlobal` for now. |
| permission / required action | Wait for caller-owned permission state to terminalize. | Caller emits required-action rows through `EventPlane`; UI/policy emits resolution rows; facade waits through a projection-match trigger or stable awakeable, depending on the domain profile. |

`spawn`, `spawnAll`, and `execute` should use the same pattern later, but they
also require runtime/provider/session/tool policies. They should be specified
after the first `sleep` / `waitFor` / `scheduleAt` / permission slice proves the
facade boundary.

### Deferred Operation Sketches

The first implementation should not build these, but the facade should remain
compatible with them.

`execute` should remain a higher-runtime operation:

```text
operation call
  -> caller-owned execution request row
  -> Work pipeline claims execution
  -> provider/tool transport invoked
  -> caller-owned execution terminal row
```

Provider, sandbox, resource, and permission policy stay above the substrate.

`spawn` and `spawnAll` should remain higher-runtime operations:

```text
operation call
  -> caller-owned child launch/prompt rows
  -> Work pipeline claims launch side effects
  -> Projection until observes child terminal rows
  -> aggregate terminal results when needed
```

Spawn is not a substrate primitive. It composes event planes, projections, Work
pipelines, and waits.

## Suspension Semantics

There are two valid presentations of the same durable operation.

### Agent Tool Presentation

An agent calls a choreography tool. The tool handler creates the durable
completion, blocks the current run, and returns a suspension sentinel to the
agent adapter.

```text
tool call accepted
  -> completion + blocked run
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

The first implementation may use Effect interruption as the in-process control
signal after a durable suspension has been committed:

```text
create completion
block current run
interrupt current fiber
runner catches interruption
runner verifies durable.run is blocked on a completion
runner reports suspended presentation
```

The verification step is required. Ordinary host cancellation or shutdown must
not be misreported as successful durable suspension. Interruption means
"suspended" only when the runner can observe the durable blocked run state it
expected to write.

## Instrumentation And Observability Boundary

Tracing and observability are cross-cutting concerns, not default choreography
data-plane rows.

The first choreography facade should provide instrumentation boundaries around
each operation, using Effect-native tracing APIs such as `Effect.withSpan` and
span annotations where appropriate. OTLP/OpenTelemetry export, span naming, and
trace-context propagation are host/runtime concerns.

The facade should make it easy for a runtime to attach:

- operation kind;
- current work id;
- semantic key or trigger label;
- completion id;
- timeout/deadline when applicable;
- causation/correlation metadata;
- terminal outcome.

The substrate should not require a `durable.trace` row for correctness or
ordinary choreography usage. Existing model-visible tool calls, caller-owned
event planes, and runtime spans are expected to cover most near-term
observability needs.

If a later use case requires durable agent-readable trace history independent
of tool-call/session rows, it should be designed as a separate observability
profile. That profile may use `durable.trace` or caller-owned event planes, but
it must remain observational:

```text
trace/span/session/tool records do not replace durable.completion
trace/span/session/tool records do not replace durable.run
trace/span/session/tool records do not replace durable.claim.attempt
```

Agent-side introspection should be implemented as projection queries over these
records, not by reading runtime memory. The first choreography facade only
needs to preserve the architectural hook points.

## Stream Forking Compatibility

Durable Streams protocol forking is a separate concept from "shared lowering."
A stream fork creates a new stream that references a source stream up to a fork
offset, then accepts independent appends after that divergence point. This is a
powerful future primitive for agent/session branching, review, experimentation,
and replay.

The choreography facade should not expose stream forking in the first build,
but it should avoid choices that make forking hard later.

Design implications:

- Do not use stream offsets as business identifiers. Use semantic ids for
  work, completions, tool calls, sessions, and prompts.
- Include enough semantic identity in completion keys and projection rows that
  a forked session can continue independently after the fork point.
- Treat fork lineage as stream metadata/runtime context, not as a new
  `durable.completion` or `durable.run` authority rule.
- Keep runtime API and agent tool API lowering identical so either surface can
  run on a source stream or a fork stream without changing operation meaning.
- Defer explicit APIs such as `forkSession` or `forkWork` until Fireline /
  Firepixel runtime semantics specify what should be copied, inherited,
  redacted, or re-bound.

Possible later API shape:

```ts
const fork = yield* RuntimeFork.forkCurrentSession({
  at: { kind: "current_cursor" },
  label: "try alternate repair strategy",
})
```

The substrate role would be to make stream fork creation and projection rebuild
work cleanly. Fireline/Firepixel would own session-level policy such as visible
tool set, resource handles, live runtime ownership, and whether a fork can
prompt immediately.

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
agent/tool/runtime calls schedule_at(when, input)
  -> scheduled_work completion is created
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
2. `sleep`, `waitFor`, `scheduleAt`, and `awakeable` facade methods that create
   completions through existing `DurableWaits`;
3. current-run blocking for suspending operations without caller-threaded ids;
4. Effect-native instrumentation boundaries around choreography operations,
   without requiring durable trace rows;
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

## Design Decisions For First Build

### Module Split

Expose separate modules:

```text
Choreography
ChoreographyTools
```

`Choreography` is the Effect-native runtime API. `ChoreographyTools` adapts the
same operations into agent-visible tool handlers/descriptors. The modules share
lowering code internally, but the public shapes stay separate because runtime
code and tool adapters have different presentation concerns.

This avoids forcing tool descriptor concepts into normal Effect programs, while
also avoiding divergent semantics between "runtime called sleep" and "agent
called sleep."

### Branded Ids

New public choreography signatures should use branded ids:

```ts
type WorkId = string & Brand.Brand<"WorkId">
type CompletionId = string & Brand.Brand<"CompletionId">
type OwnerId = string & Brand.Brand<"OwnerId">
```

Branded ids have no runtime cost and prevent accidental swapping of string ids
at the boundary between choreography, waits, runs, event planes, and work
claims. The first build should use them for new choreography-facing types.
Retrofitting every existing kernel export can happen incrementally.

### Current-Run Blocking

Current-run blocking is internal facade machinery, not a public producer API.

The first implementation should add a small internal helper behind
`ChoreographyLive`:

```text
blockCurrentRunOn(completionId)
```

It may use the existing `durable.run` state-machine builders and append the
resulting row. Callers should not see `blockRun`, run builders, raw append, or
`blockedOnCompletionId`.

This preserves the existing boundary:

```text
runtime/user API: yield* Choreography.sleep(...)
internal lowering: durable.completion pending + durable.run blocked
```

If a later runtime needs a lower-level block API, it should be justified by a
separate SDD/spec. Do not add it as part of the choreography facade by default.

### Instrumentation Boundary

Do not require `durable.trace` rows in the first choreography build.

The first implementation should wrap choreography operations in Effect-native
instrumentation boundaries. The intended span names are neutral:

```text
substrate.choreography.sleep
substrate.choreography.wait_for
substrate.choreography.schedule_at
substrate.choreography.awakeable
```

Span/log attributes should be best-effort and non-authoritative:

```ts
{
  workId: string
  completionId?: string
  operation: "sleep" | "wait_for" | "schedule_at" | "awakeable"
  label?: string
  dueAtMs?: number
  deadlineAtMs?: number
  semanticKey?: string
  correlationId?: string
  causationId?: string
}
```

If a runtime wants durable agent-readable choreography history, it can emit
caller-owned event-plane rows or map tool calls/session events into its own
profile. That should be layered above this facade until a concrete substrate
use case forces a durable observability profile.

### `waitFor` Trigger Scope

`waitFor` should support projection-match triggers in v1.

Awakeable-key waits should remain a separate method:

```ts
yield* Choreography.waitFor(trigger, { timeout })
yield* Choreography.awaitAwakeable({ name })
```

This keeps two different concepts legible:

- projection-match waits resolve because materialized state matched;
- awakeables resolve because an external actor resolved a stable semantic key.

A later API can add overloads or helper constructors if real call sites show
the split is too verbose.

### Schema Triggers And Scoped Matchers

The first build should define the trigger input with Effect Schema, using a
tagged shape such as:

```ts
const ProjectionMatchTrigger = Schema.TaggedStruct("ProjectionMatch", {
  label: Schema.String,
  projectionKey: Schema.String,
  matcherId: Schema.String,
})
```

The serialized trigger carries only data. The matcher predicate is supplied by
a layer-scoped `TriggerMatchers` service keyed by `matcherId`.

Rules:

- no global matcher registry;
- no function predicates embedded in serializable tool input;
- tool decoders derive from the same trigger schema as runtime APIs;
- lowering dispatch is exhaustive over the trigger union;
- missing matcher is a runtime configuration error, not a hidden no-op.

### Suspension As Interruption

Choreography methods that suspend may interrupt the current Effect fiber after
the durable completion and blocked run have been written. The work runner then
translates interruption into the caller presentation.

For runtime work:

```text
interrupted + verified blocked run -> WorkOutcome.suspended
interrupted without verified block -> cancelled/interrupted failure
```

For tool bindings:

```text
interrupted + verified blocked run -> ChoreographySuspension
```

This keeps call sites linear while avoiding a second in-memory suspension
primitive.

### Minimal Error Surface

Only expose tagged errors that callers can realistically branch on. For v1,
the expected recoverable error is timeout:

```ts
class ChoreographyTimeout extends Data.TaggedError("ChoreographyTimeout")<{
  readonly completionId: CompletionId
  readonly deadlineAtMs: number
}> {}
```

Timeout is reserved for the host-runtime presentation when a previously
suspended wait resumes from a timeout or cancelled completion. The first facade
does not implement general continuation replay just to raise this error. Most
other failures are substrate/runtime defects or ordinary handler failures and
should be handled at the work-runner boundary instead of expanding the
choreography API error taxonomy.

### Suspension Sentinel

The first tool-binding proof should return a neutral substrate sentinel:

```ts
type ChoreographySuspension = {
  readonly suspended: true
  readonly operation: "sleep" | "wait_for" | "schedule_at" | "awakeable"
  readonly completionId: CompletionId
  readonly workId: WorkId
}
```

Fireline can map this to its profile-specific `SuspensionSentinel` shape and
field names. For example, Fireline may expose an agent tool named
`schedule_me` while calling substrate `scheduleAt` internally. The substrate
should not ship Fireline-native sentinel naming as its canonical tool-binding
result.

### First Build Readiness

With these decisions, the first build can proceed without additional substrate
authority concepts. The Acai spec should target:

- `Choreography` Effect service;
- `CurrentWorkContext` layer/input;
- branded ids for new choreography-facing signatures;
- internal current-run blocking;
- Effect-native instrumentation boundaries, with no required durable trace
  rows;
- schema-described projection-match triggers with layer-scoped matchers;
- projection-match-only `waitFor`;
- separate `awaitAwakeable`;
- suspension as interruption, guarded by durable blocked-run verification;
- minimal `ChoreographyTimeout` tagged error;
- `ChoreographyTools` neutral sentinel proof;
- fake ACP-permission-shaped event-plane example with no ACP implementation.
