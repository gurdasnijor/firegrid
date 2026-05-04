# Durable Agent Substrate SDD

Status: draft
Created: 2026-05-03
Owner: Durable Agent Substrate
Audience: implementers of durable handler runtimes and systems layering agent runtimes above them

## 1. Executive Summary

The durable agent substrate is the durable coordination layer underneath
agent-runtime systems.

Its job is to make application/runtime progress durable, replayable,
observable, and safe under concurrency without forcing higher layers to manage
raw stream records, Durable Streams State envelopes, claim folds, or pending
promise rows.

The substrate should let a runtime express:

```text
this work exists
this work is waiting
this durable condition resolved
this work is ready
this handler owns the work
this handler completed or failed the work
```

without exposing the runtime to low-level append/projection mechanics.

The central lifecycle is:

```text
durable fact accepted
  -> projection rebuilds
  -> DurableCompletion resolves or rejects
  -> ReadyWork is derived
  -> handler runs only after durable ownership
  -> terminal result is durable
  -> the same state rebuilds from zero
```

The initial public API should be small:

```text
DurableWorkRunner.runTyped(...)
DurableWork.send(...)
DurableWaits.sleep(...)
DurableWaits.waitFor(...)
DurableWaits.awakeable(...)
DurableAwakeables.resolve(...)
DurableAwakeables.reject(...)
DurableAwakeables.cancel(...)
```

The normal public surface should be Effect-program-oriented. Higher runtimes
should not normally create completions, append raw stream rows, run claim folds,
or construct Durable Streams State envelopes.

## 2. Non-Goals

The substrate does not implement:

- ACP, MCP, conductor, stdio, or process launch;
- Claude, Codex, or vendor-specific agent adapters;
- provider, sandbox, resource, or local filesystem lifecycle;
- tool transport or MCP-over-ACP behavior;
- runtime participant lifecycle;
- a CLI or binary control surface;
- a workflow-orchestration SDK as the primary application model;
- a custom replacement for Durable Streams or Durable Streams State.

Those systems can sit above the substrate. They should not be part of the
substrate.

## 3. Layering

The intended dependency direction is:

```text
application runtime / agent runtime / Firepixel / Fireline adapter
  -> durable-agent-substrate
    -> Durable Streams
    -> Durable Streams State
```

The substrate must not import Firepixel or any runtime adapter package.

Higher runtimes may import the substrate and provide live capabilities such as:

```text
send email
charge card
run command
spawn process
run tool
call model/vendor API
write domain output
```

The substrate provides durable coordination around those capabilities.

The substrate should expose long-running observation/worker behavior as scoped
Effect operator programs. It should not expose a polling API as the normal
model. Internally, an operator program may catch up, observe projections,
follow live stream changes, claim eligible work, and invoke handlers, but the
public contract is "run this durable operator under a scope", not "poll a
queue".

## 4. Normative Substrate Semantics

This section defines the substrate contract. Runtime-specific examples belong
in appendices.

### 4.1 Durable Record

A durable record is an accepted fact in the stream.

Records must carry enough data for:

- rebuild;
- causality;
- audit;
- operator/handler progress;
- idempotency and conflict handling where required.

The implementation should encode records as Durable Streams State-compatible
envelopes. The normal consumer API should not expose this envelope.

Foundational authority rows:

```text
durable.run
durable.completion
durable.claim.attempt
```

`durable.trace` is an observability extension, not an authority row. It records
durable intent and lifecycle breadcrumbs that make higher-layer choreography
legible to humans, agents, and tests. No wait, claim, terminal, or ownership
decision is made from trace rows unless a later profile explicitly says so. The
first implementation can prove the authority loop with only run, completion,
and claim-attempt rows, then introduce trace rows when implementing observable
`sleep`, `wait_for`, `schedule_me`, `spawn`, or `execute` behavior.

### 4.2 Projection

A projection is a rebuildable current view derived from durable records.

Projection examples:

```text
CompletionProjection
RunProjection
ReadyWorkProjection
```

Projection rules:

- projections are query views, not truth;
- replay over retained input with the same fold version produces the same
  logical rows;
- missing retained input is an explicit rebuild gap, not silent partial truth;
- timestamps are not ordering authority when stream position/cursor is
  available.

### 4.3 DurableCompletion And Awakeable

`DurableCompletion` is the minimal internal durable wait primitive.

It is the durable analogue of a promise/deferred:

```text
pending
resolved
rejected
cancelled
```

It represents a named condition that a run may wait on and that can later be
resolved or rejected by:

- a timer operator;
- a projection-match operator;
- an external actor such as a human approval UI;
- a child run terminal projection;
- an aggregate fan-in operator;
- an adapter response operator;
- a tool/execution result operator.

`DurableCompletion` is internal substrate terminology. The public API should
prefer domain-shaped operations:

```text
DurableWaits.awakeable({ name })
DurableWaits.sleep(durationMs)
DurableWaits.waitFor(trigger)
DurableAwakeables.resolve({ workId, name, result })
DurableAwakeables.reject({ workId, name, error })
```

An `Awakeable` is the public externally resolved durable promise shape. It uses
Restate-style awakeable semantics, but requires a stable semantic key for replay
and idempotency.

```text
Awakeable = externally resolved durable promise
DurableCompletion = internal row/state machine
```

The first row-family name should be neutral:

```text
durable.completion
```

Fireline/Firepixel profiles may map this to compatibility names later, but the
substrate should not ship new code with `fireline.awakeable` as its native row
name.

### 4.4 DurableTrigger

`DurableTrigger` is the durable description of what may resolve or reject a
completion. It is an API input shape, not a durable row family.

Examples:

```text
timer due at timestamp
projection match predicate
external awakeable key
child run terminal key
all children terminal
execution result durable
```

Trigger data must be durable when it must survive restart. Do not hide durable
trigger predicates in live closures. A trigger compiles to a
`DurableCompletionRow` variant plus trace records only where user/runtime
observability requires them. Trace rows are not the trigger authority.

### 4.5 Run

A `Run` is a durable unit of work.

Minimal states:

```text
started
blocked
completed
failed
cancelled
```

A run can block on a durable completion:

```text
run.state = blocked
run.blockedOnCompletionId = completionId
```

When that completion resolves, ready work can be derived.

For the first slice, keep `Run` as the logical work row. `ready` is a derived
projection, not a durable run state. `claimed` is claim authority, not a durable
run state. Claim authority is represented by append-only claim attempt rows and
the first-valid-winner fold.

### 4.6 ReadyWork

`ReadyWork` is a derived view of work that can be claimed.

It is not a producer-authored row.

Minimal derivation:

```text
Run
  state = blocked
  blockedOnCompletionId = X

DurableCompletion
  completionId = X
  state = resolved

ReadyWork
  runId = Run.runId
```

In rule form:

```text
ready if:
  run.state == blocked
  AND run.blockedOnCompletionId == completion.completionId
  AND completion.state == resolved
```

Rejected completions do not produce normal ready work. In the minimal profile,
they terminalize the blocked run as failed:

```text
blocked run + rejected completion
  -> run failed with completion_rejected
```

Cancelled completions follow the same no-stuck-run rule in V1:

```text
blocked run + cancelled completion
  -> run failed with completion_cancelled
```

Cancellation is represented durably as a terminal completion state or as a
domain-specific rejection whose terminal reason is `cancelled`. It must not
exist only as an in-memory interruption. Future profiles may distinguish
cancelled from failed in the public run state, but V1 must terminalize the
blocked run and avoid permanent blocked state.

Future profiles may route rejected completions to compensation/error handlers,
but V1 should not leave runs permanently blocked.

### 4.7 Durable Ownership

A handler may run only after durable ownership has been won.

Ownership is the authority boundary:

```text
ReadyWork
  -> Claim / Attempt row
  -> first valid claim wins
  -> winning operator invokes handler
  -> terminal state accepted only from winner
```

Claim-before-invoke is a hard ordering invariant. A handler MUST NOT be invoked
until its claim attempt has been observed through the durable claim projection
as the winning attempt for the work item. Appending a claim and speculatively
invoking before the fold/projection confirms the winner violates the substrate
contract, even if the losing handler later suppresses its terminal write.

Phase 5 introduces explicit Claim / Attempt rows:

```text
claim attempt row:
  claimId
  workId
  ownerId
  attemptedAt cursor/sequence
  status = attempted

claim fold:
  first valid claim attempt by stream order wins
  same-owner duplicate attempts are idempotent/duplicate evidence
  different-owner later attempts are losing conflicts
```

This design assumes origin reads for claim authority. CDN-cached or stale
projection reads may be used to discover candidate work, but the winning claim
decision must be made from durable origin-ordered claim evidence.

## 5. Public API Contract

The public API should be Effect-native:

```text
schemas define durable contracts
Effect services expose durable substrate capabilities
Layers wire stores, projections, workers, and application dependencies
worker programs run as ordinary Effect programs
```

This follows the usual Effect service/layer pattern: define capabilities as
services, construct implementations with layers, provide dependencies at the
edge, and use scoped/managed runtimes for long-running worker processes.

Avoid a Restate-shaped top-level service registry. Higher runtimes should not
define work through a central object like `DurableService.define(...)`, and the
substrate should not require a `DurableWorker.make(...)` value as the main
authoring pattern. Those shapes can be convenient helpers later, but the
canonical API should be ordinary Effect services, functions, and layers.

There should not be separate everyday APIs for manual completion stores, claim
stores, raw stream appends, or raw projection mutation. Optional schemas are not
decorative metadata. They are the contract for input decoding, output encoding,
row validation, and projection typing.

### 5.1 Schema-First Contracts

The substrate should define all core rows and projections with Effect Schema.
This provides one source of truth for runtime validation, static TypeScript
types, generated test data, JSON Schema if needed, and Standard Schema V1
interop.

Initial authority schema set:

```text
durable row schemas:
  DurableRunRow
  DurableCompletionRow
  DurableClaimAttemptRow

derived projection schemas:
  RunProjection
  CompletionProjection
  ClaimProjection
  ReadyWorkProjection
```

`DurableRecordHeaders` and `DurableRecordEnvelope` are envelope helpers for the
stream/state implementation, not domain row families. Timer intent, projection
trigger, child-run wait, fan-in wait, and external awakeable are all represented
as `DurableCompletionRow` variants. Do not introduce separate foundational
timer or trigger row families in V1.

Optional observability schema:

```text
DurableTraceRow
```

`DurableTraceRow` payloads should stay deliberately boring:

```ts
export const DurableTraceRow = Schema.Struct({
  type: Schema.Literal("durable.trace"),
  traceId: DurableId,
  kind: Schema.String,
  workId: Schema.optional(DurableId),
  completionId: Schema.optional(DurableId),
  state: Schema.String,
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown }))
})
```

The payload is for audit, diagnostics, and choreography legibility. It must not
carry live handles, raw credentials, provider objects, or authority decisions.

Effect Schema is the internal contract:

```ts
export const DurableCompletionRow = Schema.Struct({
  type: Schema.Literal("durable.completion"),
  completionId: DurableId,
  key: Schema.String,
  state: Schema.Literal("pending", "resolved", "rejected", "cancelled"),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown)
})

export type DurableCompletionRow =
  Schema.Schema.Type<typeof DurableCompletionRow>
```

Standard Schema is an interop adapter, not the source of truth:

```ts
export const DurableCompletionRowStandard =
  Schema.standardSchemaV1(DurableCompletionRow)
```

Core schemas must remain dependency-free so they can be converted to Standard
Schema V1. Domain-specific runtimes can define their own schemas and pass them
to substrate worker/projection APIs, but those domain schemas should not be
imported by the substrate package.

### 5.2 Effect Services

Substrate capabilities should be exposed as Effect services. The service
methods are semantic operations, not stream append helpers.

Illustrative capability services:

```ts
export class DurableWaits
  extends Effect.Service<DurableWaits>()(
    "durable/Waits",
    {
      accessors: true,
      effect: Effect.gen(function* () {
        const completions = yield* DurableCompletionsInternal
        const timers = yield* DurableTimersInternal
        const projections = yield* DurableProjectionReader

        return {
          sleep: (durationMs: number) =>
            timers.sleep(durationMs),

          waitFor: <A>(trigger: DurableTrigger<A>) =>
            projections.waitFor(trigger),

          awakeable: <A>(input: AwakeableRequest<A>) =>
            completions.await(input)
        }
      })
    }
  ) {}

export class DurableAwakeables
  extends Effect.Service<DurableAwakeables>()(
    "durable/Awakeables",
    {
      accessors: true,
      effect: Effect.gen(function* () {
        const completions = yield* DurableCompletionsInternal

        return {
          resolve: completions.resolve,
          reject: completions.reject,
          cancel: completions.cancel
        }
      })
    }
  ) {}

export class DurableWork
  extends Effect.Service<DurableWork>()(
    "durable/Work",
    {
      accessors: true,
      effect: Effect.gen(function* () {
        const workStore = yield* DurableWorkStoreInternal

        return {
          send: workStore.send,
          status: workStore.status
        }
      })
    }
  ) {}

export class DurableWorkRunner
  extends Effect.Service<DurableWorkRunner>()(
    "durable/WorkRunner",
    {
      accessors: true,
      effect: Effect.gen(function* () {
        const runtime = yield* DurableWorkerRuntimeInternal

        return {
          runTyped: <I, O, E, R>(
            spec: {
              readonly type: string
              readonly input: Schema.Schema<I>
              readonly output: Schema.Schema<O>
            },
            handle: (input: I) => Effect.Effect<O, E, R>
          ): Effect.Effect<void, DurableWorkerError | E, R> =>
            runtime.runTyped(spec, handle)
        }
      })
    }
  ) {}
```

The service interfaces are small and stable. Their `Default`/live layers can
depend on Durable Streams, Durable Streams State, clocks, id generation, and
projection internals without leaking those dependencies into the service method
signatures.

`DurableWorkRunner.runTyped(...)` returns a scoped operator program. In
production it is typically long-running: catch up from the durable stream,
observe derived ready work, append a claim attempt, wait until that claim is
observed as the winner, invoke the handler, and append terminal state from the
handler `Exit`. A deterministic test helper may process one currently-ready
work item, but that helper should be internal/test-only and should not become
the public API.

### 5.3 Worker Programs And Layers

A durable worker should be an Effect operator program, not a global registry,
polling API, and not a special worker object. Application code defines normal
Effect functions with explicit dependencies. The substrate operator runner owns
claim/read/decode/invoke/terminalization.

Application handler:

```ts
const sendEmail = (input: SendEmailInput) =>
  Effect.gen(function* () {
    const email = yield* EmailProvider
    yield* email.send(input)
    return { sent: true }
  })
```

Worker program:

```ts
const SendEmailWorker = DurableWorkRunner.runTyped(
  {
    type: "email.send",
    input: SendEmailInput,
    output: SendEmailOutput
  },
  sendEmail
)
```

Layer wiring:

```ts
const Program = SendEmailWorker.pipe(
  Effect.provide(EmailProviderLive),
  Effect.provide(DurableAgentSubstrateLive)
)
```

For a long-running process with shared scoped resources, build or launch a
runtime from layers once:

```ts
const WorkerProgram = Effect.all(
  [
    DurableWorkRunner.runTyped(
      {
        type: "email.send",
        input: SendEmailInput,
        output: SendEmailOutput
      },
      sendEmail
    ),
    DurableWorkRunner.runTyped(
      {
        type: "card.charge",
        input: ChargeCardInput,
        output: ChargeCardOutput
      },
      chargeCard
    )
  ],
  { concurrency: "unbounded" }
)

Effect.runPromise(
  WorkerProgram.pipe(
    Effect.provide(AppLive),
    Effect.provide(DurableAgentSubstrateLive),
    Effect.scoped
  )
)
```

`DurableWorkRunner.runTyped(...)` is intentionally a service operation that
returns an Effect operator program, not a handler registry. It observes ready
work for one work type, decodes input using the provided schema, wins durable
ownership, invokes the Effect handler only after winning ownership is observed,
and records completion or failure from the handler `Exit`. Higher runtimes can
compose many such operator programs with `Effect.all`, `Layer.launch`, or a
managed runtime depending on deployment shape.

### 5.4 Handler Authoring

Handlers should use substrate capabilities by yielding Effect services, not by
receiving a fat mutable context object.

Preferred shape:

```ts
const promptAgent = (input: PromptAgentInput) =>
  Effect.gen(function* () {
    const agentRuntime = yield* AgentRuntime

    yield* DurableWaits.waitFor(input.promptabilityTrigger)

    const result = yield* agentRuntime.prompt(input)
    return result
  })
```

The runner terminalizes the owned work from the handler result or failure. The
handler should not normally call explicit completion/failure APIs.

Once-only terminalization is runner-owned:

```text
handler Effect succeeds
  -> runner appends exactly one completed terminal row for the winning claim

handler Effect fails with expected error
  -> runner appends exactly one failed terminal row for the winning claim

handler fiber is interrupted
  -> runner appends or causes exactly one cancelled/failed terminal row according to profile
```

Handlers return values or fail in the Effect error channel. They do not
terminalize durable work themselves. Duplicate terminal append attempts for the
same work key are resolved by first-valid-terminal-wins and must not rewrite
the winner.

Semantics:

- `DurableWaits.sleep(durationMs)` declares a timer completion, suspends
  the run, and resumes when the timer resolves.
- `DurableWaits.waitFor(trigger)` declares a durable trigger-backed
  completion and resumes when the trigger resolves.
- `DurableWaits.awakeable({ name })` is the keyed externally resolved
  durable promise wait.
- Handler success becomes the durable work completion.
- Handler expected failure becomes durable work failure.

Do not expose lower-level `createCompletion`, `resolveCompletion`,
`claimReadyWork`, or raw append operations as the normal handler API.

Durable side-effect memoization is deferred. A future `DurableStep` service or
equivalent API may record and replay completed side-effect results, but V1 is
focused on extracting the durable coordination loop separately from higher
runtime replay mechanics.

### 5.5 Work Declaration API

Application-facing clients or adapters need a way to declare semantic work:

```ts
interface DurableWork {
  send<Service, Handler>(input: {
    service: Service
    handler: Handler
    key: string
    input: unknown
    metadata?: {
      correlationId?: string
      causationId?: string
      [key: string]: string | undefined
    }
  }): Effect.Effect<WorkHandle>

  status(workId: string): Effect.Effect<WorkStatus>
}
```

This is semantic. It is not a raw stream append API.

`correlationId` and `causationId` are opaque lineage metadata to the substrate
unless a later profile explicitly assigns behavior to them.

### 5.6 Awakeable API

Awakeables are externally resolved durable promises backed by internal
`DurableCompletion` rows. Handler code awaits them through
`DurableWaits.awakeable(...)`. External actors such as approval UIs
resolve or reject them through `DurableAwakeables`.

Awakeable keys are scoped by default to the owning work item. The public API
requires a stable semantic `name`, and the substrate derives the durable key
from `(workId, name)`:

```text
awakeableKey = work:<workId>:awakeable:<name>
```

This avoids accidental global collisions and matches the common invocation-local
durable promise use case. Global awakeables are an explicit advanced form and
must include a namespace:

```text
global:<namespace>:awakeable:<name>
```

Duplicate resolutions for the same derived key follow first-valid-terminal-wins:
the first valid resolve/reject/cancel record wins, same semantic duplicate is
idempotent evidence, and conflicting later terminals are conflicts without
changing the winner.

```ts
interface DurableAwakeables {
  resolve<A>(input: {
    workId: string
    name: string
    result: A
  }): Effect.Effect<void>

  reject(input: {
    workId: string
    name: string
    error: unknown
  }): Effect.Effect<void>

  cancel(input: {
    workId: string
    name: string
    reason?: string
  }): Effect.Effect<void>
}
```

Handlers use:

```ts
const approval = yield* DurableWaits.awakeable({
  name: "permission:write-file"
})
```

External actors resolve:

```ts
yield* DurableAwakeables.resolve({
  workId,
  name: "permission:write-file",
  result: { decision: "approved", actorId }
})
```

Internally this creates/resolves durable completions. Higher runtimes should
not need `createCompletion` or `resolveCompletion` as their normal interface.

### 5.7 Handles

`WorkHandle` and `AwakeableHandle` are durable identities, not live handles.

```ts
interface WorkHandle {
  readonly workId: string
  readonly service: string
  readonly handler: string
  readonly key: string
}

interface AwakeableHandle {
  readonly key: string
  readonly completionId: string
  readonly workId?: string
}
```

These handles can be stored, logged, and used to query status. They do not prove
that a live process, promptable session, or handler is currently available.

### 5.8 Explicit Non-Exports

Do not export these from the normal public surface:

- raw Durable Streams append helpers;
- raw Durable Streams State envelope builders;
- ACP connector types;
- MCP bridge types;
- process/runtime participant handles;
- CLI boot functions;
- provider or sandbox handles;
- filesystem resource abstractions;
- tool transport dispatchers;
- Firepixel-specific runtime rows;
- broad database abstractions that hide Durable Streams State without a direct
  consumer;
- `DurablePromiseStore`;
- `RunStore`;
- `ProjectionReader`;
- `ReadyWorkDeriver`;
- `ClaimFold`;
- `claimReadyWork`;
- `completeWork`;
- `failWork`.

If raw record access becomes necessary for diagnostics or migration, put it
behind an explicitly advanced/internal export path and keep application runtime
code off that path.

## 6. Choreography Mapping

The canonical agent-facing choreography tool surface is:

```text
sleep(durationMs)
wait_for(trigger, timeoutMs?)
schedule_me(when, prompt)
spawn(agent, prompt)
spawn_all(tasks)
execute(sandbox, input)
```

These are not substrate primitives. They are higher-layer tools that compile to
durable substrate primitives plus materializer folds.

The round-trip rule is:

```text
Every feature must answer:
  which durable primitive?
  which combinator or materializer fold?
```

If a feature cannot be expressed as a durable primitive plus a combinator/fold,
it is either:

- application/runtime behavior above the substrate; or
- a candidate future primitive that needs an explicit design decision.

These all compile to the same substrate shape:

```text
declare durable work or completion
block run if needed
resolve/reject completion when durable condition happens
derive ready work
claim before side effects
complete/fail durably
```

Every choreography primitive must record durable intent before it suspends,
fans out, or invokes externally visible work. The authority record is usually a
run, completion, or claim-attempt row. Trace rows can make the dynamic schedule
more legible, but they remain observability, not authority.

The substrate must not ship a workflow-orchestration SDK as the primary
application model. Workflow engines can drive the substrate from the outside,
but normal agent progress must be expressible through durable records,
completions, projections, claims, and handler execution.

### 6.1 sleep(durationMs)

```text
optionally append durable trace row kind=sleep.scheduled
declare completion kind=timer
block run on completion
timer operator resolves completion when due
derive ready work
optionally append durable trace row kind=sleep.fired or sleep.cancelled
```

### 6.2 wait_for(trigger, timeoutMs?)

```text
optionally append durable trace row kind=wait.registered
declare completion kind=projection_match
snapshot projection
follow after cursor
resolve when predicate matches
reject/timeout when timeout fires
optionally append durable trace row kind=wait.resolved, wait.timed_out, or wait.cancelled
```

The substrate must provide snapshot-first-then-follow semantics without a lost
match window. The preferred implementation uses Durable Streams State snapshot
boundaries:

```text
snapshot-start
  -> full initial state
snapshot-end(cursor)
  -> evaluate predicate
  -> if unmatched, follow strictly after cursor
```

If State snapshot boundaries are not available, the fallback is the base
Durable Streams protocol:

```text
read/catch up until Stream-Up-To-Date is true
retain Stream-Next-Offset
evaluate rebuilt projection
if unmatched, live-follow from exactly Stream-Next-Offset
```

If neither path can prove a no-gap snapshot/follow boundary, `waitFor` must fail
with a typed unsupported/no-gap error rather than silently dropping matches.

### 6.3 schedule_me(when, prompt)

```text
optionally append durable trace row kind=schedule.registered
declare completion kind=scheduled_prompt
timer operator resolves completion when due
ready work is derived
higher runtime checks live promptability
higher runtime appends prompt intent only after promptability passes
higher runtime re-blocks or terminalizes by policy when promptability fails
optionally append durable trace row kind=schedule.fired or schedule.cancelled
```

Timer firing is not prompt dispatch authority. It only makes the scheduled
self-prompt eligible. The prompt intent is a separate durable record and must be
appended only after the higher runtime proves live promptability under its
profile.

If live promptability is unavailable when scheduled work becomes due, the
runtime handler should not lose the schedule. It should either:

- re-issue a wait on a live-promptability projection; or
- fail with explicit durable terminal state if the profile says scheduled work
  is single-attempt.

Do not hide this decision in an in-memory timer callback.

### 6.4 spawn(agent, prompt)

```text
optionally append durable trace row kind=spawn.requested
declare child run
parent blocks on child completion if caller awaits result
child handler executes independently after ownership
child terminal projection resolves parent completion
optionally append durable trace row kind=spawn.started, spawn.completed, or spawn.failed
```

### 6.5 spawn_all(tasks)

```text
optionally append durable trace row kind=spawn_all.requested
declare N child runs
declare aggregate completion kind=all_children
aggregate worker resolves when all child completions are terminal
parent resumes
optionally append durable trace row kind=spawn_all.completed or spawn_all.failed
```

### 6.6 execute(sandbox, input)

```text
optionally append durable trace row kind=execute.requested
declare execution work
win durable ownership before side effect
perform execution in higher runtime/provider layer
record output/result/failure
resolve completion if caller is awaiting result
optionally append durable trace row kind=execute.result or execute.failed
```

`execute` is the special case because it requires claim-first authority before
side effects, not just durable completion.

Tools, resources, middleware, and approval gates are not new substrate
primitives. They are higher-layer components/combinators over handler execution,
durable records, projections, and suspensions. For example, an approval gate is
modeled as a durable permission/required-action row plus an awakeable or
projection wait, not a hidden live callback.

## 7. Custom Events And Projections

Higher runtimes need a supported path for their own event streams and
projections to participate in the same durable machinery that drives substrate
core projections.

The first SDD should not freeze a concrete event-plane registration API.

The correct mental model is a materializer fold:

```text
Materializer<S> = (DurableRecord, S) -> S
fold durable event log -> derived projection state
```

The required capability is:

```text
higher runtime can define typed custom events
higher runtime can define projection reducers over those events
substrate stores and replays those events durably
substrate rebuilds custom projections with the same no-gap guarantees
DurableWaits.waitFor({ kind: "projection_match", ... }) can target registered custom projections
```

The substrate must not know ACP, Claude Code, Codex, or their session/event
schemas. The higher runtime owns event schemas, reducers, and protocol meaning.
Registered custom projections are non-authoritative read/trigger surfaces unless
their domain explicitly defines a durable authority rule. Do not use a projected
agent observation row as a hidden substitute for a durable completion, durable
claim, durable permission decision, or durable terminal row.

Do not add a generic reaction DSL in the first substrate surface. If
projection-to-work mapping becomes common enough, add a higher-level helper
later after real consumers prove the shape.

This section is intentionally limited to custom event/projection participation.
It does not define how projected state should automatically declare work.

## 8. Durable Streams State / StreamDB Boundary

The substrate should use these external primitives directly:

```text
Durable Streams
  append/read/follow ordered durable records

Durable Streams State
  materialize state rows from Durable Streams State envelopes
```

Durable Streams and Durable Streams State are implementation substrates, not the
API shape exposed to higher runtimes.

Higher runtime layers should not normally construct raw Durable Streams State
envelopes or call low-level append APIs. They should call semantic substrate
operations or register semantic work handlers.

The substrate must not reimplement semantics already provided by
`@durable-streams/state` or StreamDB.

Use Durable Streams State for:

- state change envelope shape;
- insert/update/delete operation semantics;
- snapshot/control events such as snapshot start/end/reset where supported;
- materialized state application;
- typed state schemas;
- primary-key extraction;
- collection registration.

Use StreamDB where reactive typed collections, query subscriptions, or
optimistic action plumbing are needed.

The substrate owns only the domain semantics layered above those primitives:

```text
DurableCompletion
DurableTrigger
Run
ReadyWork
handler operator routing
durable ownership
choreography mapping
```

The substrate may provide ergonomic wrappers around Durable Streams State and
StreamDB, but those wrappers must be thin and directly consumed by the semantic
APIs. They must not become a second projection engine, a second query system, or
a second state protocol.

For projection-triggered waits:

```text
Durable Streams State / StreamDB
  owns projection materialization and query/update mechanics

durable-agent-substrate
  owns wait declaration, snapshot-first/follow-after-cursor use, completion
  resolution, and ready-work routing
```

If Durable Streams State / StreamDB cannot provide the cursor/snapshot guarantee
needed for a wait, the substrate should surface a typed unsupported/no-gap error
instead of implementing an ad hoc projection protocol.

## 9. Implementation Plan

Build only one package until multiple consumers force boundaries.

Recommended phases:

```text
Phase 0: repo/package skeleton
Phase 1: internal durable records + Durable Streams State projection
Phase 2: DurableCompletion + Run stores internally
Phase 3: ReadyWork derivation internally
Phase 4: operator program invokes handler after ownership
Phase 5: Claim / Attempt rows and claim race proof
Phase 6: DurableWaits sleep/waitFor/awakeable and external DurableAwakeables
Phase 7: higher-layer choreography helpers schedule_me/spawn/spawn_all
Phase 8: generic integration proof plus Firepixel mapping sketch
```

Deferred from V1:

```text
durable side-effect memoization / DurableStep or equivalent
long-lived runtime process replay
ACP/stdio process recovery
custom event/projection registration API
projection-to-work helper DSL
```

### 9.1 Initial Repo Skeleton

Start with one package and one test suite:

```text
package.json
tsconfig.json
vitest.config.ts
src/
  index.ts
  records.ts
  runtime.ts
  work.ts
  waits.ts
  projections.ts
  ready-work.ts
test/
  durable-completion.test.ts
  operator-program.test.ts
  claim-race.test.ts
```

Initial dependencies:

```text
effect
@durable-streams/client
@durable-streams/server
@durable-streams/state
typescript
vitest
```

Acceptance for the skeleton:

```text
pnpm typecheck
pnpm test
```

No Firepixel dependency. No monorepo split.

### 9.2 Phase Acceptance Gates

Phase 1, internal records and projection:

```text
semantic operation
  -> internal Durable Streams State record
  -> projection materializes
  -> rebuild from zero yields same logical row
```

Phase 2, durable completion and run:

```text
run started
completion pending
run blocked on completion
rebuild
completion resolved
rebuild
```

Phase 3, ready work:

```text
blocked run + resolved completion
  -> ReadyWork contains run
```

Phase 4, operator program:

```text
ready work
  -> durable ownership won internally
  -> handler invoked once
  -> completed/failed terminal state recorded
```

Phase 5, claim race:

```text
two handler runners see same work
  -> each writes a Claim / Attempt row
  -> only one handler is invoked
  -> only winning owner terminalizes
  -> rebuild proves one terminal owner
```

Phase 6, waits/triggers:

```text
sleep / waitFor / awakeable
  -> durable trigger
  -> durable completion
  -> blocked run resumes through ready work
```

Deferred side-effect replay:

```text
future DurableStep service or equivalent
  -> durable step record
  -> replay returns recorded result
  -> external side effect is not re-run after completed step
```

### 9.3 Acai Spec Direction

The Acai specs under `features/durable-agent-substrate` are the executable
acceptance surface for this SDD. Current feature files:

```text
durable-records-and-projections
awakeables-and-runs
ready-work-projection
effect-native-api
semantic-producer
```

Spec ownership is intentionally orthogonal:

| Spec | Owns | Does not own |
| --- | --- | --- |
| `durable-records-and-projections` | Durable row/projection vocabulary, rebuild rules, no-gap projection boundaries, and the Durable Streams / Durable Streams State boundary. | Completion/run state-machine transitions, operator claim behavior, public Effect API shape, or producer ergonomics. |
| `awakeables-and-runs` | `durable.completion` and `durable.run` state machines, externally resolved awakeable semantics, no-live-callback truth, and no-stuck blocked runs. | Ready-work derivation, claim ownership, Effect API wiring, or Durable Streams protocol behavior. |
| `ready-work-projection` | `ReadyWorkProjection` derivation, claim-before-invoke, and operator terminalization after winning durable ownership. | Completion/run row definitions, semantic producer surface, or Effect service/layer style. |
| `effect-native-api` | Effect Schema, Effect service/layer shape, scoped operator program API, and no framework registry/fat context. | Durable state-machine behavior, projection rules, or package naming. |
| `semantic-producer` | Semantic producer operations for declaring durable work and resolving awakeables without exposing raw append/envelope APIs. | Row schema definitions, projection folds, operator behavior, or higher-level Fireline/Firepixel client design. |

Implementation tests should follow the same ownership. A test may reference
multiple ACIDs only when it is proving an integration boundary between those
features. Unit tests should avoid proving the same behavior through multiple
feature files.

Tests may use real Durable Streams and Durable Streams State dependencies, but
the assertion target must be substrate-owned behavior:

```text
good:
  semantic producer declares work
    -> durable.run projection rebuilds
    -> ready work derives only from resolved completion

bad:
  append one arbitrary Durable Streams record
    -> read returns the same arbitrary record
```

The second test only proves Durable Streams itself and belongs upstream, not in
this substrate package.

If future implementation work proves a need for finer granularity, split specs
from these current files without introducing Firepixel, Fireline, ACP, provider,
or CLI concerns into the substrate requirements.

### 9.4 Parallelization

The early work is intentionally sequential until the record and projection
contract is stable.

After Phase 2:

- Lane A: semantic operation encoding and projection rebuild.
- Lane B: operator program and claim race proof.
- Lane C: awakeable/timer/projection trigger helpers.
- Lane D: docs/spec alignment and Firepixel mapping sketches.

Do not parallelize ACP/runtime/provider work in this repo.

## 10. Anti-Patterns And Review Gates

Block these in implementation review:

- Firepixel manually constructs Durable Streams State envelopes for normal
  runtime behavior.
- Firepixel calls low-level completion/claim stores in normal runtime code.
- A handler runs before durable ownership is won.
- A durable session id is treated as live promptability.
- A permission wait is held only as an in-memory JS promise.
- `sleep`, `wait_for`, or `schedule_me` is implemented as only a timer callback
  without durable completion state.
- A choreography primitive suspends, fans out, or invokes externally visible
  work without first recording durable intent through a run, completion, or
  claim-attempt row.
- Ready work is treated as side-effect authority without a durable claim and
  ownership boundary.
- Timer firing is treated as prompt dispatch authority without a live
  promptability gate.
- Tools, resources, middleware, approval, or policy become hidden callbacks
  instead of components/combinators lowered into durable records and waits.
- The substrate imports Firepixel, ACP, CLI, provider, sandbox, or tool
  transport code.
- The first implementation creates multiple packages before there are real
  package boundaries.
- A generic reaction DSL is introduced before real consumers prove the shape.
- Custom event/projection support becomes an ACP-specific API.
- A feature cannot be explained by the round-trip rule: durable primitive plus
  combinator/fold.

## Appendix A. Prior Art

The substrate borrows semantics from durable execution systems, queues, and
event-sourced systems. These are semantic references, not dependencies.

| Prior art | Useful semantic | Substrate mapping |
| --- | --- | --- |
| Restate awakeables / durable promises | Suspend while an external actor resolves or rejects durable state. | public `Awakeable` API backed by internal `DurableCompletion`. |
| Temporal / Cadence | Durable history, deterministic replay, timers, signals, side effects outside deterministic workflow code. | durable records, triggers, replay discipline, side-effect claims. |
| Azure Durable Functions | Durable timers, external events, fan-out/fan-in. | `sleep`, `wait_for`, `spawn_all` resolution policies. |
| Inngest | TypeScript-native durable steps, sleep, and event waits. | semantic durable waits such as `sleep` and `waitForEvent`. |
| DBOS | Lightweight durable workflow state inside application code. | small app-local substrate before runtime server. |
| Airflow deferrable operators | Task defers until trigger fires, freeing workers. | run blocked on completion; trigger operator resolves completion. |
| Prefect interactive flows | Flow pauses for external input. | human approval / external awakeables. |
| BullMQ, Celery, Sidekiq | delayed jobs, ready queues, worker claiming, retry, terminal state. | ready work, handler operator routing, durable ownership. |
| Event sourcing / CQRS | append facts, rebuild projections, projections are not truth. | durable records and materializers. |
| Event-driven agent loops | Every user input, tool result, model chunk, approval, and interrupt is an event; UI, prompt memory, and persistence are separate projections. | durable event plane, materializers, handler operator routing, replayable tests. |
| Akka/Pekko Persistence and virtual actors | identity survives while live actor ownership is separate. | durable identity versus live ownership. |

The shared pattern:

```text
fact
  -> deterministic current view
  -> durable wait/trigger resolution
  -> ready work
  -> claimed handler execution
  -> terminal fact
```

## Appendix B. Firepixel Mapping Examples

This appendix is illustrative only. It is not substrate API.

### B.1 Generic Handler Execution

A higher runtime runs ordinary Effect handlers for semantic work kinds:

```ts
const markReady = (input: MarkReadyInput) =>
  Effect.succeed({
    id: input.id,
    ready: true
  })

const MarkReadyWorker = DurableWorkRunner.runTyped(
  {
    type: "operations.markReady",
    input: MarkReadyInput,
    output: MarkReadyOutput
  },
  markReady
)
```

The substrate does not know databases. It only knows:

```text
work was declared
operator claimed work
handler completed
```

External side-effect memoization is intentionally deferred from V1. The first
proof should show durable ownership, blocking, readiness, and completion without
also solving replay of live runtime/provider side effects.

### B.2 Firepixel Work Kinds

Firepixel may map its runtime concerns to substrate work kinds:

```text
launchAgent
  handler spawns an agent process after substrate ownership

promptAgent
  handler checks live promptability and sends prompt after substrate ownership

toolExecution
  handler runs tool/provider side effect after substrate ownership
```

The substrate proves work ownership. Firepixel still proves live promptability.

A durable session id alone is not live promptability.

Prompt chunks, ACP observations, process lifecycle rows, and provider evidence
are Firepixel-layer facts. They should live in Firepixel's runtime layer, not as
generic substrate APIs.

### B.3 ACP Permission Bridge

ACP protocol events are not substrate concepts. Firepixel owns the observation
bridge:

```text
ACP wire event
  -> Firepixel adapter parses and validates
  -> Firepixel maps to semantic substrate operation
  -> substrate records durable completion / work / awakeable
```

One possible mapping, if a Firepixel handler is already processing an ACP prompt:

```text
owned Firepixel prompt handler
  -> live ACP adapter reports permission request
  -> handler awaits DurableWaits.awakeable({
       name: permission:<sessionId>:<toolCallId>
     })
  -> handler is durably blocked
  -> approval UI resolves DurableAwakeables.resolve({ workId, name, result })
  -> handler resumes with the decision
  -> Firepixel maps the decision back to ACP response shape
```

This is only a semantic mapping. It does not require or standardize an
`onPermissionRequest` callback API. The substrate guarantee is that
`DurableWaits.awakeable(...)` is durable once a handler owns work.
Firepixel still owns the live ACP request/response mechanics and must decide
how those mechanics survive, retry, or fail across process loss.

Custom event/projection participation:

```text
ACP wire event
  -> Firepixel adapter records a typed permission_requested event
  -> Firepixel materializer projects firepixel.acp.tool_call pending
  -> Firepixel can wait on that projection with DurableWaits.waitFor(...)
  -> Firepixel can use its own application code to decide what to do next
```

The SDD does not currently define a projection-to-work API. That design space is
reserved for later.

The approval UI or policy engine resolves the awakeable:

```ts
yield* DurableAwakeables.resolve({
  workId,
  name: `permission:${sessionId}:${toolCallId}`,
  result: {
    outcome: "selected",
    optionId: "allow-once"
  }
})
```

This gives Firepixel the behavior it needs:

```text
ACP request is live adapter protocol
permission wait is a substrate awakeable created by an owned handler
ACP response is produced from durable resolution
```

The substrate should not inspect ACP frames, know `session/request_permission`,
or own ACP response formatting. It should provide the durable awakeable/wait
machinery that makes the adapter's wait recoverable.

If an adapter observes a permission request outside an owned handler invocation,
it should not call `DurableWaits.awakeable(...)` as a hidden callback.
It must first enter owned durable work through an application-defined path. The
SDD intentionally does not define that projection-to-work path yet.

## Appendix C. Open Questions

Keep these visible:

- Should `durable.completion` remain the native row family name, or should the
  first package make row names package-scoped, such as
  `durable_agent.completion`?
- What is the minimal durable trigger schema for projection-match waits without
  embedding non-replayable closures?
- Which Effect services should be stable public API versus internal
  implementation?
- What is the minimal custom event/projection extension point once real
  consumers prove the shape?
