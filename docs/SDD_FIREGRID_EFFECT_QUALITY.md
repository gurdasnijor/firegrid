# SDD: Firegrid Effect Quality

Status: Draft
Product: Firegrid
Related: Effect artifact inventory, Effect detector reviews, repo hygiene

## Summary

Firegrid's package-structure work exposed a separate quality topic: the codebase
needs Effect-aware evidence and cleanup sequencing before package moves become
safe and reviewable. This SDD captures those Effect-specific inputs so the
package-structure SDD can stay focused on package and folder boundaries.

The main goal is not to make every source line match a style guide
mechanically. The goal is to identify Effect usage patterns that affect
architecture, runtime correctness, durable-resource safety, and future static
guards.

## Evidence Sources

Generated evidence:

- `docs/effect-artifact-inventory.md`
- `docs/effect-artifact-inventory.json`

Review inputs:

- `docs/REVIEW_EFFECT_TS_DETECTOR_FINDINGS_2026-05-05.md`
- `docs/REVIEW_EFFECT_CODE_STYLE_2026-05-05.md`
- `docs/REVIEW_EFFECT_CONCURRENCY_2026-05-05.md`
- `docs/REVIEW_EFFECT_CONFIGURATION_2026-05-05.md`
- `docs/REVIEW_EFFECT_RESOURCE_MANAGEMENT_2026-05-05.md`
- `docs/REVIEW_EFFECT_SINKS_2026-05-05.md`
- `docs/REVIEW_EFFECT_DATA_TYPES_2026-05-05.md`
- `docs/REVIEW_EFFECT_PLATFORM_2026-05-05.md`
- `docs/REVIEW_EFFECT_SCHEDULING_2026-05-05.md`
- `docs/REVIEW_EFFECT_SCHEMA_2026-05-05.md`
- `docs/REVIEW_EFFECT_RUNTIME_2026-05-05.md`
- `docs/REVIEW_EFFECT_OBSERVABILITY_2026-05-05.md`
- `docs/REVIEW_EFFECT_TESTING_2026-05-05.md`
- `docs/REVIEW_EFFECT_FULL_AUDIT_2026-05-05.md`
- `docs/REVIEW_EFFECT_ERROR_MANAGEMENT_2026-05-05.md`
- `docs/REVIEW_EFFECT_PATTERN_MATCHING_2026-05-05.md`
- `docs/REVIEW_EFFECT_TRAITS_2026-05-05.md`
- `docs/REVIEW_EFFECT_BATCHING_CACHING_2026-05-05.md`
- `docs/REVIEW_EFFECT_STATE_MANAGEMENT_2026-05-05.md`
- `docs/REVIEW_EFFECT_STREAMS_2026-05-05.md`
- `docs/REVIEW_EFFECT_REQUIREMENTS_MANAGEMENT_2026-05-05.md`
- `docs/REVIEW_EFFECT_CORE_2026-05-05.md`

External detector reference:

- `https://github.com/andrueandersoncs/claude-skill-effect-ts/tree/main/effect-ts-detectors`

Spec anchors:

- `firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.1`
- `firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.2`
- `firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.3`
- `firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.4`
- `firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.5`

## Effect Artifact Inventory

Import graphs answer where files point. They do not answer which Effect
capabilities cross a boundary. Firegrid therefore uses a ts-morph inventory that
classifies exported artifacts and resolves service requirements.

The inventory walks `packages/*/src` and `apps/*/src`, enumerates exported
declarations, and classifies each export into the repo's Effect vocabulary:

- `Context.Tag` service tags
- `Layer.Layer` values and layer constructors
- `Schema.Schema` values and tagged schema constructors
- tagged error subclasses
- functions and values returning `Effect.Effect<A, E, R>`
- service interfaces paired with tags
- plain TypeScript types and interfaces
- constants and pure helpers

The current inventory also records:

- package workspace
- physical source area
- inferred architecture layer
- re-export binding
- declaration-file imports
- `Effect.Effect<A, E, R>` channels where available
- `Layer.Layer<ROut, E, RIn>` channels where available
- same-package durable-core import layer crossings

The report is on-demand rather than part of `pnpm verify`; it is an
architecture evidence artifact and can churn with harmless export movement.

## Current Inventory Findings

Headline findings from the current report:

| Finding | Count |
| --- | ---: |
| Total exported artifacts | 763 |
| Re-exports | 461 |
| Effect-returning artifacts | 50 |
| Layer artifacts | 35 |
| Workspace/re-export boundary crossings | 18 |
| File import durable-core layer crossings | 4 |
| Unknown classifications needing future classifier refinement | 48 |

Role distribution:

| Role | Count |
| --- | ---: |
| service-tag | 34 |
| layer | 35 |
| schema | 80 |
| tagged-error | 91 |
| effect-returning | 50 |
| service-interface | 32 |
| plain-type | 282 |
| constant | 2 |
| pure-helper | 109 |
| unknown | 48 |

Declaration workspace distribution:

| Workspace | Declared exported artifacts | Effect-returning artifacts | Re-exports through barrels |
| --- | ---: | ---: | ---: |
| `packages/client` | 67 | 0 | 38 |
| `packages/runtime` | 37 | 6 | 10 |
| `packages/substrate` | 651 | 43 | 413 |
| `apps/lab` | 8 | 1 | 0 |

Architecture-layer export pressure:

| Layer | Exported artifacts |
| --- | ---: |
| State Machine | 202 |
| Protocol | 178 |
| Choreography | 120 |
| Projection | 68 |
| Client public | 61 |
| Facade | 40 |
| Runtime core | 36 |
| State Store | 32 |
| EventPlane | 11 |

The current problem is not primarily cross-package Effect requirement leakage.
The larger problem is concentration, re-export pressure, and ambiguous
same-package ownership inside the durable core.

## Durable-Core Layer Edges

The same-package import layer report identifies four edges that need
architectural decisions before a package split:

| Source | Edge | Import |
| --- | --- | --- |
| `packages/substrate/src/retained-records.ts` | State Store -> State Machine | `./schema/state-machine.ts` |
| `packages/substrate/src/stream.ts` | State Store -> Projection | `./projection.ts` |
| `packages/substrate/src/event-plane/define.ts` | EventPlane -> State Machine | `./producer.ts` |
| `packages/substrate/src/event-plane/layer.ts` | EventPlane -> State Machine | `./producer.ts` |

Interpretation:

- `schema` exporting Effect-returning transition builders confirms that schema
  and state-machine responsibilities are currently mixed.
- `descriptors` exporting Effect-returning append helpers confirms that
  protocol descriptors and state-store writes are currently mixed.
- `facade` and `choreography` carry service tags, Layers, service interfaces,
  and large re-export counts; they should be treated as real API decisions, not
  generic buckets.
- `retained-records.ts`, `stream.ts`, and `subscribers.ts` are Effect-heavy
  areas and should receive clear State Store or State Machine homes before any
  package split.

## Detector Findings

The raw detector file at `/tmp/firegrid-detect.json` was inspected but not
committed because it includes tests, fixtures, generated guard fixtures, and all
detector categories. Filtered to production source under `packages/*/src` and
`apps/*/src`, excluding tests and fixtures, it contains roughly 900 findings,
with 272 definite findings.

Highest-signal categories:

- conditionals
- error modeling
- async boundaries
- imperative loops
- schema boundary modeling
- direct discriminant checks

Detector summary from the curated review:

| Input | Finding |
| --- | --- |
| Files analyzed | 68 production TypeScript files |
| Definite detector findings | 277 |
| Detector errors | 1 detector crash in `native-apis/rule-001-array-operations` |
| Largest rule bucket | `errors/rule-002` with 83 findings |
| Largest workspaces | `packages/substrate` 163, `packages/runtime` 48, `apps/lab` 37, `packages/client` 29 |

The detector should remain advisory until the crash is fixed and false
positives are filtered. High-confidence detector categories can later be ported
into local ESLint or Semgrep rules after the corresponding source cleanup lands.

## Full Audit Findings

The full Effect audit expands the detector surface from production definite
findings to the whole repository, including tests, scripts, features, and
potential findings.

Headline numbers from that run:

| Metric | Count |
| --- | ---: |
| Files analyzed | 118 |
| Total detector findings | 4,023 |
| Definite findings | 2,089 |
| Potential findings | 1,934 |
| Source definite findings | 296 |
| Source potential findings | 661 |
| Test definite findings | 1,793 |
| Test potential findings | 1,273 |

Top definite categories:

| Category | Count |
| --- | ---: |
| async | 1,267 |
| testing | 212 |
| imperative | 129 |
| errors | 126 |
| conditionals | 122 |
| native-apis | 80 |
| code-style | 74 |
| discriminated-unions | 60 |
| schema | 19 |

Source hotspots from the full audit overlap with the curated reviews:

| File | Findings |
| --- | ---: |
| `packages/substrate/src/schema/state-machine.ts` | 58 |
| `packages/client/src/firegrid/operation-client.ts` | 55 |
| `packages/substrate/src/subscribers.ts` | 54 |
| `packages/substrate/src/waits.ts` | 45 |
| `packages/substrate/src/event-plane/producer.ts` | 45 |
| `packages/client/src/firegrid/event-client.ts` | 40 |
| `packages/runtime/src/runtime/internal/operation-handler.ts` | 37 |
| `apps/lab/src/lab/RawStreamInspector.tsx` | 35 |
| `packages/substrate/src/choreography/service.ts` | 34 |
| `packages/substrate/src/producer.ts` | 31 |

Interpretation:

- The full audit reinforces the existing remediation order rather than
  replacing it. The same hotspots recur: runtime dispatch, client operation
  calls, subscribers, waits, event-plane producer, RawStreamInspector, and
  schema/state-machine.
- Test findings dominate absolute counts. Test modernization should be a
  focused `@effect/vitest` migration plan, not a forced rewrite of every test
  before correctness and resource fixes.
- Some recommendations are policy decisions, especially blanket
  `Data.TaggedError -> Schema.TaggedError`, blanket `interface ->
  Schema.Class`, and plain-function bans. These should not become strict gates
  until Firegrid decides which boundaries require schema-backed serialization
  and which are intentionally internal TypeScript surfaces.
- High-confidence findings already align with planned work: `AnyNoContext`
  codec centralization, completion-data schemas, `Data.TaggedEnum` candidates,
  ID/time/random services, RawStreamInspector rewrite, and durable-stream
  construction services.

The full-audit detector JSON remains at `/tmp/firegrid-detect.json`; it is not
committed because it is a large local analysis artifact and includes potential
findings across tests and generated-style guard fixtures.

## Error Modeling Policy

Error modeling is a policy decision. The detector recommends
`Schema.TaggedError`, while recent remediation standardized many expected
in-process failures on `Data.TaggedError`.

Before enforcing either direction, decide whether each error family crosses
durable storage, transport, or human-inspection boundaries. Wire-crossing
errors should favor schema-backed encoding. Purely in-process failures may
remain `Data.TaggedError` if that is the documented policy.

The error-management review recommends making `Data.TaggedError` the Firegrid
default policy today. Its rationale is that Firegrid does not currently decode
error objects from the wire: durable rows carry domain payloads, operation
descriptors carry caller-owned error schemas separately, and no package has an
error-as-Schema composition requirement. `Schema.TaggedError` should be
reserved for future boundaries that need to serialize and decode error
instances.

Additional error-management findings:

- convert the two operation-handler `catchAll` append-error recoveries to
  `catchTag("AppendEventError", ...)`
- extract a shared `logCauseUnlessInterrupted` helper for long-lived loop
  finalizers
- document the `Data.TaggedError` policy in the repo's code-style guidance
- make `Effect.orDie` justification comments mechanically auditable if the
  guardrail evolves beyond warning on the call itself

## Effect-Core Findings

The Effect-core review finds post-R0B fundamentals are solid:
constructor selection is consistent, I/O boundaries use `tryPromise`,
run boundaries are confined to the runtime binary and documented React lab
bridges, and multi-step logic generally uses `Effect.gen` while simple
transforms use pipes.

Actionable findings:

- flatten the remaining one-yield `findExisting` gen in `waits.ts`
- resolve or document the unusual `Effect.try(blockRun)` wrapper in
  choreography service
- remove unnecessary `Effect.suspend` in event-plane producer if the closed-over
  state is immutable
- document the operator `Effect.either` shape as deliberate because a fresh
  authoritative read must occur between handler exit and terminalization
- optionally extract a helper for repeated choreography tool bindings

These are style and legibility cleanups, except the `Effect.try(blockRun)` item
which should be clarified before broader state-machine shim retirement.

## Data-Type Findings

The data-types review finds the codebase healthy on tagged domain errors,
`Duration`, branded IDs, and most `Option` / `Either` usage. The main issue is
hand-rolled discriminated unions.

Highest-leverage data-type findings:

- convert `kind`-discriminated unions such as `ClaimOutcome`,
  `ProjectionMatchEvaluation`, `DueTimeDecision`, `ProjectionMatchOutcome`,
  `ClaimAttemptOutcome`, and `TriggerMatchEvaluation` to `Data.TaggedEnum`
- replace the `Effect.either` / `Either.isRight` ladder in `operator.ts` with
  `Effect.matchEffect` and `Either.match`
- extract a shared `tapErrorCauseUnlessInterrupted(label)` helper for repeated
  interruption-aware error logging
- replace direct Effect data `_tag` probes with `Option`, `Exit`, or
  `Cause` helpers
- make direct time/random generation part of the same policy decision as the
  platform review's ID-generation work

These are cleanup slices, not package-boundary requirements. They should not
block the package-structure SDD, except where hand-rolled unions are exported as
public durable-core API.

## Pattern-Matching Findings

The pattern-matching review finds the repo is better than the raw detector
counts imply: no production `else if` chains, no deeply nested ifs, and only two
production switches. Remaining work is concentrated in high-leverage
discriminator walks.

Highest-leverage pattern-matching findings:

- replace run-state ladders in `operation-client.ts` with a shared exhaustive
  matcher
- convert subscriber `DueTimeDecision` and `ProjectionMatchOutcome` branches to
  `Match.tag` after those unions are schema/data-backed
- replace direct `Exit` / `Option` `_tag` probes in operation-handler,
  projection-service, and lab UI with `Exit.match`, `Option.match`, or
  `Option.getOrElse`
- replace the operator's repeated `Either.isLeft` / `Either.isRight` checks
  with one `Either.matchEffect`
- migrate the `deriveBlockedRunOutcome` switch to an exhaustive Match shape

Pattern matching cleanup should generally follow the data-type and schema
cleanup for the affected unions. Direct `_tag` probes and the operator
`Either` cluster can land independently.

## Schema Findings

The schema review finds Firegrid is already schema-first for durable wire data:
row families live in `schema/rows.ts`, the state schema is derived once, and
boundary encode/decode uses Effect Schema rather than ad hoc JSON parsing.

Highest-leverage schema findings:

- centralize the repeated `Schema.Schema.AnyNoContext` cast in one descriptor
  codec helper
- define per-kind `completion.data` schemas for timer, projection-match, and
  scheduled-work completions
- promote `OperationEnvelope` to a `Schema.Struct` and replace hand-rolled
  envelope guards with `Schema.is`
- reconcile the two `ProjectionMatchTrigger` definitions around one
  schema-backed shape
- migrate durable choreography brands to `Schema.brand` where the IDs cross row
  or protocol boundaries

These findings strengthen the package SDD's Protocol and State Store split:
schema-backed wire contracts should live with Protocol, while append/replay
mechanics should live with State Store.

## Concurrency Findings

The runtime's long-running loops are structurally sound:
`Stream.asyncScoped` and `Effect.forkScoped` are used under scoped layers for
runner, operation-handler, and materializer lifetimes.

Actionable findings:

- The deadline timer in `packages/runtime/src/runtime/internal/runner.ts`
  should use `Effect.forkScoped` rather than bare `Effect.fork`.
- The operation-handler's serial dispatch is an intentional v1 invariant and
  should be named in code before any future concurrency expansion.
- Choreography suspension via `Effect.interrupt` remains a deliberate design
  decision because suspension must be durable, not in-process.

## Configuration Findings

Firegrid has one production `process.env` read,
`packages/runtime/bin/firegrid.ts`, and otherwise passes plain config shapes
through Layers.

The right Effect Config adoption point is the binary/runtime boundary, not every
downstream `*Config` interface.

Future shape:

- `RuntimeConfigLive` reads `DURABLE_STREAMS_URL` via
  `Config.option(Config.string(...))`.
- URL validation happens once at the runtime edge.
- `RuntimeConfigLive` provides `RuntimeContext`.
- substrate/client layer factories continue receiving plain values from the
  runtime edge.

## Platform Findings

The platform review finds the runtime binary is already the correct
`@effect/platform` boundary: command execution uses `Command`, terminal output
uses `Terminal`, `NodeContext.layer` is provided at the binary edge, and the
program enters through `NodeRuntime.runMain`.

Remaining platform-adjacent findings:

- promote an `IdGen` service to retire direct `node:crypto.randomUUID` imports
  and consolidate the browser client `Date.now()` / `Math.random()` event-id
  fallback
- replace the lone `process.env["DURABLE_STREAMS_URL"]` read with the
  configuration review's `Config.option(Config.string(...))` boundary
- align the lab raw stream inspector with the resource-management review's
  scoped stream-consumption guidance

There is no production `FileSystem`, `HttpClient`, `HttpServer`, or
`KeyValueStore` migration owed today. Durable Streams remains the application
protocol client rather than a generic HTTP surface.

## Runtime Findings

The runtime review finds the post-R0 runtime topology is broadly sound:
entrypoint code is thin, boot resolution is factored as attached versus
embedded-dev providers of one resolver service, and long-running runtime loops
are consistently installed with scoped Layers and scoped forks.

Highest-leverage runtime findings:

- provide `CurrentWorkContext` inside the operation-handler dispatch boundary
  before invoking the user handler, so choreography primitives work naturally
  inside `Firegrid.handler`
- consider a `ManagedRuntime`-backed client convenience for backend
  non-Effect callers instead of forcing callers toward raw `Effect.run*`
- remove redundant process identity fields from `RuntimeContextService` if
  helpers can read `FiregridRuntime` directly
- document why forked loops also open child scopes around their acquire
  boundaries
- make `Firegrid.subscribers.timer` and `scheduledWork` factories if the public
  surface should match `handler` and `eventStream`

The `CurrentWorkContext` gap is more than style: it affects whether handlers can
compose with durable choreography primitives without the caller manually
providing internal context.

## Requirements-Management Findings

The requirements-management review confirms R7's service-convention cleanup
held: production source has zero `Effect.Service` / `.Default` usage, and
public services use `Context.Tag` paired with explicit `*Live` Layers.

Findings:

- `Layer.scopedDiscard` is used consistently for long-running runtime daemons
- `Layer.scoped` is used for resource-holding service graphs
- `Layer.succeed`, `Layer.sync`, and `Layer.effect` match value-only service
  construction intent
- `Effect.provide` is consistently used for full Layer graphs; there is no
  mixed `provideService` style to police
- runtime root Layer composition is correct and resolves context once at boot
- `CurrentWorkContext` remains the single correctness gap: handler invocation
  propagates that requirement outward instead of satisfying it per dispatch
- client and lab per-call Layer construction are not leaks, but they bypass
  Layer memoization and should be lifted for long-lived clients

This review strengthens the priority of the `CurrentWorkContext` slice and the
client lifecycle slice. It does not call for another service-convention rewrite.

## Resource-Management Findings

The shared scoped primitives are mostly correct: `acquireSubstrateDb`,
`acquireStreamDb`, `wakeStream`, projection streams, and runtime materializer
sessions follow scoped acquire/release patterns.

Actionable findings:

- `packages/client/src/firegrid/operation-client.ts` still builds
  `SubstrateClientLive(substrateCfg)` per public client call. That means
  send/result/call can open, preload, and close a StreamDB per operation. This
  is a stronger client-structure issue than a naming issue.
- `apps/lab/src/lab/RawStreamInspector.tsx` owns an unscoped live stream
  session. It should mirror the `Effect.runFork` / `Fiber.interrupt` boundary
  used by `LabEventStreamPanel`.
- `packages/substrate/src/retained-records.ts` opens a non-live stream session
  for hot-path reads without an explicit `cancel()` finalizer. It should use an
  `Effect.acquireRelease` bracket around the stream session.
- Repeated `new DurableStream(...)` construction is not currently a leak if the
  handle remains disposable-free, but it is an architectural seam. A future
  scoped helper can centralize construction before the upstream client grows
  release semantics.

## Batching And Caching Findings

The batching/caching review finds no production `Effect.cached`, `Cache`,
`Request`, or `RequestResolver` usage today. That is acceptable for runtime hot
paths after R1, where long-running fibers hold a live substrate DB handle, but
one-shot readers still pay repeated full-stream costs.

Highest-leverage findings:

- refactor choreography `wrapSuspending` to eliminate a duplicate
  `readAuthoritativeRun` before considering caching primitives
- consider per-fiber `Effect.cached` only for handler-internal retained reads,
  never across operator pre/post authority checks
- consider per-fiber `Effect.cached` over `rebuildProjection` at the
  carry-forward one-shot sites after documenting freshness semantics
- defer `RequestResolver` batching for `readAuthoritativeRun` until the
  narrower per-fiber cache boundary is proven safe
- do not use in-memory `Request` dedupe as a substitute for durable idempotency

The safety rule is explicit: first-valid-terminal authority reads must observe
fresh durable state. Caching may be used between authority reads, not across
them.

## Streams Findings

The streams review finds Firegrid's Effect Stream surface small and disciplined:
`wakeStream` uses an explicit sliding buffer for edge coalescing,
`Stream.unwrapScoped` binds client stream sessions to consumer scope, and the
existing transformation pipelines are short and intent-revealing.

Actionable streams findings:

- document or address the materializer `Stream.async` default buffer size,
  because `void emit.single(item)` discards the backpressure signal
- refactor `RawStreamInspector` through the typed Effect Stream bridge already
  used by the lab event panel
- later, add a lint rule for fan-out `Stream.async` calls without explicit
  `bufferSize`
- later, add a lint rule forbidding raw `for await` over durable-streams
  sessions outside an explicit Effect bridge

No `Channel`, `Stream.merge`, or custom `Sink` migration is warranted today.

## Stream Sink Findings

The stream sink review found a small and mostly clean surface:

- production code has five `Stream.run*` consumer sites plus the React lab
  projection
- there are no custom `Sink` constructions in production code
- current use of `Stream.runDrain`, `Stream.runForEach`, and `Stream.runHead`
  matches the semantics of subscriber loops, UI/materializer projection, and
  one-shot waits
- no strict remediation slice is warranted from the sinks axis today

This keeps sink-specific cleanup out of the package-structure migration. Future
metrics or fan-out work may revisit `Sink` composition, but the current
architecture should not introduce sinks just to satisfy a style preference.

## Scheduling Findings

Firegrid is intentionally Schedule-free in production hot paths. Durable rows
encode when work should happen, and runtime loops wake from stream subscription
edges plus one derived deadline sleep.

Current scheduling posture:

- no `Schedule.*`, `Effect.repeat`, `Effect.retry`, `Effect.race`,
  `Stream.tick`, or cron usage exists in production source
- the runner's computed `Effect.sleep(Duration.millis(delayMs))` is the intended
  durable-deadline wake path
- `Projection.until` uses `Effect.timeoutFail` with decoded `DurationInput` to
  produce a typed timeout error

The scheduling review produced only minor refinements: clarify the timeout
field name, document the runner deadline-fiber contract, and document why
stream-append failures are not retried with `Schedule.exponential`.

## Observability Findings

Firegrid's observability surface is intentionally small today: runtime loops
log terminal failures, choreography facade verbs have spans, and no metrics or
OpenTelemetry exporter wiring exists in library code.

Highest-leverage observability findings:

- add claim-attempt spans and counters around the cross-process claim boundary
- add operation-dispatch spans and handler-duration metrics around
  `processRun`
- convert recoverable per-run decode/encode failures from interpolated
  `logError` messages to structured warning events with annotations
- add attributes to the existing choreography spans
- decide whether `TraceValue` will be produced by a substrate-native tracer or
  removed until needed

Host applications should own exporter wiring. Firegrid packages should emit
spans, log annotations, and metrics through Effect APIs so a host-provided
logger/tracer can observe them.

## Testing Findings

The testing review finds the suite is integration-heavy and intentionally runs
against real Durable Streams server processes. That shape should remain. The
improvement is targeted adoption of Effect testing tools, not a wholesale test
rewrite.

Highest-leverage testing findings:

- add `@effect/vitest` and migrate time-dependent tests first
- convert pure state-machine matrix tests to property tests with
  Schema-derived arbitraries
- extract reusable test Layers for repeated `*Live` provider chains
- document why raw `Effect.runPromise` remains allowed in legacy test files
  until migration
- replace the one `as never` fake DB mock with a typed `Layer.effect` /
  `Ref`-backed test double

This belongs in the Effect-quality track because it changes how Effect programs
are tested, not how runtime packages are named.

## Traits Findings

The traits review is confirmatory. Firegrid has no production custom
`Equal`, `Hash`, `Equivalence`, or `Order` implementations, and that is the
right posture for the current data shapes.

Findings:

- production equality checks are primitive string/state/undefined comparisons,
  not object identity checks
- native `Map` / `ReadonlyMap` usage is keyed by strings and backed by
  `@tanstack/db` collection state
- no production sort sites need Effect `Order`
- no `HashMap` / `HashSet` migration is recommended
- branded ID migration remains a schema-boundary topic, not a traits topic

No remediation slice is needed for traits unless future package boundaries
introduce structural comparisons over non-primitive domain objects.

## State-Management Findings

The state-management review is also confirmatory. Production source has no
`Ref`, `SubscriptionRef`, `SynchronizedRef`, or `TRef` usage, and that is the
right design for a durable kernel.

Findings:

- durable rows and state collections are the authoritative state
- closure-local `let` bindings in runtime loops are scoped to one fiber and do
  not need `Ref`
- React UI state belongs to React state at the app boundary
- test `Ref` usage is idiomatic for recorders and counters
- no `Ref`-based processed-run registry should be introduced because it would
  create restart-fragile in-memory authority

No state-management remediation slice is needed. The existing
`local/no-module-durable-cache` and host-authority registry guardrails remain
the relevant protection.

## Remediation Order

1. Provide `CurrentWorkContext` inside runtime operation dispatch.
2. Fix scoped resource leaks and per-call layer construction before large naming
   moves.
3. Add runtime/config boundary cleanup at `bin/firegrid.ts` and
   `RuntimeContext`.
4. Promote an `IdGen` service for kernel/runtime/browser ID generation.
5. Triage `Data.TaggedError` versus `Schema.TaggedError` policy before broad
   error codemods.
6. Add completion-data and envelope schemas before moving descriptor and schema
   helpers across durable-core folders.
7. Convert exported hand-rolled discriminated unions to `Data.TaggedEnum` where
   they are part of the durable-core API.
8. Centralize descriptor codec casts and remove repeated `AnyNoContext` call
   sites from client/runtime hot paths.
9. Rewrite RawStreamInspector around a scoped stream boundary.
10. Document or fix event-stream materializer backpressure buffering.
11. Refactor duplicate choreography retained-run reads before adopting cache or
    Request primitives.
12. Replace direct `_tag` probes and the operator `Either` cluster with
    Effect data-type matchers.
13. Resolve the choreography `Effect.try(blockRun)` question and document the
    operator `Effect.either` authority-read shape.
14. Add first-pass observability at claim and operation-dispatch boundaries.
15. Adopt `@effect/vitest` on pure/time-sensitive tests before broad test
   rewrites.
16. Address async boundary escapes, selected imperative loops, and schema
   boundary modeling as focused slices.
17. Use detector-backed strict rules only after the corresponding source cleanup
   lands.

## Future Strict Guards

Candidate strict gates after remediation:

- no direct `_tag` access on Effect or schema data
- no async boundary escapes outside documented framework edges
- selected no-`for...of` / no-mutation rules in durable-core hot paths
- no `new Map` / `new Set` in durable-core projection paths where Effect
  collections are the repo policy
- no `process.env[...]` outside the runtime binary/config module
- no direct `node:crypto`, `Date.now()`, or `Math.random()` in package source
  outside a documented ID/time/random service boundary
- no `new DurableStream(...)` outside a scoped helper if the constructor becomes
  resource-bearing
- no repeated `Schema.Schema.AnyNoContext` casts outside the descriptor codec
  boundary
- no `Effect.catchAll` where a narrower `catchTag` is available for a
  single-error channel
- no fan-out `Stream.async` without an explicit buffer/backpressure decision
- no raw durable-streams async iteration outside an explicit Effect bridge
- no `Effect.try` wrapper around a function that already returns `Effect`
  unless the call is explicitly crossing a throwing shim

Do not flip these gates before cleanup. They should first run as advisory
reports or narrowly scoped local rules.
