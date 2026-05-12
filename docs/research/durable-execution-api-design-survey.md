# Durable Execution API Design Survey

> **Historical (as of 2026-05-12):** research-only doc, pinned to its
> 2026-05-11 reference set. References to
> `managed-agent-runtime-target.md`,
> `stream-native-runtime-loop.SURFACE.*` ACIDs, and tracer-015 are
> intentionally preserved as the survey's frame of reference at that
> date. Current target architecture lives in
> `docs/architecture/managed-agent-runtime-target-durable-facts.md`;
> tracer 017 has since deleted the stream-native-runtime-loop scaffolding
> and `firegrid.runtime_ingress.accepted` row family this survey
> mentions.

Status: research recommendation, not accepted architecture.

Date: 2026-05-11

## Executive Recommendation

Firegrid should expose durable execution as a small set of domain-level Effect
programs over durable facts, not as a new generic `DurableLog` object protocol,
not as a workflow-specific endpoint surface, and not as a service registry. The
post-cutover primitive should stay visible at implementation boundaries:

```ts
const stream = DurableStream.define({
  endpoint: { url },
  schema: RuntimeIngressRowSchema,
})

stream.read({ live: false }).pipe(...)
stream.append(row)
stream.producer({ producerId })
```

The smallest next architecture is:

1. **Fact streams**: domain modules own row schemas, row constructors, durable
   IDs, and pure folds. Reads and writes use `effect-durable-streams` directly.
2. **Wait descriptors**: higher layers express waits as stable data:
   source identity, matcher identity, matcher parameters, cursor, timeout, and
   idempotency key. Do not persist arbitrary JavaScript predicates.
3. **Runtime operators**: runtime-host-owned programs scan durable facts, time,
   or projections and run/resume `@effect/workflow` workflows with
   deterministic execution IDs. Operators append follow-up facts through existing
   authority surfaces.
4. **Workflow waits**: inside workflows, use `@effect/workflow`
   `DurableClock`, `DurableDeferred`, `Activity`, and ordinary `Effect`
   composition. A durable fact operator resolves deferreds or appends outcome
   facts; external clients and tools do not launch private workflows.

This direction keeps Firegrid aligned with:

- `effect-native-production-cutover.RUNTIME_IO.1`
- `effect-native-production-cutover.RUNTIME_IO.2`
- `effect-native-production-cutover.GUARDRAILS.1`
- `effect-native-production-cutover.GUARDRAILS.2`
- `stream-native-runtime-loop.SURFACE.1`
- `stream-native-runtime-loop.SURFACE.2`
- `firegrid-platform-invariants.AUTHORITY.8`
- `firegrid-platform-invariants.PRODUCTION_SURFACE.5`
- `firegrid-agent-ingress.SUBSCRIBERS.1`
- `firegrid-reactive-workflow-operators.OPERATOR.1`
- `firegrid-reactive-workflow-operators.WORKFLOW.2`

The design should explicitly avoid a Firegrid clone of Inngest `createFunction`,
Temporal public workflow handles, or Restate service endpoints. Those systems
are useful references for ergonomics, but Firegrid's authority model is durable
facts first: clients append intent, host-owned operators react, and workflow
execution stays downstream of durable facts.

## Sources Reviewed

Firegrid:

- `docs/architecture/managed-agent-runtime-target.md`
- `docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md`
- `docs/tracers/010-workflow-backed-tools.md`
- `docs/tracers/012-agent-ingress-prompt-stream.md`
- `docs/tracers/013-reactive-workflow-operators.md`
- `docs/tracers/015-stream-native-runtime-loop-validation.md`
- `features/firegrid/effect-native-production-cutover.feature.yaml`
- `features/firegrid/firegrid-agent-ingress.feature.yaml`
- `features/firegrid/firegrid-platform-invariants.feature.yaml`
- `features/firegrid/firegrid-reactive-workflow-operators.feature.yaml`
- `features/firegrid/firegrid-required-actions.feature.yaml`
- Current code in:
  - `packages/effect-durable-streams/src/DurableStream.ts`
  - `packages/runtime/src/runtime-context/workflow.ts`
  - `packages/runtime/src/runtime-host/index.ts`
  - `packages/runtime/src/runtime-ingress/**`
  - `packages/runtime/src/runtime-operators/**`
  - `packages/runtime/src/required-action/**`

Requested Firegrid proposal docs `docs/proposals/SDD_FIREGRID_WORKFLOW_REACTOR.md`
and `docs/proposals/EFFECT_NATIVE_STREAMS.md` were not present in the current
worktree. The current survey therefore treats "reactor" vocabulary as
unaccepted framing and relies on the merged tracer/spec documents above.

Local Inngest source:

- `/Users/gnijor/gurdasnijor/inngest-skills/README.md`
- `/Users/gnijor/gurdasnijor/inngest-skills/ROADMAP.md`
- `/Users/gnijor/gurdasnijor/inngest-skills/AGENTS.md`
- `/Users/gnijor/gurdasnijor/inngest-skills/CLAUDE.md`
- `/Users/gnijor/gurdasnijor/inngest-skills/skills/inngest-durable-functions/SKILL.md`
- `/Users/gnijor/gurdasnijor/inngest-skills/skills/inngest-events/SKILL.md`
- `/Users/gnijor/gurdasnijor/inngest-skills/skills/inngest-steps/SKILL.md`
- `/Users/gnijor/gurdasnijor/inngest-skills/skills/inngest-flow-control/SKILL.md`
- `/Users/gnijor/gurdasnijor/inngest-skills/skills/inngest-realtime/SKILL.md`
- `/Users/gnijor/gurdasnijor/inngest-skills/skills/references/expressions.md`

External references are cited inline below.

## External Platform Comparison

| Platform | Useful API ideas to steal | Ideas to avoid in Firegrid | Why |
| --- | --- | --- | --- |
| Inngest | Event-triggered functions, stable event names, step IDs, `step.sleep`, `step.waitForEvent`, idempotency keys, concurrency scoped by keys, and explicit realtime UI channels. Inngest documents event waits with event name, timeout, and match expression, and its concurrency model excludes sleeps and event waits from active execution capacity. [waitForEvent](https://www.inngest.com/docs/reference/typescript/v3/functions/step-wait-for-event), [concurrency](https://www.inngest.com/docs/guides/concurrency) | Do not copy `createFunction` as Firegrid's public substrate API, CEL-like expression strings as the first matcher format, or product-level realtime channel semantics as runtime truth. | Firegrid already has durable facts as truth. Inngest's event and step ergonomics are valuable, but Firegrid should not center user-authored workflow endpoints or string expressions before named matchers are proven. |
| Temporal TypeScript | Deterministic workflow IDs, durable timers, child workflows, activity boundaries, and explicit message categories. Temporal documents Signals, Queries, Updates, timers that survive worker restarts, and child workflow start/result handles. [message passing](https://docs.temporal.io/develop/typescript/message-passing), [timers](https://docs.temporal.io/develop/typescript/timers), [child workflows](https://docs.temporal.io/develop/typescript/child-workflows) | Avoid exposing public workflow handles, Signals, Queries, or Updates as Firegrid client/runtime authority. Avoid making clients address private workflows directly. | Temporal is workflow-handle centered. Firegrid's invariant is the opposite for external clients: workflows react downstream to durable facts (`firegrid-platform-invariants.AUTHORITY.8`). |
| Restate | Durable handlers, workflows with durable promises, key-addressed stateful entities, external event/awakeable pattern, and durable timers. Restate's services page distinguishes Basic Services, Virtual Objects, and Workflows; external events use durable promises/awakeables; timers survive failures. [services](https://docs.restate.dev/foundations/services), [external events](https://docs.restate.dev/develop/ts/external-events), [timers](https://docs.restate.dev/develop/ts/durable-timers) | Avoid modeling Firegrid runtime streams as callable service handlers or virtual objects by default. Avoid making "signal workflow X" a public client API. | Restate's service model is a useful comparison, but Firegrid's current substrate is stream-first and Effect-native. Handler endpoints would reintroduce a control surface the tracers have been removing. |
| Trigger.dev | Task-level idempotency keys, child task dedupe, task queues, schedules with deduplication keys, and lifecycle hooks around waits/resumes. [idempotency](https://trigger.dev/docs/idempotency), [tasks](https://trigger.dev/docs/tasks/overview), [schedules](https://trigger.dev/docs/tasks/scheduled) | Avoid task-run SaaS vocabulary and global task registry as Firegrid runtime concepts. | Its idempotency-key scopes are directly relevant to `spawn` and `spawn_all`, but Firegrid should lower these to runtime-context/ingress/workflow facts rather than a separate task platform. |
| DBOS | Durable workflows as ordinary TypeScript functions, steps, workflow handles by ID, queues for flow control, and workflow communication with recommended timeouts. [workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial), [workflow communication](https://docs.dbos.dev/typescript/tutorials/workflow-communication), [architecture](https://docs.dbos.dev/architecture) | Avoid coupling Firegrid's durable semantics to SQL transactions or making database-backed queues the conceptual API. | DBOS is a strong proof that simple TS functions can express durable work, but Firegrid's durable substrate is Durable Streams plus Effect Workflow, not a database transaction runtime. |
| Hatchet | Event-triggered workflows, schedules, worker registration, built-in concurrency/rate-limit framing. [project repo](https://github.com/hatchet-dev/hatchet), [site](https://hatchet.run/) | Avoid adopting a separate worker SDK abstraction around all Firegrid operators. | Hatchet reinforces that users expect events, schedules, and concurrency policies, but Firegrid should first prove those as stream facts and runtime-host operators. |
| Effect / `@effect/workflow` | Keep `Effect`, `Stream`, `Sink`, `Scope`, `Layer`, `DurableClock`, `DurableDeferred`, `Activity`, and `Workflow.make/toLayer` visible. Effect docs describe streams as program descriptions producing zero or more values; resourceful streams handle scoped acquisition/release; Workflow exposes `execute`, `poll`, `resume`, `toLayer`; DurableClock and DurableDeferred provide durable sleep and external completion primitives. [streams](https://effect.website/docs/stream/introduction/), [resourceful streams](https://effect.website/docs/stream/resourceful-streams/), [Workflow](https://effect-ts.github.io/effect/workflow/Workflow.ts.html), [DurableClock](https://effect-ts.github.io/effect/workflow/DurableClock.ts.html), [DurableDeferred](https://effect-ts.github.io/effect/workflow/DurableDeferred.ts.html), [Activity](https://effect-ts.github.io/effect/workflow/Activity.ts.html) | Avoid a Firegrid object protocol that rewraps `Stream`/`Sink` just to look tidier. Avoid arbitrary service tags when the only dependency is an endpoint URL plus schema. | This is the closest match to Firegrid's post-#151 direction. The primary missing piece is durable fact matching/dispatch, not another stream abstraction. |

## Proposed Firegrid Vocabulary

Use concrete durable-data words. Avoid opaque names such as "Signal" or
"Reactor" unless a future accepted design deliberately maps them.

| Concept | Recommended term | Avoid | Notes |
| --- | --- | --- | --- |
| Durable row that can drive behavior | Durable fact | signal, event bus message | "Event" is acceptable for runtime output schema names already in protocol, but "fact" is better for generic operator inputs. |
| Schema-bound durable stream | Fact stream | DurableLog, EventStore service | The actual primitive remains `DurableStream.define({ endpoint, schema })`. |
| Stable source plus cursor | Fact source | subscription service | A source is a value or function describing where to read facts; it should not hide stream operations. |
| Predicate or projection eligibility | Fact match | Signal, CEL string | Matchers should be named/versioned and parameterized. Closures are local only. |
| Durable waiting request | Wait request | callback, promise URL | A wait request is a fact with matcher identity, cursor, deadline, and owner. |
| Durable waiting result | Wait outcome | completion authority | Outcome may be `matched`, `timed_out`, `cancelled`, or `failed`. |
| Consumer identity with progress | Subscriber | worker queue | This term already appears in `firegrid-agent-ingress.SUBSCRIBERS.*`. |
| Runtime program that reacts to facts/time | Operator | reactor | "Operator" is already spec-owned by `firegrid-reactive-workflow-operators.*`. |
| Host-owned execution of selected operators | Dispatcher | workflow endpoint | Dispatcher is a program, not a client surface. |
| User/agent input | Runtime ingress | prompt plane | Keep `runtime_ingress` for durable input authority. |
| Runtime process output | Runtime output | provider-wire | Keep provider-specific parsing downstream. |

## API Sketches

These sketches are intentionally small. They show where a domain API may exist
without hiding `DurableStream.define` at the implementation boundary.

### 1. Wait For Runtime Or Session Event

Call site:

```ts
const match = RuntimeOutputMatches.jsonLine({
  matcherId: "assistant.text.includes",
  version: 1,
  params: { text: "done" },
})

const event = yield* waitForRuntimeOutput({
  waitId: `wait:${contextId}:assistant-done`,
  contextId,
  source: "stdout",
  from: lastSeenCursor,
  match,
  timeout: "5 minutes",
})
```

Implementation shape:

```ts
export const waitForRuntimeOutput = (
  options: WaitForRuntimeOutputOptions,
) =>
  Effect.gen(function* () {
    const output = DurableStream.define({
      endpoint: { url: options.runtimeOutputStreamUrl },
      schema: RuntimeJournalEventSchema,
    })

    const deadline = yield* Deadline.fromDuration(options.timeout)

    return yield* output.read({
      live: "long-poll",
      offset: options.from,
    }).pipe(
      Stream.filter(row => row.type === "firegrid.runtime.output.stdout"),
      Stream.filter(row => row.event.contextId === options.contextId),
      Stream.filterMap(row => options.match(row).pipe(Option.map(() => row))),
      Stream.runHead,
      Effect.timeoutFail({
        duration: deadline.remaining,
        onTimeout: () => waitTimedOut(options.waitId),
      }),
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(waitStreamClosed(options.waitId)),
        onSome: Effect.succeed,
      })),
    )
  })
```

Design notes:

- The durable stream primitive is visible.
- A production version should record a wait request/outcome fact before
  suspension if missing/repeated work changes externally visible behavior.
- Matcher identity must be durable. The local predicate function should be
  derived from a named matcher and parameters, not persisted as code.

### 2. Wait For User Approval Or Required-Action Resolution

Current required-action code already proves the primitive:
`RequiredActionWorkflow` records a request, waits on `DurableDeferred`, and
`RequiredActions.resolve` records resolution before completing the deferred.
This aligns with:

- `firegrid-required-actions.WORKFLOW.1`
- `firegrid-required-actions.WORKFLOW.2`
- `firegrid-required-actions.WORKFLOW.3`
- `firegrid-required-actions.WORKFLOW.7`
- `firegrid-reactive-workflow-operators.WORKFLOW.2`

Recommended call shape:

```ts
const resolution = yield* requestRequiredAction({
  requiredActionId,
  runtimeContextId,
  requestKind: "tool_approval",
  subject: { type: "tool-call", id: toolCallId },
  prompt: "Approve file write?",
  expiresAt,
})
```

Workflow implementation should stay close to today's shape:

```ts
const token = yield* DurableDeferred.token(RequiredActionResolutionDeferred)

yield* requiredActionFacts.appendRequested({
  ...request,
  workflowDeferredToken: token,
})

const existing = yield* requiredActionFacts.get(request.requiredActionId)
if (existing.resolution !== undefined) return existing.resolution

const decision = yield* DurableDeferred.await(RequiredActionResolutionDeferred)
yield* requiredActionFacts.appendResolved(decision)
return decision
```

The cleanup opportunity is not to remove `DurableDeferred`; it is to decide
whether `RequiredActions` should remain an exported service or become a small
set of functions over an explicit stream URL. It is a domain API, not a generic
stream wrapper, so it is less risky than the deleted log wrappers. Still,
`firegrid-required-actions.BOUNDARY.5` says required-action topology must be
settled before more runtime features depend on it.

### 3. Schedule A Future Self-Prompt

Call site:

```ts
yield* scheduleSelfPrompt({
  scheduleId: `schedule:${contextId}:follow-up:${taskId}`,
  contextId,
  when: DateTime.unsafeMake("2026-05-11T18:00:00Z"),
  prompt: "Check whether the deployment finished.",
  idempotencyKey: `follow-up:${taskId}`,
})
```

Lowering:

```txt
scheduleSelfPrompt(...)
  -> append scheduled_prompt.requested fact
  -> scheduled-prompt operator observes durable time eligibility
  -> operator appends runtime_ingress.requested through host-owned ingress path
  -> runtime provider subscriber records delivery before stdin
```

Implementation sketch:

```ts
const scheduleStream = DurableStream.define({
  endpoint: { url: runtimeHostStreams.schedules },
  schema: ScheduledPromptRowSchema,
})

yield* scheduleStream.append(makeScheduledPromptRequestedRow(request))
```

Operator sketch:

```ts
const duePrompts = scheduleStream.read({ live: true }).pipe(
  Stream.filter(isRequested),
  Stream.filterEffect(row => DurableClock.sleep({
    name: `scheduled-prompt:${row.scheduleId}`,
    duration: millisUntil(row.when),
  }).pipe(Effect.as(row))),
)

yield* duePrompts.pipe(
  Stream.runForEach(row =>
    appendRuntimeIngress({
      contextId: row.contextId,
      kind: "message",
      authoredBy: "workflow",
      payload: { type: "text", text: row.prompt },
      idempotencyKey: row.idempotencyKey,
    }),
  ),
)
```

The real implementation should avoid one fiber per far-future prompt if scans
can become large. That is a scheduling-policy problem for a tracer, not a reason
to add a new durable-log wrapper.

### 4. Spawn Child Agent And Await Completion

Call site:

```ts
const child = yield* spawnAgent({
  parentContextId,
  childContextId: `ctx_child_${taskId}`,
  runtime: local.jsonl({
    argv: ["node", "child-agent.js"],
  }),
  prompt: "Summarize the retained deployment logs.",
  idempotencyKey: `spawn:${parentContextId}:${taskId}`,
})

const result = yield* awaitChildCompletion({
  childContextId: child.contextId,
  timeout: "30 minutes",
})
```

Lowering:

```txt
spawnAgent(...)
  -> append runtime_context row for child through runtime host/control surface
  -> append runtime_ingress.requested initial prompt
  -> startRuntime(childContextId) through host-owned runtime surface
  -> await child completion by watching control-plane run state or session projection
```

Implementation boundary:

```ts
const control = DurableStream.define({
  endpoint: { url: runtimeHostStreams.controlPlane },
  schema: RuntimeControlPlaneRowSchema,
})

const terminal = control.read({ live: "long-poll" }).pipe(
  Stream.filter(row => row.contextId === childContextId),
  Stream.filter(isTerminalRunRow),
  Stream.runHead,
)
```

Important constraint: `spawn` must call the same launch/runtime-context and
runtime-ingress authority surfaces clients use. It must not become a private
workflow launch API. This is exactly the distinction required by
`firegrid-platform-invariants.AUTHORITY.8`,
`firegrid-agent-ingress.BOUNDARY.5`, and
`firegrid-reactive-workflow-operators.INGRESS_CONSUMER.2`.

## Lower-Level Substrate Sketch

The substrate should stay boring:

```ts
type RuntimeFactStream<Row, Encoded> = {
  readonly name: string
  readonly endpoint: DurableStream.Endpoint
  readonly schema: Schema.Schema<Row, Encoded>
}

const defineRuntimeFactStream = <Row, Encoded>(
  spec: RuntimeFactStream<Row, Encoded>,
) =>
  DurableStream.define({
    endpoint: spec.endpoint,
    schema: spec.schema,
  })
```

This helper is optional and should be used only if it removes repeated
endpoint/schema pairing in one domain. It must not become public
`DurableLog<Row>`.

### Wait Request Rows

Use durable data for waits that must survive restart:

```ts
const WaitRequestRowSchema = Schema.Struct({
  type: Schema.Literal("firegrid.wait.requested"),
  waitId: Schema.String,
  ownerId: Schema.String,
  sourceId: Schema.String,
  matcherId: Schema.String,
  matcherVersion: Schema.Number,
  matcherParams: Schema.Unknown,
  cursor: Schema.optional(Schema.String),
  timeoutAt: Schema.optional(Schema.String),
  idempotencyKey: Schema.String,
  createdAt: Schema.String,
})

const WaitOutcomeRowSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("firegrid.wait.matched"),
    waitId: Schema.String,
    matchedFactId: Schema.String,
    matchedAt: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("firegrid.wait.timed_out"),
    waitId: Schema.String,
    timedOutAt: Schema.String,
  }),
)
```

Open question: whether these rows belong in `@firegrid/protocol`, runtime, or a
future wait package. Do not implement this until a tracer settles ownership.

### Matching

Do not persist a predicate function:

```ts
interface FactMatcher<Row, A> {
  readonly matcherId: string
  readonly version: number
  readonly params: A
  readonly match: (row: Row) => Option.Option<Row>
}
```

Only `matcherId`, `version`, and `params` are durable. The runtime operator
process loads a matcher registry from code, but the registry is host-owned
configuration, not a client request field. If a matcher is missing or upgraded
incompatibly, the operator should append a typed failure/gap row rather than
silently skipping the wait.

### Dispatcher/Operator

The current `ReactiveWorkflowOperator` is the right first cut but too
snapshot-array oriented for future waits:

```ts
interface OperatorSource<Fact> {
  readonly sourceId: string
  readonly scan: Effect.Effect<ReadonlyArray<Fact>, E, R>
}
```

The next version should support stream-native sources:

```ts
interface FactOperator<Fact, Payload, E, R> {
  readonly operatorId: string
  readonly sourceId: string
  readonly facts: Stream.Stream<Fact, E, R>
  readonly select: (fact: Fact) => Option.Option<Payload>
  readonly executionId: (payload: Payload) => string
  readonly execute: (input: {
    readonly payload: Payload
    readonly executionId: string
  }) => Effect.Effect<string, E, WorkflowEngine.WorkflowEngine | R>
}
```

This keeps stream operations visible and avoids `collect -> array -> loop` as
the default operator shape.

## Migration And Cleanup Plan From Post-#151 Code

### Necessary Domain Code

- `packages/runtime/src/runtime-ingress/schema.ts`
- `packages/runtime/src/runtime-ingress/ids.ts`
- `packages/runtime/src/runtime-ingress/rows.ts`

These are the right shape: schema, IDs, and row constructors. They support
`firegrid-agent-ingress.INGRESS.1`,
`firegrid-agent-ingress.INGRESS.3`, and
`firegrid-agent-ingress.DELIVERY.3`.

- `packages/runtime/src/runtime-context/workflow.ts`

This is now carrying direct DurableStream read/write logic for runtime output
and pending ingress. That is acceptable immediately after the cutover because
it avoids wrappers. It should not grow into a second runtime loop framework.
Future cleanup should extract only real domain programs, such as
`pendingIngressForSubscriber`, if they are reused by more than the local-process
provider path.

- `packages/runtime/src/runtime-host/index.ts`

Host-owned topology and `appendRuntimeIngress` belong here today. The direct
`DurableStream.define` usage is consistent with the cutover. If more ingress
writers appear, extract a narrow `appendRuntimeIngressRequestToStream` program
only if it remains domain-named and schema-bound.

- `packages/runtime/src/required-action/**`

Required actions are a real domain, not a generic stream wrapper. However,
`RequiredActionsLive`, `RequiredActionRuntimeLive`, and `RequiredActionStateLive`
still expose service/layer shapes. That may be justified for workflow
integration, but it should be explicitly decided before tracer 010 or more
required-action consumers land. Relevant ACIDs:
`firegrid-required-actions.RECORDS.4`,
`firegrid-required-actions.BOUNDARY.5`,
`firegrid-required-actions.BOUNDARY.6`, and
`firegrid-reactive-workflow-operators.REQUIRED_ACTION_CONSUMER.1`.

### Historical Baggage Or Drift

- `packages/runtime/src/stream-native-runtime-loop/**`

This remains useful as a validation artifact for tracer 015. After the
production cutover has enough scenario coverage, consider retiring it or moving
it to scenario/test-only proof code so it does not look like a second runtime
loop API.

- `docs/tracers/012-agent-ingress-prompt-stream.md`

This doc still describes a service/subscriber shape that existed before the
cutover. It should be revised to say runtime ingress is now schema/ids/rows plus
host-owned direct `DurableStream` programs. It should keep the durable ingress
model and subscriber ACIDs.

- `docs/tracers/015-stream-native-runtime-loop-validation.md`

This doc is historically accurate but still includes old banned import examples
and old service names in setup context. Add a note that PR #151 completed the
cutover and that the validation module is no longer the target production shape.

- `docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md`

The production module examples mention `runtime-ingress/stream.ts`,
`runtime-ingress/folds.ts`, and `runtime-output/stream.ts`. The final accepted
cutover intentionally deleted those wrapper-shaped files. Update this SDD so
it describes the final row/schema/direct-program shape, not the mid-review
helper-file shape.

- `docs/architecture/managed-agent-runtime-target.md`

The top-level target now correctly names `effect-durable-streams`, but it still
contains future package-family and workflow wait examples that can be read as
endorsing public workflow handles. Clarify that sleep/wait/spawn are runtime
capability APIs lowered to durable facts and operators, not direct client
workflow invocation.

## Tracer Recommendations

Do not dispatch another feature tracer before the wait/operator design decision
is recorded. Then run these high-signal tracers.

### Tracer A: Durable Fact Wait Descriptor

Goal: prove a named matcher over runtime-output facts with durable wait request
and outcome rows.

Scenario:

```txt
FiregridRuntimeHostLive
  -> start real local process that emits stdout JSONL after delay
  -> append wait.requested with matcherId/version/params and cursor
  -> operator scans runtime-output through DurableStream.read
  -> wait.matched row is appended
  -> waiting workflow resumes through DurableDeferred or workflow resume
```

Must prove:

- scenario-level E2E using production package surfaces
- timeout terminal row
- matcher missing/version mismatch expected failure
- rescan idempotency

Relevant ACIDs:

- `firegrid-platform-invariants.PRODUCTION_SURFACE.5`
- `firegrid-reactive-workflow-operators.OPERATOR.1`
- `firegrid-reactive-workflow-operators.REPLAY.1`
- `firegrid-reactive-workflow-operators.REPLAY.3`
- `firegrid-reactive-workflow-operators.WORKFLOW.2`

### Tracer B: Scheduled Runtime Ingress

Goal: prove `schedule_me(when, prompt)` lowers to durable schedule facts and
host-owned runtime ingress, not a private prompt endpoint.

Scenario:

```txt
workflow/tool appends scheduled_prompt.requested
  -> schedule operator waits on durable time
  -> operator appends runtime_ingress.requested via host ingress surface
  -> local-process provider receives stdin once
  -> runtime-output proves the prompt was delivered
```

Must prove:

- delivery progress before provider-visible stdin
- restart/rescan does not deliver duplicate prompt
- no client-supplied stream topology

Relevant ACIDs:

- `firegrid-agent-ingress.INGRESS.2`
- `firegrid-agent-ingress.HOST.1`
- `firegrid-agent-ingress.SUBSCRIBERS.1`
- `firegrid-agent-ingress.SUBSCRIBERS.2`
- `firegrid-reactive-workflow-operators.INGRESS_CONSUMER.3`

### Tracer C: Child Agent Spawn Lowering

Goal: prove `spawn(agent, prompt)` lowers to the same runtime context and
runtime ingress authority surfaces used by clients.

Scenario:

```txt
parent workflow emits spawn request fact
  -> spawn operator creates/starts child runtime context through host start path
  -> appends initial runtime ingress
  -> child local process exits
  -> parent awaits child terminal state from durable control/runtime facts
```

Must prove:

- deterministic child context/launch ID from idempotency key
- duplicate spawn request does not create duplicate child runtime
- child completion wait uses durable facts/projection, not private workflow
  handle exposed to clients

Relevant ACIDs:

- `firegrid-platform-invariants.AUTHORITY.8`
- `firegrid-agent-ingress.BOUNDARY.5`
- `firegrid-reactive-workflow-operators.OPERATOR.4`
- `firegrid-reactive-workflow-operators.INGRESS_CONSUMER.2`
- `firegrid-durable-launch-runtime-operator.RUNTIME_HOST.3`

## Risks And Open Questions

### Predicate Serialization

Persisting arbitrary JavaScript predicates is a non-starter. The minimum safe
shape is named matcher + version + params. Future matchers need:

- stable IDs and versioning
- explicit decode errors
- compatibility policy when matcher code changes
- a way to surface "matcher unavailable" as an expected durable failure

### Cursor And Checkpoint Ownership

For one-off waits, the wait request can own its starting cursor. For ongoing
operators, the subscriber/operator must own durable progress when replaying work
would change visible behavior. This follows
`firegrid-reactive-workflow-operators.REPLAY.4` and
`firegrid-agent-ingress.SUBSCRIBERS.2`.

### Idempotency Keys

Firegrid should copy Trigger.dev's clarity around key scope, but use Firegrid
terms:

- `owner` scope: unique under workflow/operator execution
- `context` scope: unique under runtime context
- `global` scope: unique under stream/topology

Do not implement these names without a tracer. The immediate rule is that every
spawn/schedule/wait request has a deterministic ID and a documented duplicate
fold.

### Ordering

Durable stream order or explicit durable sequence is the ordering source. Do
not use wall-clock timestamps for delivery order. This aligns with
`firegrid-agent-ingress.INGRESS.4`.

### Timeouts

Timeouts must be durable terminal facts when timeout changes externally visible
state. In-workflow `DurableClock.sleep` is sufficient for private workflow
timers, but runtime-visible waits need timeout rows so downstream consumers and
rescans agree on the winner.

### Exactly Once

Firegrid should continue to avoid exactly-once external side-effect claims.
The target is at-least-once delivery with deterministic IDs, durable progress
before provider-visible side effects, and first-terminal-wins folds. This is
already captured by `firegrid-platform-invariants.SECURITY.6`.

### Live Boundaries And Retention Gaps

Operators must know whether they scanned retained state before side effects.
If a retained stream cannot prove no-gap snapshot/follow behavior, the operator
must surface a typed gap instead of silently starting at latest. This is
`firegrid-reactive-workflow-operators.REPLAY.5`.

### Concurrency

Inngest's important lesson is that sleeping/waiting should not consume active
execution capacity. Firegrid should express this through workflow suspension
and operator-driven wakeups, not by holding process-local fibers for every
future wait. Effect fibers are cheap, but durable waits must survive host death.

## Recommended Immediate Target-Doc Edits

Do not rewrite code yet. Update target architecture docs to reflect these
accepted post-cutover realities:

1. In `docs/architecture/managed-agent-runtime-target.md`, state that
   `sleep`, `wait_for`, `schedule_me`, `spawn`, and `spawn_all` are runtime
   capability APIs lowered to durable facts/operators, not direct client
   workflow launch or workflow-handle APIs.
2. In `docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md`,
   replace mid-review helper-file examples with the final pattern:
   schema/ids/rows plus direct `DurableStream.define` programs.
3. In `docs/tracers/012-agent-ingress-prompt-stream.md`, remove references to
   `runtime-ingress/service.ts` as target architecture. Keep the durable ingress
   and subscriber requirements.
4. Add a new SDD or tracer preface for "Durable Fact Waits" before implementing
   `wait_for`, scheduling, or child spawn.
5. If "Workflow Reactor" remains a desired term, add a source-of-truth SDD. If
   not, standardize on "runtime operators" and "dispatchers" because that term
   already has specs and code.

