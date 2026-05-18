# Firegrid API Footgun And Deletion Inventory

Date: 2026-05-07

Lane: parallel spike, API footgun and deletion inventory.

Worktree: `/Users/gnijor/gurdasnijor/firegrid/.worktrees/api-footgun-inventory`

Baseline: clean `origin/main` worktree at `eb7735c feat(client): add projection query facade (#119)`.

## Verdict

Verdict: mixed, leaning API design debt.

There is documentation debt: `docs/patterns/README.md` is referenced by the dispatch but is absent on `origin/main`; proposal-era docs still describe lower-level projection handles; LT-02 guidance still points readers toward browser `@firegrid/substrate/event-plane` reads; and `apps/flamecast` still contains known-bad topology and direct Durable Streams runtime scaffolding.

The decision-tree complexity is not mostly documentation debt. It is evidence that Firegrid has not yet provided a default app-construction profile. A basic app author still has to decide among `Firegrid.handler`, runtime subscribers, `RunWait`, `PlaneProducer`, `EventPlane`, `EventStream`, `projection-query`, manual `Layer` provisioning, runtime registration, CLI attach semantics, and product topology. The APIs are individually coherent as low-level primitives, but too many of them are currently public, documented, or easy to import as if they were the normal app path.

## Source Evidence Read

- Removed historical handoff notes: source-of-truth warning; current
  `apps/flamecast` topology/runtime code is bad code, not a pattern; Firegrid
  CLI is attached-only and reads `DURABLE_STREAMS_URL`.
- `/private/tmp/firegrid-runtime-ergonomics-sdd/docs/proposals/SDD_FIREGRID_RUNTIME_ERGONOMICS.md`: explicitly says the problem is not just docs; app authors should not see `ctx`, handler facades, `RunWait`, `PlaneProducer`, or app-authored EventStream sink calls in the default stream graph.
- `docs/patterns/README.md`: missing on `origin/main`.
- `packages/client/README.md`: current public client and projection-query examples.
- `packages/runtime/README.md`: current runtime handler, event stream materializer, subscriber, and composeRuntime examples.
- `packages/runtime/bin/firegrid.ts`: attached runtime CLI only.
- `packages/client/src/**`, `packages/runtime/src/**`, `packages/substrate/src/**`.
- Acai features under `features/firegrid/**` and `features/flamecast/flamecast-product-contract.feature.yaml`.

## Inventory

| Surface | Current public evidence | Feature evidence | Classification | Why it confuses app authors | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `Operation` and `EventStream` descriptors | `packages/client/src/index.ts`; `packages/client/README.md` "Define contracts" | `firegrid-client-api.CLIENT_BOUNDARY.1`; `firegrid-client-api.CLIENT_EVENT_STREAM.1` | Keep app-facing | These are the useful contract nouns. The footgun appears when examples immediately drop from descriptors into runtime wiring. | Keep canonical, but pair with one default app graph. |
| `FiregridClientLive({ streamUrl })` | `packages/client/src/service.ts`; `packages/client/README.md` setup examples | `firegrid-client-api.CLIENT_LIVE.1` | Keep app-facing, hide repeated Layer setup | Manual `Layer` provisioning and `streamUrl` threading become the first thing a UI author sees. | Keep as advanced/reuse setup; canonical examples should use a small app-owned client module or query-first helpers. |
| `client.send`, `client.result`, `client.call`, `client.observe` | `packages/client/src/service.ts`; `packages/client/README.md` "Send and observe" | `firegrid-client-api.CLIENT_API.1-.5` | Keep app-facing | `observe` returns operation lifecycle state, not product session timeline/read-model state. Authors can overuse it as a universal query mechanism. | Keep; examples should reserve it for command lifecycle/progress and use live read models for lists/details/timelines. |
| `client.emit`, `client.events` | `packages/client/src/event-streams.ts`; `packages/client/README.md` "EventStream Rows" | `firegrid-client-api.CLIENT_EVENT_STREAM.1-.3` | Keep app-facing for lightweight append/read | The name overlaps with runtime `Firegrid.eventStream`, which is a materializer. The same noun means writer/read stream in client docs and materializer registration in runtime docs. | Keep client API; rename or hide runtime materializer in basic examples. |
| `@firegrid/client/projection-query` `liveQuery` | `packages/client/src/projection-query.ts`; `packages/client/README.md` "Projection Query Foundation" | `firegrid-client-projection-api.CLIENT_PROJECTION_API.1`; `firegrid-projection-query.QUERY_HANDLES.1` | Keep app-facing | This is the right direction, but the spec still emphasizes `snapshot/stream/until/events`, while README now promotes `liveQuery`. Row type registration still requires explicit collection typing and MVP is single-collection. | Make `liveQuery` the canonical read-model path; keep handle APIs advanced. Update specs/docs to agree. |
| `ProjectionQueryHandle.snapshot/stream/observe/until/untilWhere/untilFrom` | `packages/client/src/projection-query.ts`; `packages/client/README.md` advanced examples | `firegrid-projection-query.QUERY_HANDLES.1-.5` | Keep advanced, not default | The handle path restarts the old decision tree: construct handle, choose snapshot vs stream vs until, reason about cursor gaps, then compose waits. | Move behind "advanced projection handles"; canonical examples should start with `liveQuery`. |
| `toProjectionQuery`, `projectionFor`, low-level `observe/until/untilWhere` helpers | `packages/client/src/projection-query.ts`; `packages/client/README.md` advanced API list | `firegrid-client-projection-api.CLIENT_PROJECTION_API.2-.4` | Keep advanced | These are useful escape hatches, but they expose descriptor-to-query translation and wait concepts before the app has a read-model mental model. | Do not use in canonical examples. |
| Browser `@firegrid/substrate/event-plane` reads | `features/firegrid/client-event-plane-registration.feature.yaml`; older LT-02 guidance | `client-event-plane-registration.EVENT_PLANE_DEFINITION.5`; `PROJECTION_API.2` | Replace in app examples with `@firegrid/client/projection-query` | The subpath was an approved boundary before the client facade, but it still asks UI authors to understand EventPlane layers, projections, and authority labels. | Mark as advanced/substrate-facing for browser reads; canonical browser reads should use `@firegrid/client`. |
| `EventPlane.define/layer` | `packages/substrate/src/event-plane/index.ts`; runtime README compose examples | `client-event-plane-registration.EVENT_PLANE_DEFINITION.1-.5` | Keep runtime/substrate-facing | App authors must decide whether a table is an EventPlane projection, an EventStream, or a product store. | Keep for runtime profile authors; hide behind product-owned read-model declarations in basic apps. |
| `PlaneProducer.emit(ChangeEvent)` | `packages/substrate/src/event-plane/producer.ts`; `packages/runtime/README.md` provider examples | `client-event-plane-registration.PRODUCER_API.1-.5` | Move behind runtime/app graph | It forces authors to construct State Protocol change events and think about metadata/idempotency while writing product code. | Keep as substrate/runtime integration primitive; avoid in canonical app examples. |
| `PlaneProjectionQuery` | `packages/substrate/src/event-plane/projection.ts` | `client-event-plane-registration.PROJECTION_API.1-.5` | Keep substrate-internal/advanced | It exposes `evaluate(snapshot)`, authority labels, and projection mechanics. That is not a basic UI query API. | Keep under substrate for implementers; public docs should direct app reads to client `liveQuery`. |
| `RunWait.sleep/for/until/awakeable` | `packages/substrate/src/coordination/run-wait/service.ts`; `packages/substrate/src/index.ts` | `run-wait-primitives.RUN_WAIT_API.1-.5`; `VOCABULARY.2` | Replace default authoring with Effect `Clock`/`Stream`; keep compatibility/advanced | The feature spec currently teaches `RunWait` as app-facing, while the runtime ergonomics SDD says observation waits should be stream composition and time waits should use Effect Clock/Stream/Schedule. | Stop using `RunWait` in canonical basic examples. Move it behind runtime implementations or advanced workflow docs. |
| `RunWait.layer`, `currentWorkContextLayer`, `TriggerMatchers` | `packages/substrate/src/coordination/run-wait/service.ts`; `packages/substrate/src/index.ts`; runtime README compose examples | `firegrid-runtime-process.RUNTIME_COMPOSITION.2` | Move behind runtime | App authors currently assemble wait layers and trigger matchers by hand. That makes basic app setup look like kernel plumbing. | Runtime/application profile should install these. |
| `RunWaitTools` | `packages/substrate/src/coordination/run-wait/tools.ts` | No app-facing ACID found; adjacent to RunWait specs | Keep substrate-internal or adapter-owned | Tool input names such as `sleep`, `wait_for`, `schedule_me`, and `awaitable` look like product/agent vocabulary in Firegrid core. | Remove from canonical Firegrid app docs; consider moving to an adapter package if retained. |
| `Firegrid.handler` | `packages/runtime/src/runtime-api.ts`; `packages/runtime/README.md` operation handler examples | `firegrid-runtime-process.RUNTIME_PACKAGE.1`; `RUNTIME_RUN_API.1` | Keep runtime low-level, not default app construction | Handler bodies become the place where authors discover `RunWait`, producers, terminalization, and dependency layers. | Keep for integration tests and advanced runtimes; add higher-level runtime profile before making it the main app example. |
| `RuntimeContext` / `ctx` style concepts | `packages/runtime/src/runtime-api.ts`; runtime README imports `RuntimeContext` | Runtime ergonomics SDD says default authors should not see `ctx` | Move behind runtime | Context/layer mechanics leak too early into product code. | Keep only for runtime implementers and advanced docs. |
| `Firegrid.subscribers.timer/scheduledWork/projectionMatch` | `packages/runtime/src/runtime-api.ts`; `packages/runtime/README.md` subscriber examples | `firegrid-runtime-process.RUNTIME_COMPOSITION.2` | Move behind runtime | The source comments call these transitional low-level infrastructure, but runtime README makes authors choose subscribers directly. | Do not use in basic docs. Runtime profile should install required subscribers. |
| `Firegrid.composeRuntime` | `packages/runtime/src/composition.ts`; `packages/runtime/README.md` composition example | `firegrid-runtime-process.RUNTIME_COMPOSITION.1-.4` | Keep low-level, hide from basic app path | It requires authors to list handlers, EventPlane layers, subscribers, RunWait layers, trigger matchers, and adapter layers. That is the decision tree in API form. | Keep as the escape hatch; add a product-neutral app/runtime profile for common cases. |
| `Firegrid.eventStream(...)` | `packages/runtime/src/runtime-api.ts`; `packages/runtime/README.md` "EventStream Materializers" | `firegrid-runtime-process.RUNTIME_COMPOSITION.2` indirectly | Replace/rename or hide | The name sounds like an EventStream emitter/reader but registers a runtime materializer. This collides with `client.events` and `client.emit`. | Rename in a future API or remove from canonical examples in favor of explicit materializer wording. |
| `run`, `FiregridRuntimeBoot.attached`, CLI `firegrid` | `packages/runtime/src/run.ts`; `packages/runtime/src/boot.ts`; `packages/runtime/bin/firegrid.ts` | `firegrid-runtime-process.RUNTIME_RUN_API.1-.5`; `RUNTIME_CLI.1-.4` | Keep runtime-facing | The CLI is intentionally attach-only and does not launch Durable Streams. Product apps still need a dev/runtime host story, so authors invent topology files or direct Durable Streams boot code. | Keep attach-only contract; provide a separate app dev profile or product-owned launcher guidance. |
| `@firegrid/substrate` root coordination exports | `packages/substrate/src/index.ts` | Multiple feature specs expose curated primitives | Keep substrate-internal/advanced; narrow examples | Root exports include coordination, claims, completions, current work context, trigger matchers, and projections. Broad export shape invites app imports. | Do not import substrate root from app examples except descriptors. Prefer explicit subpaths for advanced use. |
| `@firegrid/substrate/kernel` public export | `packages/substrate/package.json` | Guardrails forbid kernel/envelope/terminal authority in app code | Delete/deprecate from app-facing docs; keep diagnostic/internal if required | A public package export makes raw kernel authority look sanctioned. | Never use in canonical examples; audit whether it needs to remain public. |
| `@tanstack/db` dependency in substrate | `packages/substrate/package.json`; no current source imports found in this spike | `firegrid-client-projection-api.FRAMEWORK_ADAPTER_DEFERRAL.1` says no TanStack helpers | Keep internal only or remove if unused | The design reference is useful, but a core substrate dependency creates pressure to expose TanStack-shaped concepts or adapters. | Audit dependency; do not expose TanStack in Firegrid core app APIs. |
| `apps/flamecast` topology and direct Durable Streams runtime | `apps/flamecast/src/runtime/main.ts`; `apps/flamecast/src/shared/topology.ts`; removed historical handoff notes | `flamecast-product-contract.RUNTIME_LOWERING.1-.5` says runtime should lower through Firegrid | Delete/quarantine as obsolete example | It writes `public/topology.json`, starts `DurableStreamTestServer`, and creates streams directly. Historical handoff notes explicitly said this is bad code. | Remove or mark obsolete before #114 is reopened. |

## Docs To Remove, Rewrite, Or Mark Obsolete Before Reopening #114

- `docs/patterns/README.md`: absent on `origin/main`. Either restore as a current canonical guide or remove it from dispatch/review references.
- `apps/flamecast/src/runtime/main.ts` and `apps/flamecast/src/shared/topology.ts`: not docs, but they act as executable documentation. Historical handoff notes said this topology/direct Durable Streams path is bad code.
- `docs/replatforming/litmus/LT-02-local-runtime-session-loop.md`: sections that recommend browser `@firegrid/substrate/event-plane` reads and "existing surfaces are enough" need to be updated for the client projection facade and runtime/client boundary.
- `docs/proposals/SDD_FLAMECAST_REPLATFORMING_ON_FIREGRID.md`: already superseded by later handoff guidance; keep historical only, not as current implementation guidance.
- `docs/proposals/SDD_FIREGRID_PROJECTION_QUERY.md`: proposal-era handle-first wording should be marked superseded or updated so `liveQuery` is the primary app-facing read-model concept and handle APIs are advanced.
- Old review/handoff material that mentions Choreography facades should remain historical only. Current source exports `RunWait` and runtime APIs; Choreography should not re-enter canonical examples.

## Documentation Debt Versus API Boundary Debt

Documentation debt:

- Missing `docs/patterns/README.md`.
- Superseded proposals still look authoritative.
- LT-02 guidance trails current client projection-query work.
- Current Flamecast app code is known bad but still discoverable.

API design debt:

- `composeRuntime` and runtime README require manual subscriber/layer selection for basic apps.
- `RunWait` is specified as app-facing, but the newer ergonomics direction wants Effect `Clock` and `Stream` in default authoring.
- `PlaneProducer` and `PlaneProjectionQuery` make app authors handle State Protocol mechanics.
- `Firegrid.eventStream` is a confusing materializer name next to client `emit/events`.
- The substrate root and kernel exports are too tempting for app examples.

The smallest truthful answer is mixed. Better docs can reduce some bad examples, but docs alone cannot remove the need to choose between runtime subscribers, EventPlane producers, RunWait layers, EventStream materializers, projection handles, and client operations. That requires a product-neutral application/runtime profile that owns those choices.

## Top 5 APIs To Remove From Canonical Examples

1. `Firegrid.subscribers.timer/scheduledWork/projectionMatch`
2. `RunWait.layer` and direct `RunWait.sleep/for/until/awakeable` in basic app handlers
3. `PlaneProducer.emit(ChangeEvent)` and State Protocol row construction
4. `Firegrid.eventStream(...)` as the basic EventStream example
5. Browser reads through `@firegrid/substrate/event-plane` or low-level `PlaneProjectionQuery`/`projectionFor`

Also keep `@firegrid/substrate/kernel`, raw Durable Streams APIs, claim/completion/terminal authority, and topology JSON out of app-facing examples.

## Smallest Deletion/Replacement Path

1. Declare `@firegrid/client` descriptors, operations, EventStream rows, and `liveQuery` the canonical app-facing client path.
2. Keep `composeRuntime`, `Firegrid.handler`, subscribers, `RunWait`, `PlaneProducer`, and EventPlane projection APIs as runtime/substrate implementation surfaces until a runtime profile replaces them in examples.
3. Mark proposal-era docs historical where they conflict with the current client projection facade.
4. Remove or quarantine Flamecast topology/direct Durable Streams code before #114 is reopened.
5. Add a product-neutral app/runtime profile later so the default example is "declare graph and run" rather than "assemble layers and subscribers."

## Commands Run

- `git fetch origin`
- `git worktree add -b agent3/api-footgun-inventory /Users/gnijor/gurdasnijor/firegrid/.worktrees/api-footgun-inventory origin/main`
- `git status -sb`
- `sed -n` / `nl -ba` reads of the requested handoff, SDD, package READMEs, package source, and feature specs
- `rg --files docs | rg '^docs/patterns'`
- `rg` searches for `RunWait`, `PlaneProducer`, `EventPlane`, `EventStream`, `composeRuntime`, `Firegrid.eventStream`, `topology`, `Choreography`, and `@tanstack/db`

## Files Changed

- `docs/research/firegrid-api-footgun-inventory.md`
