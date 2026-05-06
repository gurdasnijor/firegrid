# SDD: Firegrid Fireline Readiness

Status: Draft
Product: Firegrid
Related: `firegrid-runtime-process`, `durable-waits-and-scheduling`, `ready-work-projection`, `choreography-facade`, `claim-and-operator-authority`

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
import { RunWait } from "@firegrid/substrate"
import { Effect, Layer } from "effect"

const runtime = Layer.mergeAll(
  Firegrid.subscribers.projectionMatch({ evaluate }),
  Firegrid.subscribers.timer,
  Firegrid.subscribers.scheduledWork,
  Firegrid.handler(FirelineShapedOperation, (input) =>
    Effect.gen(function* () {
      const wait = yield* RunWait
      yield* wait.for(approvalTrigger(input.requestId))
      return { requestId: input.requestId, approved: true }
    }),
  ),
).pipe(Layer.provide(RunWait.layer({ streamUrl })))

NodeRuntime.runMain(run({ connection: { streamUrl }, runtime }))
```

Fireline should own descriptors, handlers, event streams, projection-match
evaluator logic, and product vocabulary. Firegrid should own durable execution,
runtime attachment, durable wait/schedule primitives, subscribers, ready-work
claiming, and terminal authorship.

The proposed public service is `RunWait`. The current repo calls the nearest
service `Choreography`, but that name is too high-level for the Firegrid layer.
Choreography and orchestration are product or framework choices that Fireline,
Firepixel, or another higher layer may make on top of Firegrid. Firegrid should
teach durable wait primitives, not a workflow philosophy.

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

The happy-path ingredients for a Fireline-shaped validation already exist. The
missing work is a scenario that composes them into one app-shaped workflow.

## Current Runtime Boundary

- `@firegrid/runtime` exposes `run({ connection, runtime })`.
- Application code owns the process entrypoint and composes runtime Layers.
- `Firegrid.handler(Operation, handler)` installs started-run dispatch and
  ready-work resume for that operation.
- `Firegrid.subscribers.timer`, `Firegrid.subscribers.scheduledWork`, and
  `Firegrid.subscribers.projectionMatch({ evaluate })` are explicit Layers.
- `run(...)` does not install implicit defaults.
- Runtime does not import `@firegrid/client`.
- Runtime does not discover app graphs through dynamic module loading.

## Public Primitive Boundary To Resolve

Effect conventionally uses a service tag plus a `Live` Layer constructor for
the production implementation. In the current repo:

- `Choreography` is the service tag.
- `ChoreographyLive` is the production Layer for the service.
- `DurableWaitsLive` is the production Layer for the lower-level durable waits
  service.

The `Live` suffix is ordinary Effect vocabulary. The issue is the concept and
the export boundary. `Choreography` implies a higher-level workflow model, and
`DurableWaitsLive` is only available through `@firegrid/substrate/kernel`.
Because the current service methods require durable waits, examples that import
`DurableWaitsLive` from `kernel` teach app code to depend on a lower-level
boundary.

Pathway 1 should not hide this. It should introduce the app-facing boundary:

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

The existing `Choreography` / `ChoreographyLive` surface should be treated as
current vocabulary to retire or alias away, not the concept Firegrid teaches to
Fireline.

## Current Scenario Boundary

- `scenarios/firegrid/scenario.ts` is the emit-only row contract.
- Input emitters expose schema-derived row streams and shared NDJSON writing.
- Receiver files are separate app-owned `run(...)` entrypoints.
- `inspect.ts` is a read-only projection inspector.
- Scenario validation may use app-like descriptor names, but Firegrid substrate
  rows remain product-neutral.

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

### Proposed Spec Additions

- `firegrid-runtime-process.SCENARIOS.14`: Fireline-shaped rejection receiver
  validation resumes a typed handler from a resolved projection-match
  completion carrying app-level rejection data and terminalizes the run as a
  typed operation failure chosen by the app handler.

### Implementation Surface

Expected files:

- `features/firegrid/firegrid-runtime-process.feature.yaml`
- `scenarios/firegrid/fireline-rejection.ts`
- `scenarios/firegrid/fireline-rejection-receiver.ts`
- `scenarios/firegrid/fireline-rejection-receiver.test.ts`
- `scenarios/firegrid/package.json`
- `docs/SDD_FIREGRID_RUNTIME_CLI_VALIDATION.md`

### Acceptance

- Uses the same app-owned `run(...)` shape as Pathway 1.
- Uses schema-derived input rows through `scenario.ts`.
- Uses projection-match resolution, not timeout/cancellation.
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

1. Land Pathway 1 first. This is the Fireline happy-path smoke test.
2. Land Pathway 2 next if we want a negative path before moving into Fireline.
3. Use the results to decide whether Fireline's first integration needs timeout
   resume immediately or can defer it.
4. Only then implement timeout/cancellation resume semantics.

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
