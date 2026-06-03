> **HISTORICAL (pre-#765).** References paths deleted in #765 (packages/substrate, packages/host-sdk/src/host, and legacy packages/runtime/src/{subscribers,durable-tools,workflow-engine,agent-event-pipeline,agent-tools,runtime-host,composition}); kept for provenance. Current architecture: docs/cannon/.

# SDD: Firegrid Fireline Readiness

Status: Draft
Product: Firegrid
Related: `firegrid-runtime-process`, `durable-waits-and-scheduling`, `ready-work-projection`, `choreography-facade`, `claim-and-operator-authority`

Manual testing: `docs/FIRELINE_SCENARIO_TESTING_RUNBOOK.md`

## Summary

Firegrid is ready to validate the Fireline integration model at the happy-path
level. The next work should prove that Fireline can own a typed runtime
entrypoint, define its own operation and event descriptors, attach Firegrid's
durable runtime machinery, and complete a workflow through durable projection
state.

The top-line goal is not to patch every timeout or cancellation edge before
Fireline sees a working path. The top-line goal is to prove this shape:

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Firegrid, run } from "@firegrid/runtime"
import { RunWait, triggerMatchersLayer } from "@firegrid/substrate"
import { Effect } from "effect"

const runtime = Firegrid.composeRuntime({
  subscribers: [
    Firegrid.subscribers.projectionMatch({ evaluate }),
    Firegrid.subscribers.timer,
    Firegrid.subscribers.scheduledWork,
  ],
  handlers: [
    Firegrid.handler(FirelineShapedOperation, (input) =>
      Effect.gen(function* () {
        const wait = yield* RunWait
        yield* wait.for(approvalTrigger(input.requestId))
        return { requestId: input.requestId, approved: true }
      }),
    ),
  ],
  provide: [RunWait.layer({ streamUrl }), triggerMatchersLayer(matchers)],
})

NodeRuntime.runMain(run({ connection: { streamUrl }, runtime }))
```

Fireline should own descriptors, handlers, event streams, projection-match
evaluator logic, and product vocabulary. Firegrid should own durable execution,
runtime attachment, durable wait/schedule primitives, subscribers, ready-work
claiming, and terminal authorship.

The public service is `RunWait`. Higher-level workflow vocabulary is a product
or framework choice that Fireline, Firepixel, or another higher layer may make
on top of Firegrid. Firegrid teaches durable wait primitives, not a workflow
philosophy.

## What Already Works

The repo now proves these generic Firegrid paths:

1. started operation -> typed handler -> completed run,
2. typed handler failure -> failed run,
3. `waitFor` -> projection-match resolved completion -> ready-work resume,
4. `sleep` -> timer completion -> ready-work resume,
5. `scheduleWork` -> scheduled-work completion -> ready-work resume,
6. claim-before-side-effect arbitration,
7. schema-derived input scenario emitters,
8. app-owned runtime receivers through `run(...)`,
9. read-only scenario inspection.

The happy-path ingredients and receiver scenario for Fireline-shaped validation
already exist. Current follow-up work proves the same scenario can use the
runtime composition helper without weakening the explicit runtime graph.

## Current Runtime Boundary

- `@firegrid/runtime` exposes `run({ connection, runtime })`.
- Application code owns the process entrypoint and composes runtime Layers.
- `Firegrid.handler(Operation, handler)` installs started-run dispatch and
  ready-work resume for that operation.
- `Firegrid.subscribers.timer`, `Firegrid.subscribers.scheduledWork`, and
  `Firegrid.subscribers.projectionMatch({ evaluate })` are explicit Layers.
- `Firegrid.composeRuntime({ handlers, subscribers, provide })` is the
  preferred helper for readable app-owned runtime graphs when it can keep those
  handler, subscriber, and provider lists explicit.
- `run(...)` does not install implicit defaults.
- Runtime does not import `@firegrid/client`.
- Runtime does not discover app graphs through dynamic module loading.

## Public Primitive Boundary

The app-facing boundary is:

```ts
import { RunWait } from "@firegrid/substrate"

const wait = yield* RunWait
yield* wait.for(trigger)

Layer.provide(RunWait.layer({ streamUrl }))
```

`RunWait` is the service tag / namespace. `RunWait.layer(...)` is the
production Layer constructor. This keeps the app-facing API concrete while
avoiding the `Live` suffix in documentation aimed at Fireline consumers.

The lower-level kernel service can remain `DurableWaits` for now:

- `DurableWaits` authors durable completion rows.
- `RunWait` is what a running operation uses to suspend and resume through
  durable wait primitives.

## Current Scenario Boundary

- `scenarios/firegrid/scenario.ts` is the emit-only row contract.
- Input emitters expose schema-derived row streams and shared NDJSON writing.
- Receiver files are separate app-owned `run(...)` entrypoints.
- `inspect.ts` is a read-only projection inspector.
- Scenario validation may use app-like descriptor names, but Firegrid substrate
  rows remain product-neutral.

## Composition Helper Proof

The Fireline happy-path receiver uses `Firegrid.composeRuntime(...)` in
`scenarios/firegrid/src/receivers/fireline-shaped-receiver.ts`. That proof is
intentionally narrow:

- `subscribers` lists the projection-match subscriber explicitly;
- `handlers` lists the Fireline-shaped operation handler explicitly;
- `provide` lists `RunWait.layer({ streamUrl })` and
  `triggerMatchersLayer(...)` explicitly;
- no Fireline product rows, implicit subscribers, kernel imports, Choreography,
  or `DurableWaitsLive` are introduced.

The helper reduces `Layer.mergeAll(...).pipe(Layer.provide(...))` boilerplate
without changing the scenario's durable semantics.

## Non-Goals

- Do not add Fireline-specific durable row families to Firegrid.
- Do not add a Fireline adapter package in this repo.
- Do not add `@firegrid/client` imports to runtime or scenarios.
- Do not add dynamic runtime module loading.
- Do not add Firegrid-owned dev-server launchers.
- Do not add `test-support` folders or fixture infrastructure.
- Do not make `run(...)` install implicit subscribers.
- Do not solve every timeout, rejection, retry, or cancellation edge before the
  first Fireline-shaped happy path.

## Pathway 1: Fireline-Shaped Happy Path

### Purpose

Prove that Fireline can treat Firegrid like a typed durable runtime library:
Fireline owns the app process and product schemas; Firegrid provides the
durable execution substrate.

This should be the next implementation slice.

### Scenario Shape

Use neutral scenario names but model the Fireline pattern:

1. App-defined operation descriptor with typed input/output/error schemas.
2. App-defined EventStream descriptor representing an external approval or
   signal.
3. Input-side scenario emitter that writes:
   - one started operation row,
   - one matching app EventStream row.
4. Receiver entrypoint that composes:
   - `Firegrid.subscribers.projectionMatch({ evaluate })`,
   - optionally `Firegrid.subscribers.timer`,
   - optionally `Firegrid.subscribers.scheduledWork`,
   - one or more `Firegrid.handler(...)` Layers.
5. Handler that calls Firegrid durable wait primitives.
6. Projection-match evaluator owned by the scenario receiver.
7. Test that starts a Durable Streams test server, writes the schema-derived
   rows, runs the app-owned runtime, and inspects projection state.

### Expected Behavior

```txt
scenario emitter writes operation-started row
scenario emitter writes matching app EventStream row
runtime attaches through run(...)
projection-match subscriber resolves completion
ready-work operator resumes the blocked operation
handler continues after waitFor
runtime terminalizes the run as completed
inspect shows completed output and no remaining ready work
```

### Proposed Spec Additions

- `firegrid-runtime-process.SCENARIOS.13`: Fireline-shaped happy-path receiver
  validation composes app-owned operation descriptors, EventStream descriptors,
  projection-match evaluation, stock subscribers, and typed handlers through
  `run(...)` without Firegrid-owned product row families.
- `client-event-plane-registration.SUBSTRATE_SCOPE.5` or equivalent existing
  component: Firegrid scenario validation may define app-like EventStream
  descriptors, but Firegrid substrate rows remain product-neutral.

If no suitable existing component owns the second requirement, create the
smallest additive ACID in the existing event-plane/client registration feature.

### Implementation Surface

Expected files:

- `features/firegrid/firegrid-runtime-process.feature.yaml`
- possibly `features/firegrid/client-event-plane-registration.feature.yaml`
- `scenarios/firegrid/fireline-shaped.ts`
- `scenarios/firegrid/fireline-shaped-receiver.ts`
- `scenarios/firegrid/fireline-shaped-receiver.test.ts`
- `scenarios/firegrid/package.json`
- possibly `packages/substrate/src/coordination/run-wait.ts` or equivalent
- `packages/substrate/src/index.ts`
- `docs/SDD_FIREGRID_RUNTIME_CLI_VALIDATION.md`

### Acceptance

- The input-side emitter uses `defineScenarioRows` and shared row builders.
- The receiver uses `run({ connection, runtime })`.
- The runtime Layer composes only explicit app-selected Firegrid Layers.
- The scenario uses app-owned operation descriptors, EventStream descriptors,
  and evaluator code.
- The handler uses `RunWait.for(...)` on the happy path.
- The receiver provides `RunWait.layer({ streamUrl })` and does not import
  `@firegrid/substrate/kernel`.
- There is no `@firegrid/client` import.
- There is no dynamic module loading.
- There is no Fireline-specific substrate row family.
- The scenario terminalizes through projection inspection.
- The docs state that Fireline can build its real adapter outside this repo
  using the same pattern.

## Pathway 2: Fireline-Shaped Failure / Rejection Path

### Purpose

After the happy path is proven, prove the nearest product-relevant negative
path without jumping straight to timeout machinery.

The likely next path is app-level rejection:

```txt
started operation
external event says rejected / denied / failed
projection-match subscriber resolves the wait with matched rejection data
handler resumes and maps that value to a typed operation failure
runtime terminalizes the run as failed
```

This uses the already-shipped resolved-completion resume path. It avoids the
more invasive cancelled-completion ready-work question until we have Fireline's
actual UX semantics in hand.

### Prerequisite: `RunWait.for` result surface

FW1 ships `RunWait.for(trigger)` returning `void` on resume. That is sufficient
for Pathway 1 (happy path) where the only fact the handler needs is "the wait
completed". Pathway 2 needs more: the handler must read the *value* the
projection-match subscriber put in the resolved completion so it can map a
rejection / denial / failure signal into a typed operation error.

The substrate already records this value durably. The projection-match
subscriber writes the resolved completion as
`result: { matchedValue: <evaluator output> }`
(see `packages/substrate/src/execution/subscribers.ts`). What is missing is
the API to surface `matchedValue` to the resumed handler.

The agreed shape:

```ts
RunWait.for<T = void, E = void>(
  trigger: ProjectionMatchTrigger,
  options?: {
    readonly timeout?: Duration.DurationInput
    readonly resultSchema?: Schema.Schema<T, E>
  },
): Effect.Effect<T, never, CurrentWorkContext | TriggerMatchers>
```

Without `resultSchema` the resume returns `void` (Pathway 1 unchanged).
With `resultSchema` the resume reads `completion.result.matchedValue` and
decodes it; the handler receives the typed value
(`run-wait-primitives.RUN_WAIT_API.8`). Decode failures surface as
choreography-internal defects (`run-wait-primitives.RUN_WAIT_API.9`); they do
not silently swallow the resume or corrupt durable state.

The result-shape contract is codified in
`durable-waits-and-scheduling.WAIT_FOR.9` so the durable record stays a stable
reference across handler resume, inspectors, and replays.

This is a small additive capability slice. It must land before FW3 (Pathway 2
implementation); FW3 should remain draft/red until this capability is on
`main`.

### Proposed Spec Additions

- `firegrid-runtime-process.SCENARIOS.14`: Fireline-shaped rejection receiver
  validation resumes a typed handler from a resolved projection-match
  completion carrying app-level rejection data and terminalizes the run as a
  typed operation failure chosen by the app handler.
- `run-wait-primitives.RUN_WAIT_API.8` / `.9`: `RunWait.for` accepts an
  optional `resultSchema` and surfaces the decoded `matchedValue` on resume;
  decode failures are defects.
- `durable-waits-and-scheduling.WAIT_FOR.9`: the resolved projection-match
  completion's `result.matchedValue` is the canonical record of what satisfied
  the wait.

### Implementation Surface

Expected files:

- `features/firegrid/firegrid-runtime-process.feature.yaml`
- `features/firegrid/run-wait-primitives.feature.yaml`
- `features/firegrid/durable-waits-and-scheduling.feature.yaml`
- `packages/substrate/src/coordination/run-wait/service.ts`
- `packages/substrate/src/__tests__/choreography-service.test.ts`
- `scenarios/firegrid/fireline-rejection.ts`
- `scenarios/firegrid/fireline-rejection-receiver.ts`
- `scenarios/firegrid/fireline-rejection-receiver.test.ts`
- `scenarios/firegrid/package.json`
- `docs/SDD_FIREGRID_RUNTIME_CLI_VALIDATION.md`

### Acceptance

- Uses the same app-owned `run(...)` shape as Pathway 1.
- Uses schema-derived input rows through `scenario.ts`.
- Uses projection-match resolution, not timeout/cancellation.
- `RunWait.for(trigger, { resultSchema })` returns the decoded `matchedValue`.
- Without `resultSchema`, `RunWait.for` still returns `void` (Pathway 1 happy
  path remains unchanged — no regression for existing receivers).
- Handler maps the rejection signal to its operation error schema.
- Projection inspection proves the run failed with the app-chosen typed error.

## Later Edge: Timeout / Cancellation Resume

Projection-match timeout is already partially durable: a pending
`projection_match` completion with `deadlineAtMs` in the past can be cancelled
by the projection-match subscriber. What is not yet implemented is resuming a
blocked run from a cancelled completion.

That path is real and probably needed, but it should not block the first
Fireline-shaped happy path. Treat it as a later capability slice once Fireline's
timeout UX is clearer.

The eventual work is:

```txt
projection_match completion reaches deadline
subscriber appends cancelled durable.completion
blocked durable.run still points at that completion
ready-work projection derives timeout-resume work
runtime operator invokes the same handler
waitFor observes a typed timeout/cancellation outcome
app decides whether to recover, fail, or cancel
```

Likely future ACIDs:

- `ready-work-projection.READY_WORK_PROJECTION.12`: A blocked run whose
  referenced `projection_match` completion is cancelled with a timeout terminal
  reason derives timeout-resume work.
- `firegrid-runtime-process.READY_WORK_OPERATOR.8`: The runtime ready-work
  operator invokes the registered operation handler for timeout-resume work
  through the same claim-and-operator authority used for resolved ready work.
- `choreography-facade.CHOREOGRAPHY_API.15`: Re-invoking `waitFor` for the
  current run already blocked on a matching timeout-cancelled projection-match
  completion resumes the handler with a typed timeout outcome and does not
  author a duplicate completion.
- `durable-waits-and-scheduling.WAIT_FOR.9`: Projection-match timeout resume
  compares the existing completion to the requested wait by the same canonical
  trigger fields used for resolved resume.

## Sequencing

1. Land the scenario runner architecture first. This is FW0: not a layout-only
   move but a registry plus shared CLI/runner that defines scenarios as
   declarative typed values
   (`firegrid-runtime-process.SCENARIOS.15`). File-layout reorganizations of
   the scenarios package that do not deliver this contract do not satisfy
   FW0.
2. Land the `RunWait` primitive boundary in parallel or next (FW1). The
   acceptance bar is `run-wait-primitives.RUN_WAIT_API` plus
   `run-wait-primitives.BOUNDARY.4` and `.5`: app code only imports `RunWait`,
   never `@firegrid/substrate/kernel` / `ChoreographyLive` / `DurableWaitsLive`,
   and the documentation/examples surface stops teaching `Choreography` as
   the wait API.
3. Land Pathway 1 (Fireline happy path) on top of FW0 + FW1.
4. Land Pathway 2 (Fireline rejection path) next if we want a negative path
   before moving into Fireline.
5. Use the results to decide whether Fireline's first integration needs
   timeout resume immediately or can defer it.
6. Only then implement timeout/cancellation resume semantics.

The manual smoke commands and expected pass/fail signals for Pathway 1 and
Pathway 2 live in `docs/FIRELINE_SCENARIO_TESTING_RUNBOOK.md`
(`firegrid-runtime-process.SCENARIOS.17`). That runbook intentionally assumes
Durable Streams is started outside Firegrid and that all scenario commands route
through the FW0 runner architecture.

For PR reviewers: when reviewing FW0, FW1, or any Fireline-shaped scenario
PR, treat `firegrid-runtime-process.SCENARIOS.15` /`.16` and
`run-wait-primitives.BOUNDARY.4`/`.5` as the binding bars. A PR that moves
files without delivering the scenario runner contract, or that smuggles
`@firegrid/substrate/kernel` imports into app receivers, fails those ACIDs
even if its own commit message says "mechanical move" or "thin alias".

## Dispatch Notes

### Pathway 1: Fireline-Shaped Happy Path

Assign immediately. This should be mostly scenario code, docs, and spec ACIDs.
It should not change runtime/substrate internals unless a concrete missing
capability is discovered.

Hard constraints:

- use `scenarios/firegrid/scenario.ts`,
- use app-owned `run(...)`,
- no baseline edits,
- no `@firegrid/client`,
- no dynamic loaders,
- no dev-server launchers,
- no `test-support` folders,
- no product-specific substrate row families,
- no implicit subscribers in `run(...)`.

### Pathway 2: Fireline-Shaped Rejection Path

Assign after Pathway 1 or in parallel if it can reuse the same descriptor shape
without conflicting files. Keep it scenario-only and app-shaped.

Hard constraints:

- reuse the Pathway 1 shape where practical,
- do not implement timeout/cancellation resume,
- do not add Fireline product code to substrate/runtime packages.
