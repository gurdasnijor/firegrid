# Firegrid Remediation Acai Tasks - 2026-05-05

Source review:

```text
docs/REVIEW_FIREGRID_2026-05-05.md
```

Use this as the handoff queue for Coding Agent 1 / Coding Agent 2. Every task
below is grounded in Acai ACIDs. Agents should work in dedicated worktrees,
post "Already Exists vs Missing" before edits, and report review IDs, ACIDs,
files changed, tests run, and push posture.

Do not run `acai push --all` without explicit approval.

## Current Pause

Client/lab cleanup work is paused while the higher-risk architecture and
maintenance issues are addressed. Existing local edits may already contain a
small idempotency and lab-session-leak fix; do not assume they are the active
priority unless the coordinator explicitly assigns them.

## Priority Order

1. P0: State-machine correctness and Effect error boundaries.
2. P0: Runtime hot-path and subscriber-loop correctness.
3. P0: Public surface containment for client and substrate roots.
4. P1: Choreography and operator boundary cleanup.
5. P1: Shared infrastructure deduplication.
6. P1: EventPlane to EventStream internal migration.
7. P2: Package naming, brand policy, and polish.
8. P2: Client/lab cleanup after architecture remediation is moving.

## Task R0 - Declarative State Machines For Runs And Completions

Suggested owner: Agent 1.

Review findings: H3, M3, M7, state-machine follow-up from coordinator.

Goal: Replace hand-rolled run/completion transition conditionals in
`packages/substrate/src/state-machine.ts` with declarative machine definitions,
preferably XState used as a pure transition engine. Preserve durable row shapes
and first-valid-terminal-wins semantics.

ACIDs:

- `firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.1`: Durable completion and durable run transition legality is defined by declarative state machine definitions rather than scattered conditional checks.
- `firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.2`: State-machine transition builders preserve the existing durable row shapes and first-valid-terminal-wins rebuild semantics.
- `firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.3`: Expected illegal completion and run transitions are recoverable typed failures at service boundaries rather than uncaught synchronous exceptions.
- `firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.4`: State-machine row builders live in a canonical schema or schema-adjacent module and are not exposed as app-facing APIs.
- `firegrid-remediation-hardening.STATE_MACHINE_CORRECTNESS.5`: Run and completion first-valid-terminal-wins folds share one generic implementation.
- `awakeables-and-runs.COMPLETION_TRANSITIONS.1`: A completion may transition from absent to pending.
- `awakeables-and-runs.COMPLETION_TRANSITIONS.2`: A pending completion may transition to resolved, rejected, or cancelled.
- `awakeables-and-runs.COMPLETION_TRANSITIONS.3`: Resolved, rejected, and cancelled are terminal completion states.
- `awakeables-and-runs.COMPLETION_TRANSITIONS.4`: A terminal completion does not transition back to pending or to another terminal state.
- `awakeables-and-runs.COMPLETION_TRANSITIONS.5`: Competing completion terminal records use first-valid-terminal-wins authority.
- `awakeables-and-runs.COMPLETION_TRANSITIONS.6`: Later conflicting terminal records remain evidence and do not rewrite the terminal winner.
- `awakeables-and-runs.RUN_TRANSITIONS.1`: A run may transition from absent to started.
- `awakeables-and-runs.RUN_TRANSITIONS.2`: A started run may transition to blocked, completed, failed, or cancelled.
- `awakeables-and-runs.RUN_TRANSITIONS.3`: A blocked run may transition to completed, failed, or cancelled.
- `awakeables-and-runs.RUN_TRANSITIONS.4`: Completed, failed, and cancelled are terminal run states.
- `awakeables-and-runs.RUN_TRANSITIONS.5`: A terminal run does not transition back to started or blocked and does not transition to another terminal state.
- `awakeables-and-runs.RUN_TRANSITIONS.6`: Competing run terminal records use first-valid-terminal-wins authority.
- `awakeables-and-runs.RUN_TRANSITIONS.7`: Later conflicting terminal records remain evidence and do not rewrite the terminal winner.
- `effect-native-api.EFFECT_SERVICES.6`: Expected producer failures are represented in the Effect error channel rather than as defects.
- `effect-native-api.EFFECT_SERVICES.11`: Public expected errors use Effect-compatible tagged data errors and remain recoverable through the Effect error channel.

Likely files:

- `packages/substrate/package.json`
- `packages/substrate/src/state-machine.ts`
- `packages/substrate/src/schema/`
- `packages/substrate/src/producer.ts`
- `packages/substrate/src/operator.ts`
- `packages/substrate/src/subscribers.ts`
- `packages/substrate/src/__tests__/state-machine.test.ts`
- `packages/substrate/src/__tests__/producer.test.ts`

Acceptance checks:

- State-machine tests prove every legal and illegal transition through the new machine definitions.
- Existing producer/operator/subscriber tests continue to pass.
- Illegal transitions surface as typed failures at service boundaries.
- Durable row JSON shape is unchanged.

## Task R1 - Runtime Hot Paths And Stream-Based Subscribers

Suggested owner: Agent 2.

Review findings: H4, M4, L2, D2, D4.

Goal: Remove per-wake whole-stream rebuilds from long-running runtime paths and
replace hand-rolled callback/latch loops with scoped `Stream` pipelines.

ACIDs:

- `firegrid-remediation-hardening.EFFECT_CONSISTENCY.3`: Runtime subscriber and handler loops are expressed as scoped Streams rather than ad hoc latch, forever, race, or unmanaged callback loops.
- `firegrid-remediation-hardening.EFFECT_CONSISTENCY.4`: Expected errors preserve typed error tags and do not collapse to unknown through catch-all Effect.try wrappers.
- `firegrid-remediation-hardening.HOT_PATHS.1`: Long-running runtime, subscriber, and handler paths have tests proving they do not rebuild whole-stream projections on every wake while a live stream database is held.
- `firegrid-remediation-hardening.HOT_PATHS.2`: Reusable scoped database acquisition is centralized for runtime and substrate projection readers.
- `firegrid-remediation-hardening.HOT_PATHS.3`: One-shot snapshot APIs that intentionally rebuild projections document their cost and remain separate from long-running hot paths.
- `firegrid-runtime-process.RUNTIME_HOT_PATH.1`: Long-running runtime subscriber and handler loops use a single scoped live `SubstrateStreamDB` after the initial no-gap catch-up and must not call `rebuildProjection` or `db.preload` on every wake while a live handle is held; one-shot snapshot APIs and tests may still rebuild.
- `firegrid-remediation-hardening.TEST_GUARDRAILS.3`: Runtime runner and operation handler internals have tests for due-time selection, subscription coalescing, database acquisition failures, scope teardown, and error propagation.
- `firegrid-remediation-hardening.TEST_GUARDRAILS.5`: Restart tests prove runtime-owned materializers and in-flight waits can resume from durable rows after scope reconstruction.

Likely files:

- `packages/runtime/src/runtime/internal/runner.ts`
- `packages/runtime/src/runtime/internal/operation-handler.ts`
- `packages/runtime/src/runtime/internal/event-stream-materializer.ts`
- `packages/runtime/src/__tests__/`
- `packages/substrate/src/stream.ts`
- `packages/substrate/src/waits.ts`
- `packages/substrate/src/producer.ts`
- `packages/client/src/client/work.ts`

Acceptance checks:

- Instrumented tests fail if runtime handler/subscriber loops call `rebuildProjection` per wake.
- Runtime loops cancel cleanly under scope finalization.
- Operation handler errors remain typed, not `unknown`.

## Task R2 - Public Client And Substrate Surface Containment

Suggested owner: Agent 1 or Agent 2, but do not run in parallel with package
rename work.

Review findings: H1, H2, L4, L5, B2.

Goal: Make the public roots match the Firegrid architecture boundary. App-facing
client root should not leak legacy SubstrateClient/work/kernel vocabulary.
Substrate root should not export raw kernel internals as default public API.

ACIDs:

- `firegrid-remediation-hardening.PUBLIC_SURFACES.1`: The app-facing client root exports Firegrid operation, EventStream, client, error, and handle vocabulary only.
- `firegrid-remediation-hardening.PUBLIC_SURFACES.2`: Legacy SubstrateClient, work declaration, low-level kernel rows, row builders, wire envelope constants, and raw stream helpers are exported only from explicit compatibility or kernel subpaths.
- `firegrid-remediation-hardening.PUBLIC_SURFACES.3`: FiregridClient has one Context Tag identity, one service shape, and one configuration shape across the root client and browser-safe client surfaces.
- `firegrid-remediation-hardening.PUBLIC_SURFACES.4`: Browser-safe client subpaths cannot type-check as a full operation-capable FiregridClient unless they provide every full client method.
- `firegrid-remediation-hardening.PUBLIC_SURFACES.5`: The substrate package root exports only curated descriptor, schema, facade, EventStream, and choreography surfaces; raw kernel modules live behind an explicit kernel subpath.
- `firegrid-remediation-hardening.TEST_GUARDRAILS.1`: Client and substrate public export surfaces have allowlist or strict banned-vocabulary tests.
- `firegrid-architecture-boundary.SURFACE_AREA.1`: Firegrid APIs should reduce public concept count rather than introduce parallel composition systems.
- `firegrid-architecture-boundary.SURFACE_AREA.3`: Low-level kernel APIs live in substrate and are not re-exported from the app-facing client root.
- `firegrid-operation-messaging.APP_BOUNDARY.1`: The app-facing client root must not expose work declaration as the primary operation start API.
- `firegrid-operation-messaging.APP_BOUNDARY.2`: The app-facing client root must not expose run, claim, completion, terminalization, or row-builder vocabulary.
- `firegrid-event-streams.CLIENT_API.4`: Browser EventStream APIs must not import runtime or substrate internals.

Likely files:

- `packages/client/src/index.ts`
- `packages/client/src/firegrid/index.ts`
- `packages/client/src/firegrid/event-client.ts`
- `packages/client/src/firegrid/operation-client.ts`
- `packages/client/package.json`
- `packages/substrate/src/index.ts`
- `packages/substrate/package.json`
- `packages/client/src/__tests__/client-foundations.test.ts`
- `packages/substrate/src/__tests__/`
- `packages/runtime/src/__tests__/runtime-foundations.test.ts`

Acceptance checks:

- Public root export tests use allowlists where possible.
- Compatibility/kernel subpaths exist for tests and adapters that still need internals.
- No `as unknown as Context.Tag` joins two different client service shapes.

## Task R3 - Choreography And Operator Boundary Cleanup

Suggested owner: Agent 1.

Review findings: M1, 1a, 1c, E8.

Goal: Remove agent-tool dispatch from substrate kernel responsibility and keep
operator arbitration internals out of public app-facing surfaces.

ACIDs:

- `firegrid-remediation-hardening.ARCHITECTURE_BOUNDARIES.1`: Agent tool dispatch harnesses and runtime-specific tool schemas do not live in the substrate kernel package.
- `firegrid-remediation-hardening.ARCHITECTURE_BOUNDARIES.2`: Choreography primitives declare durable waits without owning unrelated runtime tool dispatch responsibilities.
- `firegrid-remediation-hardening.ARCHITECTURE_BOUNDARIES.3`: Choreography block-row authority is owned by the runtime or operator path specified by the substrate architecture, not by duplicated ad hoc writers.
- `firegrid-remediation-hardening.ARCHITECTURE_BOUNDARIES.4`: Operator claim, perform, and record phases are factored so internal arbitration outcomes do not become the public operation surface.
- `firegrid-remediation-hardening.EFFECT_CONSISTENCY.6`: Defect paths use explicit die messages or typed defects rather than generic Error construction.
- `effect-native-api.OPERATOR_PROGRAMS.1`: A durable operator is a scoped Effect program that consumes one semantic work type and invokes a provided handler after durable ownership is won.
- `effect-native-api.OPERATOR_PROGRAMS.4`: Handler success/failure terminalization semantics are owned by `claim-and-operator-authority`.
- `claim-and-operator-authority.OPERATOR_INVOCATION.11`: Slice 5 run terminalization is appended internally by the operator using state-machine events after ownership is won.
- `claim-and-operator-authority.PHASE_BOUNDARY.2`: This feature does not define run or completion state-machine transitions.

Likely files:

- `packages/substrate/src/choreography/tools.ts`
- `packages/substrate/src/choreography/errors.ts`
- `packages/substrate/src/choreography/service.ts`
- `packages/substrate/src/operator.ts`
- `packages/substrate/src/facade/work.ts`
- `packages/runtime/src/`
- `packages/substrate/src/__tests__/operator.test.ts`
- `packages/substrate/src/__tests__/choreography*.test.ts`

Acceptance checks:

- Substrate kernel no longer exports runtime-specific tool dispatch.
- Operator public API exposes claim/perform/record ergonomics, not arbitration enum plumbing.
- Choreography tests still prove durable wait declaration and suspension behavior.

## Task R4 - Shared Infrastructure Deduplication

Suggested owner: Agent 2.

Review findings: M2, M7, C5, C6, C7, C8, C9.

Goal: Remove duplicated append, database acquisition, state-machine build,
authoritative-run, fold, and envelope helper code without changing behavior.

ACIDs:

- `firegrid-remediation-hardening.CODE_REUSE.1`: Durable Streams append-with-json-and-error-mapping logic is centralized behind a shared helper.
- `firegrid-remediation-hardening.CODE_REUSE.2`: State-machine builder invocation and error mapping are centralized or eliminated by Effect-returning builders.
- `firegrid-remediation-hardening.CODE_REUSE.3`: Authoritative run lookup is centralized behind a shared helper.
- `firegrid-remediation-hardening.CODE_REUSE.4`: Projection read APIs reuse one parameterized projection implementation rather than parallel facade-specific implementations.
- `firegrid-remediation-hardening.CODE_REUSE.6`: Operation and EventStream envelope helpers live in the canonical schema or descriptor boundary selected by the architecture.
- `firegrid-remediation-hardening.HOT_PATHS.2`: Reusable scoped database acquisition is centralized for runtime and substrate projection readers.
- `firegrid-event-streams.SCHEMA_OWNERSHIP.4`: EventStream wire helpers preserve Durable Streams State Protocol row shape without importing substrate root internals.

Likely files:

- `packages/substrate/src/internal-claim.ts`
- `packages/substrate/src/waits.ts`
- `packages/substrate/src/producer.ts`
- `packages/substrate/src/subscribers.ts`
- `packages/substrate/src/operator.ts`
- `packages/substrate/src/choreography/service.ts`
- `packages/substrate/src/event-plane/producer.ts`
- `packages/substrate/src/facade/projection.ts`
- `packages/substrate/src/event-plane/projection.ts`
- `packages/runtime/src/runtime/internal/*.ts`
- `packages/substrate/src/schema/`
- `packages/substrate/src/descriptors/`

Acceptance checks:

- Behavior tests remain green.
- LOC decreases or duplicate search anchors disappear.
- Helper boundaries do not make browser-safe descriptor imports pull substrate root internals.

## Task R5 - EventPlane To EventStream Internal Migration

Suggested owner: Agent 2.

Review findings: M6, B5.

Goal: Finish the EventPlane to EventStream vocabulary migration internally
without changing caller-owned EventStream semantics or browser-safety.

ACIDs:

- `firegrid-remediation-hardening.CODE_REUSE.5`: EventPlane internals are migrated or deprecated in favor of EventStream vocabulary without changing the caller-owned stream semantics.
- `firegrid-event-streams.EVENT_STREAM_DEFINITION.1`: EventStream is the client and runtime-facing term for caller-owned typed event streams.
- `firegrid-event-streams.EVENT_STREAM_DEFINITION.4`: EventPlane may remain an internal substrate or migration term but is not the ergonomic app API name.
- `firegrid-event-streams.RUNTIME_API.1`: Runtime EventStream materializers are installed through Layer constructors.
- `firegrid-event-streams.RUNTIME_API.2`: Runtime EventStream materializers are not side-effecting global registration calls.
- `firegrid-event-streams.RUNTIME_API.3`: Runtime EventStream materializers compose with ordinary Effect Layer APIs.
- `firegrid-event-streams.SCHEMA_OWNERSHIP.1`: EventStream schemas are caller-owned and must not become substrate-native row families.
- `firegrid-event-streams.SCHEMA_OWNERSHIP.2`: EventStream materialized views do not replace substrate claim or completion authority.

Likely files:

- `packages/substrate/src/event-plane/*`
- `packages/substrate/src/descriptors/event-stream.ts`
- `packages/runtime/src/runtime/firegrid.ts`
- `packages/runtime/src/runtime/internal/event-stream-materializer.ts`
- `packages/client/src/firegrid/event-client.ts`
- related tests under `packages/substrate`, `packages/runtime`, and `packages/client`

Acceptance checks:

- Public EventStream descriptors and client/runtime APIs remain source-compatible.
- Any remaining EventPlane vocabulary is explicitly deprecated or internal-only.
- Browser-safe client subpath still avoids substrate root and runtime imports.

## Task R6 - Package Naming And Compatibility Migration

Suggested owner: Agent 1 after R2, or coordinator-owned if package churn blocks
parallel work.

Review findings: package migration, B6.

ACIDs:

- `firegrid-remediation-hardening.MIGRATION_BOUNDARIES.1`: Package renames to Firegrid names preserve temporary compatibility exports while new docs and tests prefer Firegrid vocabulary.
- `firegrid-package-migration.PACKAGE_NAMES.1`: The substrate package target name is `@firegrid/substrate`.
- `firegrid-package-migration.PACKAGE_NAMES.2`: The client package target name is `@firegrid/client`.
- `firegrid-package-migration.PACKAGE_NAMES.3`: The runtime package target name is `@firegrid/runtime`.
- `firegrid-package-migration.PACKAGE_NAMES.4`: The lab app workspace target name is `@firegrid/lab`.
- `firegrid-package-migration.COMPATIBILITY.1`: Compatibility exports may be kept temporarily during migration.
- `firegrid-package-migration.COMPATIBILITY.2`: Compatibility exports must point toward the Firegrid names in docs and tests.
- `firegrid-package-migration.COMPATIBILITY.3`: New public docs should prefer Firegrid names over durable-agent-substrate names.
- `firegrid-package-migration.COMPATIBILITY.4`: Migration must not reintroduce runtime-to-client package dependencies.

Likely files:

- `packages/client/package.json`
- `packages/substrate/package.json`
- `pnpm-workspace.yaml`
- internal imports across `packages/*`
- docs and tests that mention old package names

Acceptance checks:

- Old imports work only through deliberate compatibility paths.
- New docs/tests use `@firegrid/client` and `@firegrid/substrate`.
- Boundary tests prove runtime does not import client.

## Task R7 - Typed Error And Service Convention Sweep

Suggested owner: Agent 1.

Review findings: H3, M3, L2, C1, C2.

ACIDs:

- `firegrid-remediation-hardening.EFFECT_CONSISTENCY.1`: Each package uses one primary Effect service construction convention for its own public services.
- `firegrid-remediation-hardening.EFFECT_CONSISTENCY.2`: Public expected errors use Effect-compatible tagged data errors.
- `firegrid-remediation-hardening.EFFECT_CONSISTENCY.4`: Expected errors preserve typed error tags and do not collapse to unknown through catch-all Effect.try wrappers.
- `effect-native-api.EFFECT_SERVICES.6`: Expected producer failures are represented in the Effect error channel rather than as defects.
- `effect-native-api.EFFECT_SERVICES.11`: Public expected errors use Effect-compatible tagged data errors and remain recoverable through the Effect error channel.
- `effect-native-api.EFFECT_SERVICES.12`: Public APIs should compose with `Effect.provide`, `Layer`, `Effect.all`, and ordinary generator-style Effect programs without requiring a framework registry.

Scope:

- Convert the listed `extends Error` classes to `Data.TaggedError`.
- Pick and apply one substrate service convention.
- Remove catch-all `unknown` error channels in runtime operation handlers.

Acceptance checks:

- Tests assert `_tag`/tagged error behavior for representative errors.
- No public expected error class hand-rolls `_tag` by extending `Error`.
- No `as unknown as Context.Tag` remains in public service wiring after R2/R7.

## Task R8 - Test Guardrail Expansion

Suggested owner: Agent 2.

Review findings: M5, D1-D6.

ACIDs:

- `firegrid-remediation-hardening.TEST_GUARDRAILS.1`: Client and substrate public export surfaces have allowlist or strict banned-vocabulary tests.
- `firegrid-remediation-hardening.TEST_GUARDRAILS.2`: Runtime process binaries have behavioral tests for argument parsing, environment injection, child process exit propagation, and scope teardown.
- `firegrid-remediation-hardening.TEST_GUARDRAILS.3`: Runtime runner and operation handler internals have tests for due-time selection, subscription coalescing, database acquisition failures, scope teardown, and error propagation.
- `firegrid-remediation-hardening.TEST_GUARDRAILS.4`: EventStream client and runtime materializer tests cover malformed Firegrid event rows and schema decode failures.
- `firegrid-remediation-hardening.TEST_GUARDRAILS.5`: Restart tests prove runtime-owned materializers and in-flight waits can resume from durable rows after scope reconstruction.
- `firegrid-remediation-hardening.TEST_GUARDRAILS.6`: Multi-runtime tests prove claim and terminalization authority produce one durable terminal outcome for competing handlers.
- `firegrid-remediation-hardening.TEST_GUARDRAILS.7`: Lab React surfaces have behavioral tests for live session cancellation and user-facing typed EventStream workbench flows.
- `runtime-stress-and-restart.RESTART.1`: Runtime-owned materializers rebuild from durable rows after process restart.
- `runtime-stress-and-restart.RESTART.2`: Host Program Graphs resume progress from durable state after restart without relying on module-scope caches.
- `runtime-stress-and-restart.RESTART.3`: A restarted runtime-lab harness can continue an in-flight waitFor flow from durable state alone.
- `runtime-stress-and-restart.CONCURRENCY.1`: Two host processes running the same Host Program Graph against one stream do not create duplicate substrate terminal completions.

Acceptance checks:

- New tests fail on the exact review regression class, not only happy-path smoke.
- Behavioral tests avoid broad snapshot assertions.

## Task R9 - Portable IDs, Brands, And Small Polish

Suggested owner: Agent 1 or Agent 2 after P0 work.

Review findings: L3, E1, E2, E3, E6, E7.

ACIDs:

- `firegrid-remediation-hardening.EFFECT_CONSISTENCY.5`: Kernel ID generation is injectable or Effect-service-backed and avoids direct Node-only crypto imports in portable kernel paths.
- `firegrid-remediation-hardening.MIGRATION_BOUNDARIES.2`: Kernel brand policy for run, work, completion, claim, and owner identifiers is either implemented consistently or documented as a deliberate boundary.
- `firegrid-remediation-hardening.EFFECT_CONSISTENCY.6`: Defect paths use explicit die messages or typed defects rather than generic Error construction.

Scope:

- Replace direct `node:crypto` imports in kernel paths with a small ID service or Effect-backed generator.
- Decide whether to retrofit kernel ID brands or document the boundary.
- Centralize Schema `AnyNoContext` casting helpers.
- Replace structurally unreachable public error fallbacks with explicit defects where appropriate.

## Task R10 - Paused Client And Lab Cleanup

Suggested owner: Agent 2 after R0-R3 are underway or complete.

Review findings: H5, L1, L4, L5, E4, E5, D6.

ACIDs:

- `firegrid-remediation-hardening.PUBLIC_SURFACES.3`: FiregridClient has one Context Tag identity, one service shape, and one configuration shape across the root client and browser-safe client surfaces.
- `firegrid-remediation-hardening.PUBLIC_SURFACES.4`: Browser-safe client subpaths cannot type-check as a full operation-capable FiregridClient unless they provide every full client method.
- `firegrid-remediation-hardening.TEST_GUARDRAILS.7`: Lab React surfaces have behavioral tests for live session cancellation and user-facing typed EventStream workbench flows.
- `firegrid-operation-messaging.CLIENT_MESSAGING.7`: Client operation send and call options support idempotency keys.
- `runtime-lab-inspector.LIVE_FOLLOW.1`: The lab supports replay plus live-follow for stream-shaped data.
- `runtime-lab-inspector.LIVE_FOLLOW.3`: Browser live-follow code must not use fixed-interval polling as its primary update mechanism.

Scope:

- Fix or land the already-started idempotency and RawStreamInspector cleanup only when coordinator reopens client/lab cleanup.
- Hoist per-call client layer construction in operation-client and lab helpers.
- Reconcile `FiregridClientConfig.clientId` optional/required mismatch.

## Review Finding Traceability

| Finding | Task(s) |
|---|---|
| H1 client root legacy exports | R2 |
| H2 dual FiregridClient tags/live/config | R2, R10 |
| H3 mixed Effect service idioms | R7 |
| H4 hot-path rebuilds | R1 |
| H5 RawStreamInspector leak | R10 |
| M1 choreography tools in kernel | R3 |
| M2 duplicate append/acquireDb/tryBuild/authoritativeRun | R4 |
| M3 extends Error classes | R7 |
| M4 hand-rolled subscriber loops | R1 |
| M5 missing behavioral tests | R8 |
| M6 EventPlane to EventStream debt | R5 |
| M7 schema/helper placement | R0, R4 |
| L1 idempotencyKey dropped | R10 |
| L2 catch-all unknown errors | R1, R7 |
| L3 node:crypto in kernel | R9 |
| L4 clientId config mismatch | R2, R10 |
| L5 partial firegrid subpath | R2, R10 |
| B1 choreography tools extraction | R3 |
| B2 kernel subpath / root curation | R2 |
| B3 projection unification | R4 |
| B4 operator pipeline factoring | R3 |
| B5 EventStream internal migration | R5 |
| B6 package rename | R6 |
| C1 Data.TaggedError migration | R7 |
| C2 service convention | R7 |
| C3 Stream.async loops | R1 |
| C4 completion.data decoders | R4, R8 |
| C5 acquireSubstrateDb helper | R1, R4 |
| C6 appendChange helper | R4 |
| C7 authoritativeRun helper | R4 |
| C8 Effect-returning builders | R0, R4 |
| C9 schema/envelope/builder placement | R0, R4 |
| D1 binary tests | R8 |
| D2 runner tests | R1, R8 |
| D3 EventStream decode tests | R8 |
| D4 restart resume tests | R1, R8 |
| D5 multi-runtime claim test | R8 |
| D6 lab behavior tests | R8, R10 |
| E1 event IDs | R9 |
| E2 unreachable fallback defects | R9 |
| E3 Schema cast helper | R9 |
| E4 client layer hoist | R10 |
| E5 lab client layer hoist | R10 |
| E6 portable ID service | R9 |
| E7 brand policy | R9 |
| E8 dieMessage cleanup | R3, R9 |
