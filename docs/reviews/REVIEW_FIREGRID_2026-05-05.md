# Firegrid Repo Review — 2026-05-05

Review scope: `packages/{substrate,client,runtime,lab}` against the SDDs in
`docs/` and feature specs in `features/`.

Goals (per request):

1. Overall complexity vs. the SDDs — are we over-built relative to the spec?
2. Idiomatic Effect.ts / TypeScript usage.
3. Code quality / DRY / missing abstractions.
4. Public API ergonomics for `@firegrid/client` and `@firegrid/substrate`.
5. Operational concerns, correctness gaps, test coverage.

The repo is in solid shape overall. The architecture is coherent, the runtime
is genuinely thin, and recent migration work (handoff doc 2026-05-05) is real.
The findings below are about turning a working v1 into a v1 we can hand to
external consumers without caveats.

Source-of-truth document for each claim is cited inline as `path:line`.

---

## Headline findings

| # | Severity | Theme | Summary |
|---|---|---|---|
| H1 | High | API surface | `packages/client/src/index.ts` re-exports legacy kernel vocabulary at the package root in violation of SDD §"Client Constraints". |
| H2 | High | API surface | Two parallel root APIs (`SubstrateClient` and `FiregridClient`) with two `Live` factories, two configs, and two physical Tag definitions joined by `as unknown as` (`operation-client.ts:160`). |
| H3 | High | Effect idiomaticity | Substrate uses two service idioms in one package (`Effect.Service` for producers, `Context.Tag + Live` for everything else). Direct violation of SDD §"Effect Type Conventions" item 3. |
| H4 | High | Operational | Three production hot paths call `rebuildProjection` per RPC (`waits.ts:findExisting`, `producer.ts:loadCurrent`, `client/work.ts:snapshotEffect`). The hot-path SDD invariant has no test guarding it. |
| H5 | High | Operational | `lab/RawStreamInspector.tsx:36-77` leaks the durable-streams session on unmount/streamUrl change. |
| M1 | Med | Complexity | `choreography/tools.ts` (290 LOC) ships an agent-tool dispatch harness inside the substrate kernel. Belongs in runtime or its own package per SDD §"Substrate Constraints". |
| M2 | Med | DRY | 7 repeats of `new DurableStream(...) → tryPromise(append(JSON.stringify(...))) → mapError`; 3 copies of `acquireDb`; 3 copies of `tryBuild` for state-machine builders; 3 copies of `authoritativeRun`. |
| M3 | Med | Effect idiomaticity | 11 public `extends Error` classes still hand-roll `_tag`; newer modules use `Data.TaggedError`. Mechanical migration. |
| M4 | Med | Effect idiomaticity | `runner.ts` and `operation-handler.ts` reimplement `Stream.async` with `Effect.makeLatch + forever + race(deadline)`. The materializer in the same package is the textbook version. |
| M5 | Med | Coverage | `bin/firegrid.ts`, `runner.ts`, `operation-handler.ts` (beyond a single happy path), and all React lab components have no behavioral tests. |
| M6 | Med | Migration | EventPlane → EventStream is mid-flight: external descriptor done, internal plumbing still calls itself `event-plane`. Two parallel projection facades exist (`facade/projection.ts` vs `event-plane/projection.ts`). |
| M7 | Med | Schema | Canonical `schema/` module misses the operation/event-stream envelope helpers (they live in `descriptors/`) and the row builders (they live in `state-machine.ts`). |
| L1 | Low | Correctness | `FiregridClient.send/call` drops `idempotencyKey`; SDD requires "Support idempotent send/call" (`operation-client.ts:259`). |
| L2 | Low | Effect idiomaticity | `Effect.try({ catch: (cause) => cause })` at `operation-handler.ts:139, 173` collapses the error channel to `unknown`. |
| L3 | Low | Effect idiomaticity | Substrate kernel imports `node:crypto` directly in 4 modules. Use a `Random`/UUID service for portability. |
| L4 | Low | Ergonomics | `FiregridClientConfig.clientId` required in one declaration, optional in another (`event-client.ts:27` vs `client/service.ts:22`). |
| L5 | Low | Ergonomics | `firegrid/index.ts` subpath re-exports only EventStream half; lab consumers get a partial API. |

Severity legend: **H** = ship-blocking for external users / operational risk,
**M** = significant code quality / architecture debt, **L** = small polish.

---

## 1. Complexity vs. the SDDs

The SDDs are tighter than the implementation in three specific places.

### 1a. Choreography tooling lives in the kernel

`packages/substrate/src/choreography/tools.ts` (290 LOC) bundles agent-tool
dispatch (sleep/waitFor/scheduleMe/awakeable as named tool bindings with
schema inputs and a verification dance for interrupt-as-suspension semantics)
into the substrate package. SDD §"Substrate Constraints" says substrate must
not "Know Fireline, Firepixel, ACP, MCP, session, prompt, provider, sandbox,
or model-specific schemas as native row families." Agent tool dispatch is one
breath away from that list.

The `ChoreographyTimeout` error (`choreography/errors.ts:14-21`) is exported
publicly but never raised internally — the file comment admits it is
"reserved for host-runtime use without a v1-internal raise path." That is
dead surface area on a public package root.

The Choreography service itself does its own `started → blocked` row write,
re-reads retained records to verify, and `Effect.interrupt`s
(`choreography/service.ts:155-254`). The SDD §6 makes the runner the writer
of that block row, leaving Choreography as the suspension primitive. As
written, Choreography has two concerns — declare wait *and* block run.

**Recommendation:**
- Extract `choreography/tools.ts`, `ChoreographyTools*`, `*ToolInput`
  schemas, and `ChoreographyTimeout` into either `@firegrid/runtime` (best
  fit) or a new `@firegrid/choreography-tools` package.
- Move block-row authority back into the operator/runner; Choreography keeps
  only the create-completion-then-suspend primitive and the `TriggerMatchers`
  registry.

### 1b. Two parallel projection facades

`facade/projection.ts` (155 LOC) and `event-plane/projection.ts` (194 LOC)
implement `acquireDb` + `snapshot` + `stream` + `until` in nearly identical
shape, with twin error classes (`ProjectionReadError` vs
`PlaneProjectionReadError`) and twin Tags. The substrate "should expose
low-level APIs" but it should expose them once.

**Recommendation:** A single `Projection<S>` parameterized over the state
schema, used by both the facade and the event-plane runtime layer. Estimated
~150 LOC removed.

### 1c. Operator outcome variants

`operator.ts:121-226` (`processReadyWorkItem`) returns `{ kind: "claim-lost"
| "already-terminal" | "terminalization-lost" | "performed", ... }`. The SDD
contract is "claim-before-invoke" — `runTyped(...) → Effect<void, E, R>`. The
four-variant outcome made it to the public surface; `facade/work.ts:25-33`
already invented the right factoring (`Performed`/`Recorded`).

**Recommendation:** Decompose `processReadyWorkItem` into the same `claim →
perform → record` pipeline `facade/work.ts` uses, and keep the variant
enum internal.

### 1d. What is not over-built

The runtime package (~1300 LOC source) is genuinely thin:
`bin/firegrid.ts` correctly uses `@effect/platform` `Command`, `Terminal`,
and `NodeRuntime.runMain`; `runtime/firegrid.ts` matches the SDD's `handler /
eventStream / runtimeLayer / subscribers.{timer,scheduledWork}` namespace;
`runtime → client` back-dependency is gone; `withHost` is gone. The lab is
correctly read-only-by-default with one bridge file at the React boundary.
These are the right shapes.

---

## 2. Effect.ts idiomaticity

Reviewed against `effect.website/llms.txt`. The codebase is generally
correct, but the substrate package shows the seams of being written across
two eras of Effect API.

### 2a. Service idioms must be unified inside substrate

SDD §"Effect Type Conventions" item 3: each package picks one convention
consistently.

- `Effect.Service`: `WorkProducer`, `CompletionProducer` (`producer.ts:43, 110`).
- `Context.Tag` + manual `Live`: `DurableWaits` (`waits.ts:88`),
  `Choreography` (`choreography/service.ts:110`), `WorkClaim`
  (`facade/work.ts:53`), `Projection` (`facade/projection.ts:57`),
  `CurrentWorkContext` (`choreography/context.ts:21`), `TriggerMatchers`
  (`choreography/triggers.ts:60`).

Pick one. Recommendation: `Context.Tag + Live` for the kernel (consistent
with the rest), reserving `Effect.Service` for higher-level ergonomic
services. Or migrate everything to `Effect.Service`. Either is fine; doing
both is the violation.

### 2b. Eleven kernel error classes still extend Error

Newer modules use `Data.TaggedError`; the kernel does not. List:

```
substrate/retained-records.ts:17        RetainedReadError
substrate/waits.ts:78                   WaitsStreamError
substrate/state-machine.ts:56,67        IllegalCompletionTransition,
                                        IllegalRunTransition
substrate/producer.ts:25,32             ProducerStreamError,
                                        CompletionNotFoundError
substrate/operator-errors.ts:8,16,23    ClaimStreamError,
                                        ClaimMissingCursorError,
                                        ClaimWinnerMissingError
substrate/operator.ts:66                RunNotFoundError
substrate/choreography/service.ts:55    ChoreographyVerificationError
```

Mechanical PR. `Data.TaggedError` removes the hand-rolled `_tag` field and
gives structural equality.

### 2c. Re-implemented `Stream.async`

`runner.ts:97-140` and `operation-handler.ts:94-208` build subscriber loops
with `Effect.makeLatch(false)` + `Effect.forever` + a manual
`subscribeChanges` callback + `Effect.race(latch.await,
Effect.sleep(deadline))`. The materializer in the same package
(`event-stream-materializer.ts:145-167`) shows the correct shape:
`Stream.async` with the cancel-callback returned, then `Stream.filter` →
`mapEffect` → `runForEach`.

This is the clearest "holding the hammer wrong" case in the repo.
Consolidating these three loops into a shared `Stream`-based subscriber
helper saves ~80 LOC and gives backpressure / cancellation for free.

### 2d. Other Effect anti-patterns

- `Effect.try({ catch: (cause) => cause })` at `operation-handler.ts:139,
  173` types the error channel as `unknown` and loses tag info. Match the
  `tryBuild` pattern at `producer.ts:147-154`.
- `as unknown as Context.Tag<...>` at `operation-client.ts:160-163` widens a
  Tag's service shape silently. See §4 below.
- `yield* new SubscriberDataError(...)` at `subscribers.ts:186, 343` works
  but is non-obvious. Use `yield* Effect.fail(new SubscriberDataError(...))`.
- `Effect.die(new Error(...))` at `choreography/tools.ts:127, 167, 174,
  184` — prefer `Effect.dieMessage` or a typed defect class.
- Unused `Schema.Class` everywhere — current `Schema.Struct` usage is
  appropriate; flagging only because reviewers often expect `Class`.
- `node:crypto` directly imported in `producer.ts`, `waits.ts`,
  `internal-claim.ts`, `operator.ts`. Use Effect's `Random`/UUID service or
  a small `RandomId` Tag so the kernel stays portable.
- `Effect.orDie` blanketed across `choreography/service.ts:266, 301, 324,
  352` — intentional per `errors.ts:1-21`, but means every consumer must
  reason about defects. Document this clearly at the public surface.

### 2e. Brand types

SDD §"API Type Shape" specifies `OperationHandleId` as
`Brand.Branded<string, "OperationHandleId">`. Status:

- ✓ `WorkId`, `CompletionId`, `OwnerId` (`choreography/branded.ts:14-21`)
- ✓ `OperationHandleId` (`descriptors/operation.ts:57-59`)
- ✗ Kernel `runId`, `claimId`, `ownerId`, `workId` are bare `string`
  (`schema/rows.ts:31, 87-92`). The branded.ts comment acknowledges this is
  deliberate ("kernel runId/completionId/ownerId strings are not
  retrofitted"). It is a real type-safety gap; the brands cross the
  facade↔kernel boundary by `as` cast.

Decision needed: retrofit the kernel, or document the gap as permanent.

### 2f. Top 5 highest-leverage idiomatic wins (ranked)

1. Migrate the 11 `extends Error` classes to `Data.TaggedError`.
2. Pick one service convention in substrate.
3. Replace the two hand-rolled subscriber loops with `Stream.async`.
4. Add Schema decoders for `completion.data` per kind (Timer / ProjectionMatch
   / ScheduledWork) so `subscribers.ts:205-214, 220-233, 335-347` stops
   doing `as Record<string, unknown>` casts.
5. Extract a single `acquireSubstrateDb` helper used by `runner.ts`,
   `operation-handler.ts`, and `event-plane/projection.ts`.

---

## 3. Code quality, DRY, missing abstractions

### 3a. The seven-fold append helper

`new DurableStream({ url, contentType })` followed by `Effect.tryPromise({
try: stream.append(JSON.stringify(event)), catch: ... })` appears 7 times
with 7 near-identical error wrappers:

```
internal-claim.ts:47, 68         ClaimStreamError
waits.ts:127, 131                WaitsStreamError
producer.ts:48, 55, 115, 122     ProducerStreamError
subscribers.ts:87, 120           SubscriberStreamError
operator.ts:126, 208             ClaimStreamError
choreography/service.ts:124, 128 ChoreographyVerificationError
event-plane/producer.ts:157, 164 PlaneProducerError
```

A single module-local `appendChange(streamUrl, contentType, mapErr)` helper
deletes ~40 LOC and unifies failure semantics.

### 3b. Triplicated `acquireDb`

Identical scoped open-preload-close flow in three places:

- `facade/projection.ts:67-81`
- `event-plane/projection.ts:86-106`
- `runner.ts:49-63`, `operation-handler.ts:40-54`,
  `event-stream-materializer.ts:87-114` (runtime variant)

Each forks its own error class (`ProjectionReadError`,
`PlaneProjectionReadError`, `AcquireDbError`).

### 3c. Triplicated `tryBuild`

Synchronous-throw → typed-Effect-error wrapper for state-machine builders
appears three times:

- `producer.ts:147-154`
- `operator.ts:94-101`
- `subscribers.ts:130-140` (Option-skip variant)

The natural fix is making the builders return `Effect<…,
IllegalRunTransition>` instead of throwing — this also removes the
"synchronous throw inside Effect" anti-pattern.

### 3d. Authoritative-run helper duplicated

Identical `firstValid + retainedRunRecords` reads:

- `choreography/service.ts:144-148` (`authoritativeRun`)
- `choreography/tools.ts:110-114` (`authoritativeRun`)
- `operator.ts:106-115` (`readAuthoritativeRun`)

### 3e. Idempotency-header merging

Two implementations:

- `producer.ts:64-77` (`withIdempotencyHeader`)
- `event-plane/producer.ts:60-88` (`mergeMetadataIntoHeaders`, strict
  superset).

### 3f. State-machine fold duplication

`state-machine.ts:236-277`: `foldCompletionRecords` and `foldRunRecords` are
structurally identical (lines 240-253 vs 263-276). One
`firstValidTerminalFold(records, idField, terminalPredicate)` covers both.

### 3g. Schema lives in three places

SDD §3 says the canonical location is `schema/`. Today:

- ✓ `schema/rows.ts`, `schema/state.ts`, `schema/ready-work.ts` own value
  schemas.
- ✗ `descriptors/operation.ts:12-25` defines `OPERATION_ENVELOPE_TAG`,
  `OperationEnvelope`, `isOperationEnvelope` outside `schema/`.
- ✗ `descriptors/event-stream.ts:18-49` defines envelope helpers outside
  `schema/`.
- ✗ `state-machine.ts` is the actual canonical row-builder surface
  (`createPendingCompletion`, `startRun`, `blockRun`, etc.) but lives at the
  package root.

Move envelopes into `schema/event-stream.ts` and `schema/operation.ts`;
either move builders into `schema/builders.ts` or document `state-machine.ts`
as part of the schema surface.

---

## 4. Public API ergonomics

### 4a. `@durable-agent-substrate/client` (target: `@firegrid/client`)

The root `index.ts` violates SDD §"Client Constraints" must-not #1.

```ts
// packages/client/src/index.ts:14-18 — SHOULD NOT BE AT ROOT
export { SubstrateClient, SubstrateClientLive,
         type SubstrateClientConfig, type SubstrateClientService }

// :20-26 — banned vocabulary at root
export type { DeclareWorkInput, DeclareWorkResult,
              SubstrateClientWork, SubstrateWorkHandle, WorkObservation }

// :55-69 — kernel wire constants at root
export { EVENT_STREAM_ENVELOPE_TAG, EVENT_STREAM_ROW_TYPE,
         OPERATION_ENVELOPE_TAG, makeEventStreamEnvelope, ... }
```

The Firegrid block at `:30-52` is the SDD-correct API. It should be the only
root export.

`client-foundations.test.ts:9-40` already enforces a banned-name list — but
the list does not include `Substrate*Client*`, `DeclareWork*`, or the wire
constants. Extending the list is one line of test code.

### 4b. Two `FiregridClient` Tags joined by `as unknown as`

```ts
// packages/client/src/firegrid/event-client.ts:75-78
export class FiregridClient extends Context.Tag(...)<
  FiregridClient, FiregridClientService /* emit/events only */
>() {}

// packages/client/src/firegrid/operation-client.ts:160-163
export const FiregridClient = BrowserFiregridClient as unknown as
  Context.Tag<FiregridClient, FiregridClientService /* full */>
```

Same Tag identity, two service shapes. The `as unknown as` cast hides a
real footgun: a consumer who imports `FiregridClient` from the root and
provides only the browser-only `FiregridClientLive` (event-only) gets
type-checked access to `send`/`call`/`result`/`observe` that throws at
runtime.

Also: two `FiregridClientLive` factories
(`event-client.ts:173-176` vs `operation-client.ts:335-338`) and two
`FiregridClientConfig` shapes (`clientId` optional vs required).

**Recommendation:** define one `FiregridClient` Tag with the full service
shape in `operation-client.ts`; have `event-client.ts` export a
`buildEventStreamService(...)` builder that returns the partial
implementation slot. The browser-only Layer composes the partial with a
runtime-die placeholder for `send/call/result/observe`. One Tag, one Live,
one config.

### 4c. `firegrid/` subpath is partial

`packages/client/src/firegrid/index.ts:1-28` re-exports only the EventStream
client. The lab uses the subpath (correctly, for browser bundle isolation),
but the operation-client API is reachable only via the root barrel. Either
fold operation-client into the subpath or drop the subpath.

### 4d. Suggested `client` package layout (post-cleanup)

```
@firegrid/client            (root)
  Operation, OperationHandle, EventStream
  FiregridClient, FiregridClientLive, FiregridClientConfig,
    FiregridClientService
  SendError, ResultError, ObserveError, EmitError, EventsError,
  OperationCancelled, OperationDecodeError, OperationEncodeError,
  OperationNotFound, EventStreamAppendError, EventStreamDecodeError,
  EventStreamEncodeError, EventStreamReadError
  OperationState

@firegrid/client/kernel     (subpath, marked unsafe / for adapters)
  KernelClient, KernelClientLive, KernelClientWork
  DeclareWorkInput, DeclareWorkResult, WorkObservation, WorkHandle
  EVENT_STREAM_ENVELOPE_TAG, OPERATION_ENVELOPE_TAG,
    makeEventStreamEnvelope, makeEventStreamStateRow, ...
```

### 4e. `@durable-agent-substrate/substrate` (target: `@firegrid/substrate`)

`packages/substrate/src/index.ts` does `export *` over eleven kernel modules
wholesale. This includes:

- `state-machine.ts` exports — `IllegalRunTransition`,
  `IllegalCompletionTransition`, all builders, `foldRunRecords`,
  `deriveBlockedRunOutcome`, `isLegalRunTransition`. Public.
- `retained-records.ts` exports — `readRetainedClaimAttempts`,
  `readRetainedRunRecords`. Public.
- `operator.ts` / `operator-errors.ts` exports — `processReadyWorkItem`,
  `firstValidClaim`, `RunNotFoundError`, etc. Public.
- `stream.ts` exports — `openSubstrateDb`, `rebuildProjection` (the explicit
  hot-path footgun the SDD calls out at line 786). Public.
- `subscribers.ts` exports — both `runTimerSubscriber` (rebuilds) and
  `runTimerSubscriberFromSnapshot` (correct hot-path) live publicly with no
  marking that one of them violates RUNTIME_HOT_PATH.1 if used in a loop.

The self-described `ProjectionMatchTrigger` collision at `index.ts:21-26` is
a smell of this same problem: the kernel placeholder and the typed
choreography schema collide at the root because both leaked there. The
correct fix is to demote the kernel placeholder; it is no longer the right
public name.

**Recommendation:** the package root should re-export only:

- `descriptors/index.ts` (`Operation`, `EventStream`)
- `schema/index.ts` (`substrateState`, `RunValue`, etc.)
- `facade/index.ts` (`Projection`, `WorkClaim`, ergonomic surface)
- `event-plane/index.ts` (after rename — see §5b)
- `choreography/index.ts` (after pulling out tools — see §1a)

Everything else (`state-machine`, `operator`, `producer`, `waits`,
`subscribers`, `stream`, `projection`, `retained-records`, `internal-claim`)
moves behind `@firegrid/substrate/kernel`. Tests can keep that import; app
code should not.

---

## 5. Migration debt

### 5a. Package names

`@durable-agent-substrate/{substrate,client}` need to become
`@firegrid/{substrate,client}` (per SDD §"Naming Model"). Runtime and lab
already cut over.

Mechanics: rename in `package.json`, fix `pnpm-workspace.yaml` references,
update internal imports (lab consumes `@durable-agent-substrate/client/firegrid`),
keep an old-name alias in `package.json` for one cycle.

### 5b. EventPlane → EventStream

Mid-flight. Status:

- ✓ External descriptor: `descriptors/event-stream.ts` is the new vocabulary.
- ✓ Wire format: `EventStreamRowType = "firegrid.event"`,
  `EventStreamEnvelopeTag = "firegrid/event@1"` in `schema/rows.ts:8-9`.
- ✗ Internal implementation: `event-plane/{define,layer,producer,projection}.ts`
  still uses event-plane vocabulary. Tag keys are literally
  `event-plane/${Name}/Producer` (`event-plane/define.ts:60`).
- ✗ Missing API: `EventStream.layer(...)` constructor that wires an
  `EventStreamDescriptor` (not a `StateSchema`) into runtime behavior — the
  SDD §"Event Streams" target.

`EventPlane.define` currently takes a full `StateSchema`; `EventStream.define`
takes a single `Schema`. They are not connected.

**Recommendation:** rename internals to `event-stream/`, deprecate
`EventPlane.define`, build `EventStream.layer(EventStreamDescriptor, {
materialize })` returning a `Layer` as the SDD specifies.

### 5c. Naming inside the kernel

`SubstrateHost`, `SubstrateHostBoot`, `HostProgramRuntime`, "Host Program
Graph" — already cut over in `runtime/`. Substrate kernel still calls work
"work" (correct per SDD — internal kernel vocabulary), but exposes
`work`/`run`/`completion` types at the root, which is the issue from §4e.

---

## 6. Operational and correctness concerns

### 6a. Hot-path violations

SDD §"Performance Constraints" line 786: "Long-running runtime subscriber
and handler loops use a single scoped live `SubstrateStreamDB` after the
initial no-gap catch-up; per-wake `rebuildProjection` / `db.preload` calls
are forbidden while a live handle is held."

Three production paths violate this on a per-RPC basis:

1. `packages/substrate/src/waits.ts:138-148` — `findExisting` calls
   `rebuildProjection` once per `awakeable()` call to enforce idempotency.
   In a runtime that creates many awakeables, every call rebuilds the whole
   stream.
2. `packages/substrate/src/producer.ts:129-140` — `loadCurrent` in
   `CompletionProducer` calls `rebuildProjection` for every
   `resolveCompletion` / `rejectCompletion` / `cancelCompletion`. External
   actors (approval UIs, etc.) calling these in production rebuild the
   whole stream per resolution.
3. `packages/client/src/client/work.ts:118-131` — `snapshotEffect` in
   `client.work.observe(...).snapshot()` rebuilds per snapshot. The
   in-source comment (`work.ts:76-85`) justifies it as a workaround for
   upToDate semantics. Document the cost or fix the upToDate handling.

Plus: `retained-records.ts:30-44` opens a fresh `live: false, offset: "-1"`
session and reads the entire stream every call. `choreography/service.ts:144`
and `operator.ts:106` call this on the hot path of every claim/suspension.

**No test asserts that `Firegrid.handler` does NOT call `rebuildProjection`
per wake.** A regression that re-introduced per-wake rebuild would pass all
current tests.

**Recommendation:** add a test that mocks/instruments `rebuildProjection`
and asserts it is called exactly once during a runtime layer's lifetime.
Replace the three `findExisting`/`loadCurrent`/`snapshotEffect` rebuilds
with the live StreamDB held by the surrounding Layer.

### 6b. Lab session leak

`packages/lab/src/lab/RawStreamInspector.tsx:36-77`: the `useEffect` cleanup
flips a `cancelled` boolean but never calls `session.cancel()`. Re-mount or
`streamUrl` change leaves the previous session's `for await` chained to an
unclosed reader. Compare with `LabEventStreamPanel.tsx:80-83`, which
correctly interrupts the forked Effect.

**Fix:** call `session.cancel()` in the cleanup callback. Add a test that
mounts/unmounts twice and asserts no leaked session.

### 6c. Missing tests for what the SDDs require

| Missing test | SDD reference |
|---|---|
| Two `Firegrid.handler` runtimes on the same operation produce one terminal row (or codified v1-only-one-runtime guard) | First-valid-terminal-wins |
| Rebuild-not-called-per-wake instrumentation guard | RUNTIME_HOT_PATH.1 |
| Restart resume — drop runtime scope, reconstruct, observe catch-up | runtime-stress-and-restart.feature.yaml |
| `EventStreamMaterializerDecodeError` path with a malformed `firegrid.event` row | event-stream protocol |
| `EventStreamDecodeError` on the client `events()` side | event-stream protocol |
| Idempotency-key end-to-end through `FiregridClient.send/call` | client constraint #5 |
| External interruption between block-row append and `Effect.interrupt` (SUSPENSION race) | Choreography facade |
| `bin/firegrid.ts` parseArgs and child-process exit propagation | Process and Environment Model |
| Burst coalescing of N concurrent `subscribeChanges` callbacks into 1 follow-up scan | RUNTIME_HOT_PATH.1 |

### 6d. `FiregridClient.send/call` drops `idempotencyKey`

`operation-client.ts:250-265` calls `client.work.declare({ input: wrap(...) })`
with no idempotency option, even though `DeclareWorkInput.idempotencyKey` is
supported by the underlying `SubstrateClientWork.declare`. SDD §"Performance
Constraints" Client item 5 requires "Support idempotent send/call." Add the
option and a test that mirrors `client-work.test.ts:80-107`.

### 6e. Client per-call layer construction

`operation-client.ts:240-248`: `withSubstrate` provides a fresh
`SubstrateClientLive(cfg)` on every `send`/`result`/`observe` call. Each
call rebuilds `ProjectionLive` + `SubstrateProducerLive` and opens a new
`StreamDB`. For an interactive client this is the wrong shape. Hoist the
layer once at `buildService` time.

Same pattern in `lab/LabEventStreamClient.ts:26-30`: rebuilds
`FiregridClientLive` per `emitLabEvent`/`labEvents`. Hoist per `streamUrl`.

### 6f. Other smells

- `as unknown as Context.Tag<…>` at `operation-client.ts:160` (covered §4b)
- Dead-letter branch returning `OperationNotFound` for a "structurally
  unreachable" state (`operation-client.ts:303-306`) — prefer
  `Effect.dieMessage` so genuine bugs surface rather than masquerading as
  missing operations.
- `as unknown as { subscribeJson }` at
  `event-stream-materializer.ts:153` bypasses the typed `StreamResponse`
  interface; if the upstream API renames `subscribeJson`, the lab fails at
  runtime. File a typed adapter or an upstream issue.
- `as Layer.Layer<…>` casts at `runtime/layer.ts:121-124, 147-151` —
  documented as TS-narrowing limitation; add a TODO marker.

---

## 7. Test coverage gaps

Source files with no direct unit tests:

- `packages/runtime/bin/firegrid.ts` (only string-grep guard)
- `packages/runtime/src/runtime/internal/runner.ts` (no isolated tests for
  `minPendingDueAtMs`, scope teardown, latch coalescing, error propagation)
- `packages/runtime/src/runtime/internal/operation-handler.ts` (one happy
  path test only)
- `packages/lab/src/lab/{App,RawStreamInspector,LabEventStreamPanel}.tsx`
  (no React-render or behavioral tests; only import-string and skeleton)
- `packages/client/src/firegrid/operation-client.ts` (no dedicated unit
  tests for `send`/`call`/`result`/`observe`; covered indirectly via
  substrate-layer `client-work.test.ts`)

The substrate test suite is comprehensive (~8000 LOC) and well-organized.
Coverage is concentrated in the kernel; the runtime and lab are
under-tested for their share of code.

---

## 8. Prioritized action plan

Each item lists a rough cost (S/M/L) and the files involved. Items can
ship independently unless dependencies are noted.

### Now (ship-blockers for external use)

| ID | Action | Cost | Files |
|---|---|---|---|
| A1 | Strip `Substrate*Client*` / `DeclareWork*` / wire-envelope constants from `client/src/index.ts` root; add to `kernel` subpath. Extend banned-names test. | S | `client/src/index.ts:14-69`, `client/src/__tests__/client-foundations.test.ts:14`, `client/package.json` |
| A2 | Collapse the two `FiregridClient` Tag definitions and the two `Live` factories. Reconcile `FiregridClientConfig`. | M | `client/src/firegrid/{event-client,operation-client,index}.ts:75-78,160-163,173-176,335-338` |
| A3 | Fix `RawStreamInspector` session leak; call `session.cancel()` in cleanup. Add mount/unmount test. | S | `lab/src/lab/RawStreamInspector.tsx:36-77` |
| A4 | Replace per-call `rebuildProjection` in `waits.findExisting`, `producer.loadCurrent`, `client/work.snapshotEffect` with the surrounding scope's live StreamDB. Add a "rebuild called once per layer lifetime" instrumented test. | L | `substrate/src/waits.ts:138-148`, `substrate/src/producer.ts:129-140`, `client/src/client/work.ts:118-131` |
| A5 | Plumb `idempotencyKey` through `FiregridClient.send/call`. Add round-trip test. | S | `client/src/firegrid/operation-client.ts:250-265` |

### Next (architecture cleanup)

| ID | Action | Cost | Files |
|---|---|---|---|
| B1 | Move `choreography/tools.ts`, `ChoreographyTools*`, `ChoreographyTimeout` out of substrate (target: runtime). | M | `substrate/src/choreography/{tools.ts,errors.ts}` |
| B2 | Hide kernel modules behind `@firegrid/substrate/kernel` subpath: `state-machine`, `operator`, `producer`, `waits`, `subscribers`, `stream`, `projection`, `retained-records`, `internal-claim`. Resolve `ProjectionMatchTrigger` collision by letting the typed schema take the root name. | M | `substrate/src/index.ts`, `substrate/package.json` |
| B3 | Extract a single `Projection<S>` parameterized over state schema; merge `facade/projection.ts` and `event-plane/projection.ts`. | M | `substrate/src/{facade,event-plane}/projection.ts` |
| B4 | Decompose `processReadyWorkItem` into the `claim → perform → record` pipeline `facade/work.ts` already invented. | M | `substrate/src/operator.ts:121-226` |
| B5 | Finish EventStream rename: `event-plane/` → `event-stream/`; deprecate `EventPlane.define`; add `EventStream.layer(descriptor, { materialize })` constructor. | M | `substrate/src/event-plane/*` |
| B6 | Rename packages: `@durable-agent-substrate/{substrate,client}` → `@firegrid/{substrate,client}`. | S | `package.json`, `pnpm-workspace.yaml`, lab + runtime imports |

### Mechanical (Effect idiomaticity)

| ID | Action | Cost | Files |
|---|---|---|---|
| C1 | Migrate the 11 `extends Error` classes to `Data.TaggedError`. | S | see §2b list |
| C2 | Pick one service convention in substrate and apply consistently. | M | `substrate/src/{producer,waits,facade/*,choreography/*}.ts` |
| C3 | Replace `runner.ts` and `operation-handler.ts` subscribe loops with `Stream.async` (template: `event-stream-materializer.ts`). | M | `runtime/src/runtime/internal/{runner,operation-handler}.ts` |
| C4 | Add Schema decoders for `completion.data` per kind (Timer/ProjectionMatch/ScheduledWork). | S | `substrate/src/schema/`, `substrate/src/subscribers.ts:205-214,220-233,335-347` |
| C5 | Extract `acquireSubstrateDb` helper used by `runner`, `operation-handler`, `event-stream-materializer`, `event-plane/projection`, `facade/projection`. | S | as listed |
| C6 | Extract `appendChange(streamUrl, contentType, mapErr)` helper; collapse the 7 tryPromise(append) sites. | S | see §3a list |
| C7 | Extract `authoritativeRun(streamUrl, runId)` helper; collapse 3 copies. | S | `choreography/{service,tools}.ts`, `operator.ts` |
| C8 | Consolidate `tryBuild` helpers: have state-machine builders return `Effect<…, IllegalTransition>` instead of throwing. | M | `state-machine.ts:32-225`, `operator.ts:94`, `producer.ts:147`, `subscribers.ts:130` |
| C9 | Move envelope helpers into `schema/{operation,event-stream}.ts`; either move row builders into `schema/builders.ts` or document `state-machine.ts` as part of schema. | M | `substrate/src/{descriptors,schema,state-machine}.ts` |

### Test gap-fillers

| ID | Action | Cost |
|---|---|---|
| D1 | `bin/firegrid.ts` parseArgs + Command.exitCode + scope-teardown tests | M |
| D2 | `runner.ts` `minPendingDueAtMs`, latch coalescing, AcquireDbError | S |
| D3 | EventStream decode-failure path tests (materializer + client) | S |
| D4 | Restart resume integration test (drop runtime scope, reconstruct, observe catch-up) | M |
| D5 | Multi-runtime claim test for `Firegrid.handler` (or codify v1 limit) | M |
| D6 | Behavioral tests for `LabEventStreamPanel` and `RawStreamInspector` | M |

### Polish

| ID | Action | Cost |
|---|---|---|
| E1 | Replace `nextEventId` (`event-client.ts:102-103`) with `crypto.randomUUID()`. | XS |
| E2 | Replace unreachable `OperationNotFound` fallback (`operation-client.ts:303-306`) with `Effect.dieMessage`. | XS |
| E3 | Centralize `Schema.Schema.AnyNoContext` cast helper. | S |
| E4 | Hoist `SubstrateClientLive` out of `withSubstrate` (`operation-client.ts:240-248`). | S |
| E5 | Hoist `LabEventStreamClient` per-call `FiregridClientLive` (`LabEventStreamClient.ts:26-30`). | S |
| E6 | Replace `node:crypto` direct imports with a `Random`/UUID service. | S |
| E7 | Decide kernel `runId`/`workId`/`completionId` brand retrofit policy; document. | S/L |
| E8 | Replace `Effect.die(new Error(...))` with `Effect.dieMessage` in `choreography/tools.ts:127, 167, 174, 184`. | XS |

---

## Appendix — methodology

This review combined:

- Baseline read of `docs/SDD_*.md` and `features/**.feature.yaml` against the
  current `packages/{substrate,client,runtime,lab}` tree.
- Per-package source reads totalling ~6700 LOC of source and ~9600 LOC of
  tests.
- Cross-check of Effect idioms against `https://effect.website/llms.txt`.
- File:line citations for every claim above.

Nothing in this review proposes scope-expansion. Every recommendation either
deletes code, consolidates duplication, fixes a documented invariant, or
moves an existing surface to where the SDDs already say it belongs.
