# Review: Firegrid Foundation Readiness For Fireline / Firepixel

Date: 2026-05-06
Slice: FOUNDATION-READINESS-FIREPIXEL-FIRELINE
Scope: docs/evidence/spec-planning only

## Verdict

Firegrid is foundation-ready for Fireline-shaped systems on `main`.

Firegrid is foundation-ready for Firepixel-shaped systems on `main`. FP1,
FP2B, FP2, FP3, and FP4 now prove the public EventPlane boundary, EventPlane
row wake capability, EventPlane emit-then-wait ordering, app-owned adapter
Scope, and app-owned tool invocation state.

Evidence refresh after FP7 / FL1-FL3 / C2-C4 / LAB0-LAB2: runtime graph
composition now uses the public `Firegrid.composeRuntime(...)` helper across
scenario receiver runtime entrypoints; the public `@firegrid/client` API
boundary, runbook/smoke documentation, and browser/surface hardening have
landed; and the lab client seam now consumes the production client boundary.
Remaining follow-through is coordinator-dispatched product integration work,
not a reopened foundation question.

No additional binding ACIDs are needed in this PR. The existing specs already
cover the current evidence. In particular:

- `durable-agent-runtime-lab.fireline-firepixel-adapter-fit.FIT_REPORT.1`
- `durable-agent-runtime-lab.fireline-firepixel-adapter-fit.FIT_REPORT.2`
- `client-event-plane-registration.EVENT_PLANE_DEFINITION.5`
- `client-event-plane-registration.BOUNDARY.6`
- `client-event-plane-registration.PRODUCER_API.5`
- `client-event-plane-registration.PRODUCER_API.6`
- `client-event-plane-registration.PROJECTION_API.5`
- `client-event-plane-registration.PROJECTION_API.6`
- `client-event-plane-registration.PROJECTION_API.7`
- `client-event-plane-registration.FIREPIXEL_PROFILE.1`
- `client-event-plane-registration.FIREPIXEL_PROFILE.2`
- `client-event-plane-registration.FIREPIXEL_PROFILE.3`
- `client-event-plane-registration.FIREPIXEL_PROFILE.4`
- `client-event-plane-registration.FIREPIXEL_PROFILE.5`
- `firegrid-runtime-process.SCENARIOS.13`
- `firegrid-runtime-process.SCENARIOS.14`
- `firegrid-runtime-process.SCENARIOS.18`
- `firegrid-runtime-process.SCENARIOS.19`
- `firegrid-runtime-process.SCENARIOS.20`
- `firegrid-runtime-process.SCENARIOS.21`
- `firegrid-runtime-process.RUNTIME_RUN_API.11`
- `firegrid-runtime-process.RUNTIME_COMPOSITION.1`
- `firegrid-runtime-process.RUNTIME_COMPOSITION.2`
- `firegrid-runtime-process.RUNTIME_COMPOSITION.5`
- `firegrid-runtime-process.RUNTIME_COMPOSITION.6`
- `firegrid-runtime-process.EFFECT_PLATFORM.6`
- `firegrid-runtime-process.RUNTIME_HOT_PATH.1`
- `firegrid-runtime-process.RUNTIME_HOT_PATH.2`
- `firegrid-runtime-process.RUNTIME_HOT_PATH.3`
- `firegrid-runtime-process.RUNTIME_HOT_PATH.4`
- `run-wait-primitives.RUN_WAIT_API.8`
- `durable-waits-and-scheduling.WAIT_FOR.9`

## Capability Matrix

| Capability | Main status | Evidence on main | Remaining gap |
| --- | --- | --- | --- |
| App-owned operation handlers | Ready | `Firegrid.handler(...)` plus `run({ connection, runtime })` in scenario receivers; runtime API surface in `packages/runtime/src/runtime-api.ts` | None known |
| Runtime composition helper | Ready | `Firegrid.composeRuntime({ subscribers, handlers, provide })` is exported by `@firegrid/runtime`; FL1-FL3 migrated scenario receiver runtime entrypoints to explicit helper lists | None known |
| Scenario runner / manual validation | Ready | Shared registry/scripts in `scenarios/firegrid/src/registry.ts` and `scenarios/firegrid/package.json`; FW0 runner path in `scenarios/firegrid/src/runner.ts` | None known |
| Public client API | Ready | C2 landed `FiregridClient`, `FiregridClientLive`, operation send/call/result/observe, and EventStream APIs under `packages/client/src`; C3 added runbook/smoke documentation; C4 hardened browser-safe surface tests in `packages/client/src/__tests__/client-foundations.test.ts` | None known |
| Lab client seam/readiness | Ready | LAB0/LAB1 landed app-local lab client seam and production API readiness; LAB2 migrated the lab seam through `FiregridClient`; lab UI keeps typed controls separate from raw diagnostics | None known |
| EventPlane public boundary | Ready | `@firegrid/substrate/event-plane` export in `packages/substrate/package.json`; public-surface tests in `packages/substrate/src/__tests__/public-surface.test.ts`; implementation in `packages/substrate/src/event-plane/index.ts` | Naming is still transitional; the repo also has EventStream vocabulary debt, but that is not a readiness blocker |
| EventPlane stateful rows / projections | Ready | Tool invocation plane in `scenarios/firegrid/src/emitters/firepixel-tool-invocation.ts`; Firepixel prompt/permission plane in `scenarios/firegrid/src/emitters/firepixel-prompt-chunk.ts`; receivers read/write through `EventPlane.layer(...)` | None known |
| EventStream descriptor events | Ready | WaitFor and Fireline scenarios use caller-owned `EventStream.define(...)` descriptors in `scenarios/firegrid/src/emitters/wait-for.ts`, `fireline-shaped.ts`, and `fireline-rejection.ts` | None known |
| RunWait durable waits | Ready | `RunWait` public service in `@firegrid/substrate`; Fireline happy/rejection receivers call `RunWait.for(...)`; sleep/scheduled scenarios cover timer/scheduled paths; FP2 proves EventPlane-driven `RunWait.for(..., { resultSchema })` | None known |
| Projection-match subscriber | Ready for completions, EventStream edges, EventPlane edges, and deadlines | `Firegrid.subscribers.projectionMatch({ evaluate })` in `packages/runtime/src/runtime-api.ts`; Fireline scenarios prove EventStream-driven resolution; FP2B added EventPlane row wake support; FP2 consumes it from a Firepixel scenario | None known |
| Ready-work / claims / terminal authority | Ready | Runtime `Firegrid.handler(...)` installs started-run dispatch plus ready-work operator; Fireline rejection maps matched data to a typed failed run in `scenarios/firegrid/src/receivers/fireline-rejection-receiver.ts` | None known |
| Adapter Scope | Ready | FP3 Echo receiver uses a scoped app-owned adapter Layer with acquisition/finalizer in `scenarios/firegrid/src/receivers/echo-receiver.ts` and verifies finalization in `echo-receiver.test.ts` | None known |
| Tool invocation | Ready as app-owned EventPlane state | FP4 request/result rows and self-test in `scenarios/firegrid/src/emitters/firepixel-tool-invocation.ts` and `scenarios/firegrid/src/receivers/firepixel-tool-invocation-receiver.ts` | If tool invocation must suspend through `RunWait.for`, it can follow the FP2 pattern |
| Product vocabulary boundary | Ready | Specs forbid Fireline/Firepixel/tool/prompt/session row families in substrate-native rows; scenarios keep product names in app-owned descriptors/EventPlane rows | Continue rejecting substrate-native product row families |

## Fireline Readiness

Fireline-shaped systems can build on the merged foundation now.

The strongest evidence is the pair of Fireline scenarios:

- Happy path:
  `scenarios/firegrid/src/emitters/fireline-shaped.ts` and
  `scenarios/firegrid/src/receivers/fireline-shaped-receiver.ts`.
- Rejection path:
  `scenarios/firegrid/src/emitters/fireline-rejection.ts` and
  `scenarios/firegrid/src/receivers/fireline-rejection-receiver.ts`.

Those scenarios prove the intended Fireline shape:

1. Fireline owns operation descriptors and EventStream descriptors.
2. The app-owned receiver composes `run({ connection, runtime })`.
3. The runtime explicitly installs `Firegrid.subscribers.projectionMatch(...)`
   through `Firegrid.composeRuntime(...)`.
4. The handler uses `RunWait.for(...)`, imported from the curated
   `@firegrid/substrate` root.
5. The projection-match evaluator reads caller-owned EventStream state.
6. The ready-work operator resumes the same typed handler.
7. Terminal run authorship remains Firegrid/substrate authority.

The rejection scenario is especially important: it shows that app-level
rejection is not a Firegrid-native concept. The projection-match completion
resolves with app-level data, then the handler maps that data to its own typed
operation failure.

This satisfies the Fireline foundation target without adding Fireline packages,
Fireline row families, dynamic graph loading, dev-server launchers, or
`@firegrid/client` imports.

## Firepixel Readiness

Firepixel-shaped systems can build on the merged foundation now.

What is ready on `main`:

- FP1 public EventPlane import:
  `@firegrid/substrate/event-plane`.
- App-owned EventPlane definitions:
  `EventPlane.define({ name, state })`.
- Runtime composition of `EventPlane.layer(...)` with `Firegrid.handler(...)`
  through explicit `Firegrid.composeRuntime(...)` lists.
- App-owned `PlaneProducer.emit(...)` from inside a handler, as shown by FP4.
- App-owned `PlaneProjection` observation, including `Projection.until(...)`,
  as shown by FP4.
- EventPlane row changes wake runtime projection-match evaluation through the
  scoped/coalesced subscriber wake queue, as landed by FP2B.
- Firepixel emit-then-wait ordering is proven by FP2:
  `PlaneProducer.emit(...)` writes prompt and permission rows before
  `RunWait.for(..., { resultSchema })` blocks the run; a later EventPlane
  decision row wakes projection-match evaluation; ready-work resumes the
  handler; inspection sees terminal operation state.
- Scoped app-owned adapter resources through ordinary Effect Layers, as shown
  by FP3.
- Product vocabulary remains app-owned: prompt, permission, tool, provider,
  adapter, ACP/MCP, and sandbox names do not become substrate row families.

No foundation blockers remain for Firepixel-style systems. Future work can
still add product-specific adapters, richer tool transports, provider clients,
and UX flows above Firegrid, but those are higher-layer integrations rather
than missing Firegrid substrate foundation.

## FP1 / FP2B / FP2 / FP3 / FP4 Evidence

### FP1: Public EventPlane Boundary

Evidence:

- `packages/substrate/package.json` exports `./event-plane`.
- `packages/substrate/src/event-plane/index.ts` exposes `EventPlane`,
  `EventPlaneDefinition`, `PlaneProducer`, `PlaneProjection`, and related
  typed errors.
- `packages/substrate/src/__tests__/public-surface.test.ts` asserts
  `EventPlane` is available through the subpath and absent from the curated
  substrate root.

Readiness impact:

- App-owned runtime entrypoints can compose EventPlane services without
  importing `@firegrid/substrate/kernel`.

### FP3: Adapter Scope

Evidence:

- `scenarios/firegrid/src/receivers/echo-receiver.ts` defines
  `EchoAdapterLive` as a scoped app-owned Layer.
- The self-test verifies the adapter finalizer has not run before runtime
  interruption and has run after interruption.

Readiness impact:

- Provider clients, ACP/MCP transports, subprocess supervisors, and sandbox
  handles can be modeled as ordinary app Layers rather than Firegrid-owned
  runtime services.

### FP4: Tool Invocation EventPlane Path

Evidence:

- `scenarios/firegrid/src/emitters/firepixel-tool-invocation.ts` defines
  app-owned request/result EventPlane collections.
- `scenarios/firegrid/src/receivers/firepixel-tool-invocation-receiver.ts`
  emits request rows through `PlaneProducer` and waits for result rows through
  `PlaneProjection.until(...)`.
- The self-test uses a tiny scenario-owned in-process adapter that writes the
  result row through the same EventPlane surface.
- `scenarios/firegrid/src/receivers/firepixel-tool-invocation-receiver.test.ts`
  asserts terminal operation state and zero substrate completions.

Readiness impact:

- Tool invocation can be represented as app-owned EventPlane state without
  making tool names, transports, credentials, ACP/MCP, Claude, or Codex
  substrate concepts.

Boundary note:

- FP4 intentionally does not prove pending `RunWait` resume from EventPlane
  result rows. FP2 now proves the EventPlane-driven durable wait pattern that
  future tool flows can reuse when they need true durable suspension.

### FP2B: EventPlane Wake Capability

Evidence:

- `client-event-plane-registration.PROJECTION_API.7` is present on `main`.
- `firegrid-runtime-process.RUNTIME_HOT_PATH.4` is present on `main`.
- PR `https://github.com/gurdasnijor/firegrid/pull/81` landed as `8ce1c34`.

Readiness impact:

- EventPlane row changes can now wake runtime projection-match evaluators
  through the same scoped/coalesced wake queue used for completion,
  EventStream, and deadline edges.
- This removes the runtime wake blocker that existed when FP4 was reviewed.

### FP2: Firepixel Emit-Then-Wait Scenario

Evidence:

- PR `https://github.com/gurdasnijor/firegrid/pull/76` landed as `24bc51d`.
- `scenarios/firegrid/src/emitters/firepixel-prompt-chunk.ts` defines a
  Firepixel-shaped app-owned EventPlane with prompt chunk, permission request,
  and permission decision collections.
- `scenarios/firegrid/src/receivers/firepixel-prompt-chunk-receiver.ts`
  composes `EventPlane.layer(...)`, `RunWait.layer(...)`,
  `triggerMatchersLayer(...)`, `Firegrid.subscribers.projectionMatch(...)`,
  `Firegrid.handler(...)`, and `run({ connection, runtime })` through
  `Firegrid.composeRuntime(...)`.
- The handler emits prompt chunk and permission request rows through
  `PlaneProducer.emit(...)` before calling
  `RunWait.for(..., { resultSchema })`.
- The self-test appends a permission decision through the same EventPlane
  surface and verifies blocked, resolved, and terminal states through
  inspection.
- `scenarios/firegrid/src/receivers/firepixel-prompt-chunk-receiver.test.ts`
  asserts a single projection-match completion, no remaining ready work, and
  terminal operation output.

Readiness impact:

- Firepixel-style prompt/permission flows now have an end-to-end foundation
  proof over app-owned EventPlane state and Firegrid-owned durable wait,
  ready-work, claim, and terminal authority.

### FP7 / FL1-FL3: Runtime Composition Helper Adoption

Evidence:

- PR `https://github.com/gurdasnijor/firegrid/pull/85` landed
  `Firegrid.composeRuntime(...)`.
- PRs `https://github.com/gurdasnijor/firegrid/pull/87`,
  `https://github.com/gurdasnijor/firegrid/pull/89`, and
  `https://github.com/gurdasnijor/firegrid/pull/92` adopted the helper in
  scenario receiver runtime entrypoints.
- Receiver source under `scenarios/firegrid/src/receivers/*.ts` now shows
  explicit `subscribers`, `handlers`, and `provide` arrays for app-owned
  runtime graphs instead of hand-written `Layer.mergeAll(...).pipe(...)`
  runtime composition.

Readiness impact:

- Fireline and Firepixel examples now demonstrate the public runtime
  composition helper without hiding stock subscribers or provider Layers.
- The helper has not become a graph DSL, product preset, or dev-server
  launcher; it remains ordinary Effect Layer wiring around explicit inputs.

### C2-C4: Public Client API Boundary, Smoke Runbook, And Browser Surface

Evidence:

- PR `https://github.com/gurdasnijor/firegrid/pull/90` landed the public
  client implementation after the C1 SDD.
- `packages/client/src/operations.ts` provides the app-facing
  `FiregridClient` operation API: send, call, result, and observe.
- `packages/client/src/index.ts` exports the public client root surface, and
  `packages/client/src/__tests__/firegrid-operations.test.ts` covers the
  operation path.
- Browser-surface tests keep the browser-safe subpath from exporting the root
  operation client surface where it would pull in inappropriate dependencies.
- PR `https://github.com/gurdasnijor/firegrid/pull/93` landed the client API
  runbook and smoke command documentation.
- PR `https://github.com/gurdasnijor/firegrid/pull/96` landed client browser
  boundary and surface hardening tests in
  `packages/client/src/__tests__/client-foundations.test.ts`.

Readiness impact:

- The client API is no longer only an SDD shape. Applications have a concrete
  production client boundary, documented smoke path, and hardened
  browser-safe surface evidence for app-owned operation and EventStream use.

### LAB0-LAB2: Lab Client Seam And Readiness

Evidence:

- PR `https://github.com/gurdasnijor/firegrid/pull/88` landed the lab
  app-local client seam.
- PR `https://github.com/gurdasnijor/firegrid/pull/91` prepared the lab shell
  for production client API readiness.
- PR `https://github.com/gurdasnijor/firegrid/pull/94` migrated the lab seam
  onto `FiregridClient`.
- `apps/lab/src/lab/LabClient.ts` owns the lab-side client seam.
- `apps/lab/src/lab/lab-events.ts` keeps lab event descriptors app-owned.
- `apps/lab/src/lab/LabEventStreamPanel.tsx` presents typed controls, while
  `apps/lab/src/lab/RawStreamInspector.tsx` remains the raw diagnostic view.

Readiness impact:

- Lab integration is aligned with the client boundary: typed controls can move
  through the app-facing client seam while raw stream inspection remains
  diagnostic.
- LAB2 is now landed evidence for that seam rather than remaining
  follow-through.

## Blocker Assessment

No true blocker was found.

The previous runtime wake gap is closed by FP2B, and FP2 proves that the
landed wake capability composes with `PlaneProducer.emit(...)`,
`RunWait.for(...)`, ready-work resume, and terminal operation state in one
Firepixel-shaped flow.

## Boundary Rules To Preserve

- Fireline/Firepixel concepts remain app-owned descriptor or EventPlane
  vocabulary.
- Substrate-native rows remain generic durable rows such as runs,
  completions, claims, EventStream envelopes, and caller-owned state rows.
- App-facing runtime examples import `RunWait` from `@firegrid/substrate`, not
  `Choreography`, `DurableWaitsLive`, or kernel modules.
- Runtime/scenario receivers do not import `@firegrid/client`.
- Scenario receivers use `Firegrid.composeRuntime(...)` while still listing
  stock subscribers, handlers, `RunWait.layer(...)`, EventPlane layers, trigger
  matchers, and app adapter Layers explicitly.
- Firegrid does not implement ACP, MCP, Claude, Codex, provider, sandbox, or
  tool transport adapters.
- Firegrid does not own Durable Streams dev-server launchers.

## Recommendation

For Fireline: proceed with integration/runbook work on top of the merged
foundation.

For Firepixel: proceed with higher-layer integration work on top of the merged
foundation. Firegrid now has the necessary substrate foundation for
Firepixel-style prompt, permission, tool, provider, and adapter systems without
absorbing product-specific semantics.

For client/lab consumers: proceed with coordinator-dispatched product
integration follow-through on top of the landed C2-C4 and LAB0-LAB2
boundaries. Do not reopen the runtime/substrate foundation for client or lab
consumer work.
