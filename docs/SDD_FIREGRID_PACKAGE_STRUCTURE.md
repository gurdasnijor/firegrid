# SDD: Firegrid Package Structure

Status: Draft
Product: Firegrid
Related: Firegrid package migration, architecture boundary, repo hygiene

## Summary

Firegrid has outgrown `substrate` as a useful design noun. The current durable
core package aggregates responsibilities that need to be reasoned about
independently: wire protocol, execution state, state storage, projections, and
state-machine transitions.

This SDD proposes a domain model first, then derives package and directory
boundaries from it. The immediate target is not to split the durable core into
multiple workspace packages. The immediate target is to make the current package
structure communicate the real concepts clearly enough that future package
splits, if needed, are mechanical rather than speculative.

## Background

Already completed:

- Lab moved from `packages/lab` to `apps/lab`.
- Firegrid package names replaced legacy package imports.

This SDD is intentionally scoped after those mechanical cleanups and after the
strict baseline pass. It does not propose product behavior changes.

Non-goals:

- Do not change durable wire formats.
- Do not change runtime semantics.
- Do not split the durable-core aggregate into multiple workspace packages yet.
- Do not add product features during package-structure cleanup.

We expect `substrate` to persist informally as shorthand for the durable-core
aggregate. The claim here is narrower: `substrate` should not be the named
design boundary.

## Domain Model

The target concepts are:

```txt
Protocol
  durable schemas, descriptors, envelopes, and wire compatibility

State Store
  durable stream and database integration, retained records, and replay

Projection
  materialized read models and rebuild logic

State Machine
  legal transitions, claims, terminalization, and execution event builders

Client
  app-facing API for operation messages and caller-owned EventStreams

Runtime
  server-side participant that runs handlers and materializers

Apps
  concrete UIs and processes that compose packages
```

These concepts separate questions that currently collapse into one package:

- Protocol answers: what is the durable wire contract?
- State Store answers: how are durable records appended, retained, and replayed?
- Projection answers: how are read models rebuilt and queried?
- State Machine answers: which execution-state transitions are legal?
- Client answers: what can application code send or observe?
- Runtime answers: how does server-side execution advance durable work?
- Apps answer: how are packages composed into a concrete UI or process?

The split matters because import direction and write permission are separate
concerns.

## Writes Vs Imports

Import direction controls code dependency. Write permission controls who is
allowed to create durable facts.

Allowed import direction:

```txt
state-machine -> protocol
state-store   -> protocol
client        -> protocol, state-store, and projection-facing APIs
runtime       -> protocol, state-store, projection, state-machine
apps          -> client and runtime
```

Write direction:

```txt
clients append caller-owned messages and events
runtimes append execution facts through state-machine APIs
state machine validates legal durable transitions
state store persists and replays durable records
projection builds read models from durable records
protocol defines the wire contract
```

Example: runtime must not import client. The client owns caller-facing message
and EventStream APIs. The runtime owns execution. If runtime imports client, it
creates a path where runtime code can behave like a caller and append
caller-owned events through the app SDK instead of advancing execution through
state-machine APIs. That blurs who is acting and bypasses the intended review
surface for execution facts.

Example: state-machine code may use protocol types, but protocol must not use
state-machine code.
Schemas and descriptors must be reusable for decoding historical records
without pulling in state-machine legality, claim arbitration, or runtime behavior.

## Current Problems

### Client Shape

`packages/client` mixes the public Firegrid client with old lower-level work
machinery and repeats the product name inside the package.

Examples:

- `packages/client/src/firegrid/client.ts` defines the Firegrid client service
  tag, config, and service shape, but `firegrid/` adds no information inside
  `@firegrid/client`.
- `packages/client/src/client/service.ts` defines the old work-oriented client
  service.
- `packages/client/src/firegrid/operation-client.ts` builds the public
  Firegrid client as a facade over that lower-level work service.

The current names are historically explainable, but not semantically useful. A
reader cannot tell from `client/` versus `firegrid/client.ts` which module owns
the app-facing API and which module is lower-level internal machinery.

### Runtime Shape

`packages/runtime` is both an importable runtime package and a CLI/process
package. Its public package root exports runtime APIs while the package also
owns `bin/firegrid.ts`. It also repeats the package role with a nested
`src/runtime/` folder.

The file `packages/runtime/src/runtime/firegrid.ts` is another symptom. It is
not named for responsibility. It defines runtime layer helpers for handlers,
EventStream materializers, and low-level subscribers.

### Durable-Core Shape

The current durable-core aggregate contains Protocol, State Store, Projection,
and State Machine in one package. That is acceptable for now, but the internal
layout should make the conceptual boundary obvious.

Current root-level files mix:

- durable schemas
- descriptors and envelopes
- transition builders
- retained records
- projections
- execution event writers
- waits and subscribers
- choreography facade

That makes it harder to answer a basic review question: is this change about
wire compatibility, state-store mechanics, projection behavior, or state-machine legality?

## Current Durable-Core Classification

The current `packages/substrate/src` files classify roughly as follows:

| Current path | Concern | Target home | Notes |
| --- | --- | --- | --- |
| `schema/rows.ts` | State model / wire row schemas | `protocol/schema/rows.ts` | Defines durable row families and row value schemas. |
| `schema/state.ts` | State model / collection schema | `protocol/schema/state.ts` | Defines the Durable Streams State schema. |
| `schema/ready-work.ts` | Projection output schema | `projection/ready-work/schema.ts` | This is a read-model contract, not a general durable row schema. |
| `descriptors/operation.ts` | Protocol descriptor | `protocol/descriptors/operation.ts` | Operation descriptor and handle vocabulary belongs in protocol. |
| `descriptors/event-stream.ts` | Protocol descriptor | `protocol/descriptors/event-stream.ts` | EventStream descriptors are protocol, not state-store logic. |
| `descriptors/append.ts` | State-store write helper | `state-store/append.ts` | This serializes and appends change events; it is misplaced under descriptors. |
| `stream.ts` | State-store integration | `state-store/stream.ts` | Owns Durable Streams / StreamDB acquisition and rebuild mechanics. |
| `retained-records.ts` | State-store replay helpers | `state-store/retained-records.ts` | Reads retained durable rows in append order. |
| `projection.ts` | Projection snapshot model | `projection/snapshot.ts` | Defines snapshot shape derived from the state store. |
| `projection-service.ts` | Projection service primitive | `projection/service.ts` | Generic snapshot/stream/until service builder. |
| `projection/ready-work.ts` | Projection derivation | `projection/ready-work/derive.ts` | Pure read-model derivation from a snapshot. |
| `facade/projection.ts` | Public projection API | `projection/public-service.ts` | Should be named by the capability, not by `facade`. |
| `schema/state-machine.ts` | State machine | `state-machine/transitions.ts` | Transition legality and Effect-returning event builders. |
| `state-machine.ts` | Compatibility wrappers | `kernel/state-machine-compat.ts` or remove | Sync wrappers over Effect state-machine builders. |
| `producer.ts` | State-machine write service | `state-machine/producer.ts` | Declares work and completion outcomes through legal event builders. |
| `operator.ts` | State-machine execution coordinator | `state-machine/operator.ts` | Claims ready work and records terminal outcomes. |
| `operator-errors.ts` | State-machine errors/folds | `state-machine/errors.ts` | Claim fold and claim-related errors. |
| `internal-claim.ts` | State-machine claim helper | `state-machine/claims.ts` | Shared durable claim implementation. |
| `waits.ts` | State-machine wait helpers | `state-machine/waits.ts` | Writes wait/blocking state transitions. |
| `subscribers.ts` | State-machine subscriber helpers | `state-machine/subscribers.ts` | Advances durable completions from stream snapshots. |
| `event-plane/*` | Legacy event-plane compatibility | retire or split into protocol/state-store/projection | This should not remain a top-level durable-core concept if EventStream is canonical. |
| `facade/work.ts` | Public work-claim API | `state-machine/work-claim.ts` or higher-level workflow API | Crosses claim and workflow concerns; should not stay under generic `facade`. |
| `choreography/*` | Higher-level workflow facade | `choreography/*` or future package | This is a separate high-level API over durable execution, not protocol/state-store/projection. |
| `kernel/index.ts` | Compatibility/export boundary | `kernel/index.ts` | Keep only as an explicit escape hatch, and shrink over time. |

What belongs in the durable-core aggregate:

- protocol definitions that describe durable wire records and descriptors
- state-store code that appends, retains, replays, and rebuilds durable records
- projection code that derives read models from durable state
- state-machine code that validates and emits legal execution transitions

What is questionable inside the durable-core aggregate:

- generic facade folders that hide the actual capability
- legacy EventPlane modules now superseded by EventStream vocabulary
- high-level choreography APIs if they grow into their own workflow-facing
  package
- compatibility barrels that make internal imports easy again

## Dependency Graph Observations

The regenerated dependency graphs are supporting evidence for this SDD:

- `docs/dependency-graph.mmd`
- `docs/dependency-graph.svg`
- `docs/dependency-graph-modules.svg`
- `docs/dependency-graph-archi.svg`
- `docs/dependency-graph-client.mmd`
- `docs/dependency-graph-runtime.mmd`
- `docs/dependency-graph-substrate.mmd`

The graph artifacts are generated by `pnpm run graph`. Visualization commands
exclude tests and build outputs so the diagrams reflect production source
shape. The graph makes the structural drift visible.

At the package level, the intended direction is mostly present: apps depend on
packages, runtime and client do not depend on each other, and the durable-core
package sits underneath both. The mess is inside package internals.

The problem is not the number of edges by itself. A stateful runtime will have
real dependencies. The problem is that edges do not correspond to concepts a
reviewer can name. Product-named folders point at legacy folders, generic
facade folders group unrelated capabilities, and `kernel` exports nearly every
internal module. That makes it hard to tell whether a change is touching
protocol, state-store, projection, state-machine, client, or runtime behavior.

### Client Graph

Current shape:

```txt
client/src/index.ts -> client/src/firegrid
client/src/firegrid -> client/src/client
```

Problem:

The public client root points at a product-named folder, which then points at an
old lower-level `client/` folder. That reveals the migration history rather
than the API model. The graph should instead read as:

```txt
index.ts -> service.ts
index.ts -> operations.ts
index.ts -> event-streams.ts
operations.ts -> internal/work-client.ts
```

### Runtime Graph

Current shape:

```txt
runtime/src/index.ts -> runtime/src/runtime
runtime/src/runtime -> runtime/src/boot
```

Problem:

The package repeats its own role with `src/runtime/`, and the implementation
file currently named `runtime/firegrid.ts` owns handlers, materializers, and
subscriber helpers. The graph should instead expose role names directly:

```txt
index.ts -> service.ts
index.ts -> boot.ts
index.ts -> handlers.ts
index.ts -> materializers.ts
index.ts -> subscribers.ts
handlers.ts -> internal/operation-handler.ts
materializers.ts -> internal/event-stream-materializer.ts
```

### Durable-Core Graph

Current graph highlights:

```txt
index.ts -> choreography
index.ts -> descriptors
index.ts -> facade

kernel -> descriptors
kernel -> event-plane
kernel -> facade
kernel -> internal-claim.ts
kernel -> operator.ts
kernel -> producer.ts
kernel -> projection.ts
kernel -> projection/ready-work.ts
kernel -> retained-records.ts
kernel -> schema
kernel -> state-machine.ts
kernel -> stream.ts
kernel -> subscribers.ts
kernel -> waits.ts
```

Problem:

`kernel` is a graph sink that exports almost every internal concern. That makes
it a compatibility escape hatch rather than a design boundary. `facade` is also
not a concept; it groups projection and work-claim APIs by exposure style
rather than by domain responsibility.

The durable-core graph should move toward:

```txt
protocol/schema       -> no durable-core imports
protocol/descriptors  -> protocol/schema

state-store           -> protocol/schema
projection            -> state-store + protocol/schema
state-machine         -> protocol + state-store + projection as needed
choreography          -> state-machine + projection + protocol

kernel                -> explicit compatibility subpaths only
```

EventPlane is also visible as a separate island:

```txt
event-plane -> descriptors
event-plane -> projection-service
event-plane -> stream
```

If EventStream is canonical, EventPlane should not remain a top-level durable
core concept. Its remaining pieces should either be retired or redistributed
into Protocol, State Store, and Projection.

## Target Workspace Shape

Workspace categories:

```txt
apps/*      standalone UIs and processes
packages/*  importable library boundaries
```

Target workspace shape:

```txt
apps/
  lab/
  firegrid-cli/        # optional future split from packages/runtime/bin

packages/
  client/
  runtime/
  substrate/           # temporary aggregate: protocol + state-store + projection + state-machine
```

`packages/substrate` is a temporary aggregate name. The internal directories
should use the real design nouns.

## Package Roles

### `packages/client`

The client package is the app-facing Firegrid SDK.

It should expose one main concept at the public root: `FiregridClient`.

Target internal shape:

```txt
packages/client/src/
  index.ts
  service.ts
  operations.ts
  event-streams.ts
  internal/
    work-client.ts
    work-facet.ts
```

Rules:

- Public Firegrid service tag/config/service types live in
  `service.ts`.
- Operation messaging behavior lives in `operations.ts`.
- EventStream behavior lives in `event-streams.ts`.
- Browser-safe APIs are either exported from a clearly named subpath or folded
  into the root surface if they are safe for all consumers.
- Lower-level work machinery is either removed or moved under `internal/`.
- Legacy substrate vocabulary should not remain in public client APIs.
- The package must not contain a nested `firegrid/` folder; the package name
  already supplies that context.

### `packages/runtime`

The runtime package is the importable server-side runtime library.

Target internal shape:

```txt
packages/runtime/src/
  index.ts
  service.ts
  context.ts
  boot.ts
  handlers.ts
  materializers.ts
  subscribers.ts
  internal/
    runner.ts
    operation-handler.ts
    event-stream-materializer.ts
    stream-resolver.ts
    wake-stream.ts
```

Rules:

- Importable runtime APIs stay in `packages/runtime`.
- Process and CLI entrypoints move to `apps/firegrid-cli` if the CLI grows
  beyond a thin wrapper.
- Runtime files are named for responsibility, not product name. A public
  namespace named `Firegrid` may still be exported if it is the chosen API, but
  its implementation file should be named by role, such as `runtime-api.ts`,
  `handlers.ts`, or `materializers.ts`.
- The package must not contain a nested `runtime/` folder; the package name
  already supplies that context.

### Durable Core

Protocol, State Store, Projection, and State Machine may initially remain
implemented inside `packages/substrate`, but the internal layout should make
ownership explicit.

Target internal shape:

```txt
packages/substrate/src/
  index.ts
  protocol/
    schema/
    descriptors/
  state-store/
    stream.ts
    retained-records.ts
  projection/
  state-machine/
    transitions/
    producer.ts
    waits.ts
    subscribers.ts
    claims.ts
  choreography/
  kernel/
```

Rules:

- Durable row and state schemas live under `protocol/schema/`.
- Operation and EventStream descriptors live under `protocol/descriptors/`.
- Stream integration, retained records, and replay logic live under
  `state-store/`.
- Projection readers and rebuild logic live under `projection/`.
- Transition legality, execution event builders, producers, waits, subscribers,
  and claims live under `state-machine/`.
- `kernel/` is only for documented low-level compatibility and escape-hatch
  exports. It is not a general internal-module bucket.
- Public exports remain curated from package roots and explicit subpaths, with
  export allowlist tests.
- If these concepts become separate workspace packages, package `exports`
  should become the primary boundary. Consumers should only reach them through
  package-qualified imports such as `@firegrid/protocol` or documented subpaths,
  never through relative paths into another package.

## Naming Principle

Names describe responsibility, not product branding or generic role.

Examples:

```txt
runtime/firegrid.ts       -> runtime-api.ts or handlers.ts
firegrid/client.ts        -> service.ts
client/service.ts         -> internal/work-client.ts
projection-service.ts     -> projection/service.ts
state-machine.ts          -> state-machine/transitions.ts
```

Generic names are acceptable only at known boundaries:

- `index.ts` for package and subpath entrypoints.
- `service.ts` for Effect service tag and service interface definitions.
- `layer.ts` or `boot.ts` for Effect Layer construction.

## Static Guards

The architecture must be encoded in CI, not only in review notes.

Required guard properties:

- packages must not import apps
- packages must not import other workspace packages by relative path
- cross-package imports must use package-qualified import names and package
  `exports`
- runtime must not import client
- client must not import runtime
- durable core must not import client, runtime, or apps
- protocol must not import state-store, projection, or state-machine
- state-store must not import projection, state-machine, or runtime
- projection must not import runtime
- state-machine must not import runtime
- apps may depend downward on public package entrypoints
- internal modules may not be imported across package boundaries except through
  documented subpaths

Package `exports` are the preferred boundary for separate workspace packages:
if a module is not exported by the package root or an explicit subpath, other
packages should not be able to import it. Dependency-cruiser and ESLint should
enforce package-qualified cross-package imports so those `exports` remain
load-bearing.

Dependency-cruiser remains necessary for transitional same-package layer rules.
While Protocol, State Store, Projection, and State Machine live together inside
`packages/substrate`, package `exports` cannot prevent same-package relative
imports such as `protocol -> state-store`; dependency-cruiser must enforce those
internal directional rules until the concepts become separate packages.

### Effect Artifact Inventory

Import graphs answer where files point. They do not answer which Effect
capabilities cross a boundary. Firegrid also needs an Effect-aware inventory
that classifies exported artifacts and resolves service requirements.

Spec anchors:

- `firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.1`
- `firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.2`
- `firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.3`
- `firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.4`
- `firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.5`

The proposed tool should use `ts-morph` over the package tsconfigs and emit
structured JSON before rendering human reports. The collector should walk
`packages/*/src` and `apps/*/src`, enumerate exported declarations, and
classify each export into the repo's Effect vocabulary:

- `Context.Tag` service tags
- `Layer.Layer` values and layer constructors
- `Schema.Schema` values and tagged schema constructors
- `Data.TaggedError` subclasses
- functions and values returning `Effect.Effect<A, E, R>`
- service interfaces paired with tags
- plain TypeScript types and interfaces
- constants and pure helpers

For Effect-returning exports, the inventory should record the `A`, `E`, and `R`
channels and flatten the `R` channel into service requirements where TypeScript
can resolve them. Each requirement should record the declaration location of
the tag or service shape. That lets the boundary report identify leaks such as
a public client export requiring a durable-core service, or a State Store export
requiring a State Machine service.

The tool should produce two initial views from the same JSON:

```txt
effect-artifacts.json
  one normalized record per export, including original declaration location and
  whether the export was declared locally or re-exported through a barrel

effect-boundary-report.md
  human-readable per-file inventory plus cross-boundary Effect requirement
  edges grouped by package or durable-core layer
```

The violation pass should consume the inventory and a small boundary rules file.
The collector should not encode the architecture itself. When a durable-core
layer becomes a real workspace package, the rules file should change but the
collector should not.

This complements dependency-cruiser:

- dependency-cruiser enforces import reachability and forbidden file edges
- package `exports` enforces public module availability across packages
- the Effect artifact report explains which exported services, Layers, Schemas,
  typed errors, and `R`-channel requirements actually cross those boundaries

### Effect Inventory Evidence

PR #27 introduced the first Effect artifact inventory report. A local
higher-fidelity pass now adds architecture-layer classification, Layer channel
extraction, export-pressure tables, and same-package durable-core import layer
crossings.

Report source:

- `docs/effect-artifact-inventory.md`
- `docs/effect-artifact-inventory.json`

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

The declaration workspace distribution is the strongest signal:

| Workspace | Declared exported artifacts | Effect-returning artifacts | Re-exports through barrels |
| --- | ---: | ---: | ---: |
| `packages/client` | 67 | 0 | 38 |
| `packages/runtime` | 37 | 6 | 10 |
| `packages/substrate` | 651 | 43 | 413 |
| `apps/lab` | 8 | 1 | 0 |

This supports the SDD's structural claim. The current problem is not primarily
cross-package Effect requirement leakage. The larger problem is concentration,
re-export pressure, and ambiguous same-package ownership: `packages/substrate`
exports most artifacts and most re-exports, while its internal folders mix
protocol schemas, state-store effects, projection helpers, state-machine
transitions, choreography services, facade services, and compatibility exports.

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

Substrate-local hotspots from the current inventory:

| Substrate area | Exported artifacts | Effect-returning artifacts | Re-exports |
| --- | ---: | ---: | ---: |
| `choreography` | 120 | 0 | 80 |
| `descriptors` | 109 | 3 | 82 |
| `facade` | 68 | 0 | 51 |
| `schema` | 135 | 11 | 85 |
| `event-plane` | 50 | 1 | 29 |
| `subscribers.ts` | 34 | 12 | 17 |
| `stream.ts` | 16 | 4 | 8 |
| `retained-records.ts` | 10 | 8 | 5 |

The same-package import layer report currently identifies four edges that need
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
- Zero package-boundary Effect requirement crossings means package `exports`
  plus dependency-cruiser can focus first on public surface containment and
  same-package durable-core layering, rather than unwinding existing foreign
  service requirements.
- The 48 `unknown` classifications should remain visible as a tooling follow-up
  so architecture review does not over-trust an incomplete classifier.

### Effect Practice Detectors

The external `effect-ts-detectors` project is also relevant as an advisory
static-analysis input:

- `https://github.com/andrueandersoncs/claude-skill-effect-ts/tree/main/effect-ts-detectors`

Its README describes AST detectors for Effect-TS
anti-pattern categories such as async APIs, imperative control flow, native
APIs, untyped errors, direct discriminated-union tag access, services, schema,
and testing. It also documents important limitations: the detectors are
heuristic, do not use full type-checker information, and can produce false
positives.

That makes it a useful future advisory guard, not an immediate strict CI gate.
Firegrid should first evaluate the detector categories against current source,
triage false positives, and then either port high-confidence checks into local
ESLint/Semgrep rules or run the detector as a non-blocking architecture report.

Two local review documents capture the first pass over those detectors:

- `docs/REVIEW_EFFECT_TS_DETECTOR_FINDINGS_2026-05-05.md`
- `docs/REVIEW_EFFECT_CODE_STYLE_2026-05-05.md`

Detector summary:

| Input | Finding |
| --- | --- |
| Files analyzed | 68 production TypeScript files |
| Definite detector findings | 277 |
| Detector errors | 1 detector crash in `native-apis/rule-001-array-operations` |
| Largest rule bucket | `errors/rule-002` with 83 findings |
| Largest workspaces | `packages/substrate` 163, `packages/runtime` 48, `apps/lab` 37, `packages/client` 29 |

Architecture implications:

- The findings reinforce the durable-core hotspot list. The highest-count
  files overlap with the Effect inventory hotspots: `event-plane/producer.ts`,
  `subscribers.ts`, `schema/state-machine.ts`, `stream.ts`, `waits.ts`,
  `operator.ts`, and runtime handler/materializer internals.
- Async escape hatches in storage, stream, runtime, and lab paths are stronger
  remediation candidates than broad conditional rewrites because they cross the
  Effect boundary directly.
- Direct `_tag` checks on `Option`, `Exit`, and domain unions are low-count and
  high-signal; these can likely become a strict local rule after cleanup.
- Imperative loop findings are bounded but touch hot paths. They should be
  remediated only with focused behavior tests around state-machine folds,
  retained-record reads, projection rebuilds, and runtime loops.
- Schema-first boundary modeling is a design decision, not only style. Boundary
  inputs/results in subscribers, waits, stream resolution, and operation state
  should be evaluated for `Schema.Class` / `Schema.Union` conversion because
  that would make raw JSON trust boundaries explicit.
- Error modeling is a policy decision. The detector recommends
  `Schema.TaggedError`, while recent remediation standardized many expected
  in-process failures on `Data.TaggedError`. Before enforcing either direction,
  decide whether each error family crosses durable storage, transport, or human
  inspection boundaries. Wire-crossing errors should favor schema-backed
  encoding; purely in-process defects may remain `Data.TaggedError` if that is
  the documented policy.

Operational guidance:

- Keep detector output advisory until the detector crash is fixed and false
  positives are filtered.
- Prefer porting high-confidence categories into local strict rules after
  cleanup: direct `_tag` access, async boundary escapes, selected imperative
  loops, and maybe `new Map` / `new Set` in durable-core projection paths.
- Do not strict-gate broad `Option`/ternary/style rewrites before remediation;
  the reviews classify many of those as micro-syntax style debt rather than
  architecture defects.

The raw detector file at `/tmp/firegrid-detect.json` was also inspected. It is
not committed because it includes tests, fixtures, generated guard fixtures, and
all detector categories. Filtered to production source under `packages/*/src`
and `apps/*/src`, excluding tests and fixtures, it contains roughly 900
findings, with 272 definite findings. The highest-signal categories remain the
same as the curated reviews: conditionals, error modeling, async boundaries,
imperative loops, schema boundary modeling, and direct discriminant checks.

### Effect Skill Review Inputs

Three additional skill-focused reviews refine the remediation plan:

- `docs/REVIEW_EFFECT_CONCURRENCY_2026-05-05.md`
- `docs/REVIEW_EFFECT_CONFIGURATION_2026-05-05.md`
- `docs/REVIEW_EFFECT_RESOURCE_MANAGEMENT_2026-05-05.md`

Concurrency implications:

- The runtime's long-running loops are structurally sound: `Stream.asyncScoped`
  and `Effect.forkScoped` are used under scoped layers for runner,
  operation-handler, and materializer lifetimes.
- The deadline timer in `packages/runtime/src/runtime/internal/runner.ts`
  should use `Effect.forkScoped` rather than bare `Effect.fork`.
- The operation-handler's serial dispatch is an intentional v1 invariant and
  should be named in code before any future concurrency expansion.
- Choreography suspension via `Effect.interrupt` remains a deliberate design
  decision because suspension must be durable, not in-process.

Configuration implications:

- Firegrid has one production `process.env` read,
  `packages/runtime/bin/firegrid.ts`, and otherwise passes plain config shapes
  through Layers.
- The right Effect Config adoption point is the binary/runtime boundary, not
  every downstream `*Config` interface.
- A future `RuntimeConfigLive` layer should read `DURABLE_STREAMS_URL` via
  `Config.option(Config.string(...))`, validate the URL, and provide
  `RuntimeContext`.
- Do not make substrate/client layer factories read environment variables
  directly; they should continue receiving plain values from the runtime edge.

Resource-management implications:

- `acquireSubstrateDb`, `acquireStreamDb`, `wakeStream`, projection streams, and
  runtime materializer sessions already follow scoped acquire/release patterns.
- `packages/client/src/firegrid/operation-client.ts` still builds
  `SubstrateClientLive(substrateCfg)` per public client call. That means
  send/result/call can open, preload, and close a StreamDB per operation. This
  is a stronger client-structure issue than a naming issue.
- `apps/lab/src/lab/RawStreamInspector.tsx` still owns an unscoped live stream
  session. It should mirror the `Effect.runFork` / `Fiber.interrupt` boundary
  used by `LabEventStreamPanel`.
- `packages/substrate/src/retained-records.ts` opens a non-live stream session
  for hot-path reads without an explicit `cancel()` finalizer. It should use an
  `Effect.acquireRelease` bracket around the stream session.
- The repeated `new DurableStream(...)` construction pattern is not currently a
  leak if the handle remains disposable-free, but it is an architectural seam.
  A future scoped helper can centralize the construction before the upstream
  client grows release semantics.

These reviews do not change the package-boundary target, but they do change the
order of cleanup. The highest-leverage next slices are:

1. Fix scoped resource leaks and per-call layer construction before large naming
   moves.
2. Add runtime/config boundary cleanup at `bin/firegrid.ts` and
   `RuntimeContext`.
3. Triage Data-vs-Schema tagged error policy before running broad error
   codemods.
4. Use detector-backed strict rules only after the corresponding source cleanup
   lands.

Dependency-cruiser and ESLint are the current enforcement tools. If those tools
change, the same properties must remain enforced by CI.

## Migration

Prerequisites:

1. Firegrid package/name cutover is merged.
2. Strict baseline cleanup is merged, so the repo carries no warnings or
   findings that would hide structure regressions.

Migration steps:

1. Normalize `packages/client` internals and remove legacy substrate vocabulary
   from the client package.
2. Rename responsibility-less runtime files and split runtime helpers by role.
3. Decide whether `packages/runtime/bin` should move to `apps/firegrid-cli`.
4. Normalize the durable-core aggregate into protocol, state-store, projection,
   state-machine, choreography, and kernel folders.
5. Add or tighten static guards for any new directory boundaries.
6. Add the Effect artifact inventory and boundary report before promoting
   internal durable-core folders into separate workspace packages.
7. Triage Effect detector findings into policy decisions, remediation slices,
   and future local strict rules.
8. Address resource/configuration findings that would otherwise obscure package
   boundary cleanup, especially per-call client layer construction and unscoped
   stream sessions.

## Success Criteria

After this restructuring:

- a new contributor can tell from a file path whether a change touches wire
  protocol, state-store mechanics, projections, state-machine transitions,
  app-facing client API, or runtime execution
- public package roots expose curated concepts rather than historical internal
  vocabulary
- import boundaries and write boundaries are both represented in CI
- Effect service, Layer, Schema, tagged-error, and `R`-channel requirements can
  be reviewed from generated inventory rather than inferred from scattered
  exports
- no runtime behavior or durable wire format changed as a side effect of moving
  files

## Open Questions

1. Should the runtime CLI become `apps/firegrid-cli` immediately, or only after
   the CLI grows beyond the current wrapper?
2. Should the durable-core aggregate keep the package name
   `@firegrid/substrate` temporarily, or should the target package name become
   one of the real concepts such as `@firegrid/state-machine`,
   `@firegrid/state-store`, or `@firegrid/protocol`?
