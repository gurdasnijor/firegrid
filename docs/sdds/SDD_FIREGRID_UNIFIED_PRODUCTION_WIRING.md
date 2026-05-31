# SDD: Unified Production Wiring (Phase 3)

Status: in-progress
Created: 2026-05-31
Owner: Firegrid Runtime
Predecessors:
- `SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION.md` (Phase 1 + 2 — protocol unification + cutover)
- `docs/architecture/2026-05-31-unified-architecture-mental-model.md` (architecture mental model)

## Purpose

Phase 2 collapsed the substrate to three primitives (Workflow + DurableTable + Signal) and deleted ~71k lines of Shape C scaffolding. The simulation validates the substrate end-to-end through a recorder stand-in. **This SDD wires production codecs in at the recorder's slots and ships a composition surface end users can build a host with.**

The substrate is settled. This phase is surface work.

## Architecture decisions (resolved)

These were debated against `2026-05-31-unified-architecture-mental-model.md` §7. All converged cleanly; documented here as decisions, not options.

### A. Adapter Tag — `RuntimeContextSessionAdapter`

Three methods, host-scoped service. Agent processes are long-lived and outlive any single workflow attempt; the adapter owns a host-process-level registry.

```ts
class RuntimeContextSessionAdapter extends Context.Tag(
  "@firegrid/runtime/RuntimeContextSessionAdapter"
)<RuntimeContextSessionAdapter, {
  readonly startOrAttach: (ctx, attempt) => Effect.Effect<void, AdapterError>
  readonly send: (ctx, attempt, evt: AgentInputEvent) => Effect.Effect<void, AdapterError>
  readonly deregister: (ctxId) => Effect.Effect<void, AdapterError>
}>() {}
```

`startOrAttach` is literally "start if not running, attach if running" against the adapter's registry. `deregister` is called as the workflow body's terminal action and is the only mechanism by which the registry shrinks. `AdapterError` is a small tagged union; refine later.

### B. Agent output path — single journal sink

Codec writes **all** agent outputs to `RuntimeOutputTable.events`. The session workflow body **does not** consume outputs. Interactive cases (permission-request, tool-use) are triggered by a small observer Layer that watches the journal and runs sibling workflows.

```
agent stdout → codec → RuntimeOutputTable.events ──┬─► UI / clients
                                                   ├─► observer → PermissionRoundtripWorkflow
                                                   ├─► observer → ToolDispatchWorkflow
                                                   └─► observer → terminal signal relay
```

The codec is a pure I/O adapter. It knows nothing about workflows, signals, or interactive event semantics.

### C. Signal payload typing — stringly storage, typed ends

Signal table stays `{payloadJson: string}` (uniform across all consumers). Channel bindings Schema-encode typed payloads at append; workflow bodies Schema-decode at consume. Both ends typed, middle opaque. Standard pub/sub pattern.

### D. Tool dispatch invocation seam — observer pattern

Same shape as permission roundtrip. Codec writes tool-use event to journal → observer triggers `ToolDispatchWorkflow.execute` → workflow runs the tool → terminal activity sends `tool-result` signal back to session body.

### E. Permission feedback loop — workflow-body-terminal signal

`PermissionRoundtripWorkflow`, after receiving the decision via `awaitSignal`, performs one terminal activity that `sendSignal`s back to the session workflow's execution as a `permission-response` input.

### F. Composition surface — factory with escape hatches

```ts
export const FiregridHost = (options: {
  readonly adapter: Layer.Layer<RuntimeContextSessionAdapter>
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly headers?: DurableTableHeaders
  readonly toolExecutor?: Layer.Layer<ToolExecutor>
  readonly permissionPolicy?: Layer.Layer<PermissionPolicy>
}) => Layer.Layer<FiregridHostServices>
```

Standard Effect override: `FiregridHost({...}).pipe(Layer.provide(MyCustomChannelBindingsLive))`.

## Architectural through-line

Everything-through-the-journal-or-signal. Codec doesn't know workflows; workflows don't know codec; observers triggered by table rows are the only coupling. If this pattern breaks anywhere, that's a red flag worth pausing on.

## Implementation phases

### Phase A — Adapter Tag + workflow body refactor ✅

Foundational. Everything downstream depends on the Tag existing.

- [x] Define `RuntimeContextSessionAdapter` Tag + `AdapterError` in `runtime/src/unified/adapter.ts`
- [x] Refactor `RuntimeContextSessionWorkflow` body to consume the Tag (instead of closure-captured recorder)
- [x] Body decodes `payloadJson` → typed `SessionInputPayload` (Schema decode at consume — implements Q-C contract)
- [x] Body adds terminal `adapter.deregister(ctxId)` activity before returning
- [x] Provide `makeRecorderAdapter` for test/sim use (preserves existing simulation behavior)
- [x] Simulation drivers updated to use Tag pattern; UKV 6/6 + 16/16 green

**Design refinement:** body forwards opaque `SessionInputPayload` (`{kind, payloadJson}`) to adapter — adapter decodes per-kind. Keeps body pure pass-through; adapter (which knows the codec) owns event decode. Typed encode still happens at channel-binding append; typed decode at adapter consume. Both ends typed, body and signal-table middle opaque.

### Phase B — Sibling workflow feedback loops ✅

- [x] Extend `PermissionRoundtripWorkflow` body: after `awaitSignal`, one terminal activity that `sendSignal`s `permission-response` to session execution
- [x] Extend `ToolDispatchWorkflow` body: after tool execution, terminal activity that `sendSignal`s `tool-result` to session execution
- [x] Update sim scenarios to assert these feedback signals land (drove session `inputsConsumed` from 3 → 4 after removing driver-side relay)

**Workflow payload changes:** both `PermissionRoundtripPayload` and `ToolDispatchPayload` now require `attempt: number` (the session attempt number) so the body can compute the session `executionId` via `RuntimeContextSessionWorkflow.executionId({contextId, attempt})` and target the relay precisely.

### Phase C — Output observer Layer ✅

- [x] Build `JournalObserverLive` in `runtime/src/unified/observers.ts`
- [x] Watches `RuntimeAgentOutputEvents` (typed projection of `RuntimeOutputTable.events`) filtered to `PermissionRequest` and `ToolUse` observations
- [x] On PermissionRequest: `PermissionRoundtripWorkflow.execute({contextId, attempt, permissionRequestId, toolUseId})`
- [x] On ToolUse: `ToolDispatchWorkflow.execute({contextId, attempt, toolUseId, toolName, inputJson})`
- [x] Forked as daemon at Layer scope via `Layer.scopedDiscard` + `Effect.forkScoped`; one observer per host
- [x] **Sim coverage: scenario 7 (production-flow) exercises the full loop end-to-end via the fake codec — see Phase D.5 below.**

**Design note:** workflow-level idempotency (`Workflow.idempotencyKey`) deduplicates across observer fires — the observer is allowed to be naïve about "have I seen this before". Same `(contextId, permissionRequestId)` or same `toolUseId` collapses to one execution regardless of how many times the journal stream replays.

**Production wiring discovery:** the observer must capture the full service context (`SignalTable | UnifiedTable | WorkflowEngine`) at Layer-build time via `Effect.context()` and `Effect.provide` it back when forking `workflow.execute()`. The engine resolves the workflow body's R-channel from the calling scope, NOT from the workflow Layer's build context — without re-providing the captured context, the body fails with "Service not found: SignalTable". Found via the production-flow scenario; fix lives in `observers.ts`.

### Phase D — Composition factory ✅

- [x] `FiregridHost(options)` factory in `runtime/src/unified/host.ts`
- [x] Assembles: WorkflowEngine + SignalTable + UnifiedTable + RuntimeControlPlaneTable + RuntimeOutputTable + UnifiedChannelBindingsLive + all six workflow Layers + JournalObserverLive
- [x] User-supplied: `adapter` (required); `toolExecutor` is built inline today (default echo executor) — Phase E may lift it to a Tag for cleaner overrides
- [x] Exports complementary primitive layers (DurableStreamsWorkflowEngine, RuntimeControlPlaneTable, RuntimeOutputTable, SignalTable, UnifiedTable) for users wanting full control
- [x] Documented escape pattern in module header (`.pipe(Layer.provide(MyCustomLive))`)

**Surface:** one function with a small options bag (`{adapter, durableStreamsBaseUrl, namespace, headers?, toolExecutor?}`) returns `Layer.Layer<FiregridHostServices, never, never>`. R-channel is never; composition is self-contained. Users override individual Tags via standard `Layer.provide`.

### Phase D.5 — Production-shape end-to-end simulation scenario ✅

Added per design-partner request: prove the production loop works end-to-end before deferring real-codec work.

- [x] `FakeCodecAdapter` Live in `tiny-firegrid/.../fake-codec.ts` — implements the `RuntimeContextSessionAdapter` Tag with deterministic agent output simulation. `startOrAttach` writes `Ready`; `send(prompt)` writes `ToolUse`; `send(tool-result)` writes `PermissionRequest`; `send(permission-response)` writes `TurnComplete`. All rows go to `RuntimeOutputTable.events`.
- [x] `productionFlowScenario` in `tiny-firegrid/.../production-flow-scenario.ts` — hand-composes the substrate (shares `RuntimeOutputTable` between codec and observer via `Layer.provideMerge` rather than two independent `Layer.provide`s, which would create separate in-memory instances).
- [x] Driver scenario 7 lands in `driver.ts` with assertions on the full loop: session reaches terminal with `inputsConsumed >= 4` (prompt + auto-tool-result + auto-permission-response + terminal), codec saw the relayed tool-result and permission-response inputs, exactly 1 spawn + 1 deregister, exactly 1 tool invocation.

**Acceptance result:** `production flow (e2e) ... session=true inputs=4 codecSends=3 dereg=1 tool=1× auto-relay=true`. The full loop **codec → journal → observer → workflow → relay → session** is now structurally proven and regression-locked.

### Phase E — Production codec adapter Live (deferred from this SDD)

The recorder + fake codec are sufficient to prove the wiring works end-to-end. Wrapping the real `AcpSessionLive` / `StdioJsonlSessionLive` into a `RuntimeContextSessionAdapter` Live with process registry + output-stream-to-journal pump is genuine work (~500 LoC) and will land in a follow-up SDD now that Phase A-D.5 has fully validated the Tag contract, the journal-observer pattern, and the auto-relay feedback loops. The Phase 3 SDD's acceptance gate is structural (the Tag, the factory, the observer pattern, the e2e loop); the codec wrapping is mechanical given those.

## Acceptance criteria

1. ✅ **`unified-kernel-validation` simulation passes 7/7 scenarios + 17/17 invariants** including the production-flow end-to-end scenario that closes the codec → journal → observer → workflow → relay → session loop.
2. ✅ **`pnpm -r exec tsc --noEmit` clean** across the workspace.
3. ✅ **A user can construct a working host with one call**: `FiregridHost({adapter, durableStreamsBaseUrl, namespace})` returns a composable Layer satisfying the runtime substrate + channel + workflow + observer tags.
4. ✅ **`I17 — session workflow body consumes adapter via Context.Tag`** landed in `invariants.ts`; structurally rejects regression to closure-built layer factories.
5. ✅ **No new abstractions beyond what's named here.** No subscriber tier, no composition tier, no codec-aware workflow code introduced. The unified module gained `adapter.ts`, `observers.ts`, and `host.ts` — all explicitly named in the architecture decisions.

## Out of scope (explicitly)

- Production codec adapter Live wrapping `sources/codecs/{acp,stdio-jsonl}` — deferred (Phase E, separate SDD).
- `@firegrid/host-sdk` package fate (currently `export {}`) — independent decision.
- CLI / bin entrypoints — independent decision, follows codec adapter being real.
- Tool executor implementation details — Tag exists; concrete executor Lives are user-supplied or shipped separately.
- Permission policy implementation — Tag exists; concrete policy Lives are user-supplied.

## Progress log

| Date | Phase | Note |
|---|---|---|
| 2026-05-31 | — | SDD created. Architecture decisions A-F locked. |
| 2026-05-31 | A | `RuntimeContextSessionAdapter` Tag landed. Workflow body refactored to consume the Tag; `makeRecorderAdapter` test stand-in lifts to the same Tag contract. Sim 6/6 + 16/16 green. |
| 2026-05-31 | B | `PermissionRoundtripWorkflow` and `ToolDispatchWorkflow` bodies extended to relay results back to session via `sendSignal` as terminal Activity. Payloads gained `attempt: number`. Driver-side relay sends removed; session `inputsConsumed` increased from 3 → 4 (auto-tool-result + auto-permission-response + prompt + terminal). |
| 2026-05-31 | C | `JournalObserverLive` daemon Layer landed in `runtime/src/unified/observers.ts`. Watches `RuntimeAgentOutputEvents` for `PermissionRequest`/`ToolUse` and forks sibling workflows. Workflow idempotencyKey handles dedup across replays. |
| 2026-05-31 | D | `FiregridHost({adapter, durableStreamsBaseUrl, namespace, ...})` factory landed in `runtime/src/unified/host.ts`. Returns `Layer<FiregridHostServices, never, never>`. Override pattern: `.pipe(Layer.provide(MyCustomLive))`. I17 invariant landed enforcing adapter-via-Tag. Acceptance: 6/6 scenarios + 17/17 invariants green. |
| 2026-05-31 | D.5 | Production-flow end-to-end scenario landed: `FakeCodecAdapter` + `productionFlowScenario` close the codec → journal → observer → workflow → relay → session loop with no driver-side relay. Discovered Phase C latent bug: observer must `Effect.context` capture and `Effect.provide` back the workflow body's R-channel (`SignalTable \| UnifiedTable \| WorkflowEngine`) when forking — engine resolves body deps from calling scope, not the workflow Layer's build scope. Fixed in `observers.ts`. Acceptance: **7/7 scenarios + 17/17 invariants green**. |
