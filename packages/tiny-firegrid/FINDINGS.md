# tiny-firegrid Findings

Running tracker for gaps surfaced while making tiny-firegrid configurations
compose against production APIs. These are findings from the model, not issues
the toy package should paper over.

## How To Use This Tracker

Each finding has a stable `TFIND-*` id so sidecar agents can annotate status
without rewriting the document. Use the status line only:

- `status: open`
- `status: in-progress (<branch-or-pr>)`
- `status: blocked (<reason>)`
- `status: resolved (<pr-or-commit>)`
- `status: superseded (<link-or-reason>)`

Keep resolution notes short. If a fix changes the architecture, link the SDD or
PR and leave the original evidence intact.

## Discipline

Tiny-firegrid is useful only when it is isomorphic to production boundaries.
When the toy needs a hand-written type, direct transition function, synthetic
host/client co-location, or lower-level assertion that production users would
not exercise, that is a finding first and a toy implementation detail second.

Configurations should be black-box system shapes. Tests drive those shapes
through public surfaces and assert externally observable behavior. Lower-level
tests that assert private table mechanics or internal transition steps are out
of scope for this package.

## Index

| ID | Status | Area | Finding |
| --- | --- | --- | --- |
| TFIND-001 | in-progress (Codex Agent 1 — SDD-first: independent fix vs fold into deferred client/host transaction) | client-sdk | `Firegrid.launch()` returns a context handle, not a session handle. |
| TFIND-002 | in-progress (#327 — framing signed off, Option B) | client-sdk / host boundary | `sessions.createOrLoad()` still requires host identity. |
| TFIND-003 | in-progress (#327 — framing signed off, Option B) | client-sdk / host boundary | No remote start request surface. |
| TFIND-004 | open | tests / architecture | Tests must not compose client and host in one Effect environment. |
| TFIND-005 | blocked (keystone — leak-stack first, #326 last) | Effect layer typing | Workflow/table layer composition leaks type precision. |
| TFIND-006 | resolved (#325) | tiny host coverage | Durable configuration still models a tiny host capability. |
| TFIND-007 | resolved (#323) | host-sdk | Host SDK lacks a named host surface type. |
| TFIND-008 | open | end-to-end shape | Client and host cannot yet be tested as separate processes end-to-end. |
| TFIND-009 | superseded (false positive — codec is load-bearing) | workflow-engine | Durable workflow codec appears orphaned in the engine closure. |
| TFIND-010 | open | runtime host | RuntimeContext engine registry is load-bearing. |
| TFIND-011 | open | runtime input | Startup reconciliation is not yet modeled against Durable Streams. |
| TFIND-012 | open | durable-tools / wait | Wait-for output surface still needs production-backed modeling. |
| TFIND-013 | open | output journal | Output journal / A4 path remains unmodeled in durable config. |
| TFIND-014 | open | tools | Tool execution and `AgentToolHost` are deferred. |
| TFIND-015 | open | permissions / codecs | Permission flow and codec authority remain unsettled. |
| TFIND-016 | open | workflow activities | Activity boundaries are not yet represented. |
| TFIND-017 | open | toy DurableTable | `rows()` is a live tail; snapshot reads must use `query()`. |
| TFIND-018 | resolved (#317/#320 cleanup) | toy discipline | Hand-maintained contracts are rejected. |
| TFIND-019 | resolved (#317/#320 cleanup) | toy discipline | Internal transition functions are rejected. |
| TFIND-020 | open | toy configuration shape | One configuration file should express one system shape. |
| TFIND-021 | resolved (#317/#320 cleanup) | toy tests | Scenario tests should stay above component internals. |
| TFIND-022 | open | toy package surface | `src/index.ts` should not become an artificial public API. |
| TFIND-023 | resolved (#317/#320 cleanup) | toy layout | Package layout should mirror production package layout. |
| TFIND-024 | open | runtime adapters | Agent adapter path is still under-modeled. |
| TFIND-025 | open | durable-tools | Shape C / wait arbitration remains unmodeled. |
| TFIND-026 | resolved (#321) | durable backend | Durable-streams backend reached Group D. |
| TFIND-027 | accepted | toy readability | Duplicate inline configuration code is acceptable when it documents wiring. |
| TFIND-028 | resolved (#325) | host-sdk / runtime start | `RuntimeStartCapabilityLive` did not capture workflow support services. |
| TFIND-029 | in-progress (`sidecar/runtime-start-deps`) | host-sdk / runtime start | `RuntimeStartCapabilityLive` should enumerate workflow support dependencies. |
| TFIND-030 | in-progress (#329 — @effect/ai dep blessed; CI-green/knip pending) | client-sdk / projections | Snapshot agent output events are typed as records, not protocol unions. |
| TFIND-035 | open (tracked dependent of TFIND-030) | protocol / runtime SSOT | Two divergent agent-output envelope decoders; consolidate to one protocol-owned canonical union. |
| TFIND-031 | in-progress (#331 — Option Y; shared-store gate DISCHARGED, structural proof) | host/toolkit composition | Shared DurableTable tag-family provision missing; masked by TFIND-005 `any`; manifests at 4 prod + 8 test boundaries. |
| TFIND-032 | superseded (folded into TFIND-031) | host-sdk | `agent-tool-host-live.ts` manifestation of TFIND-031. |
| TFIND-033 | superseded (folded into TFIND-031) | host-sdk | `commands.ts` manifestation of TFIND-031. |
| TFIND-034 | superseded (folded into TFIND-031) | host-sdk | `toolkit-layer.ts` manifestation of TFIND-031. |
| TFIND-038 | open (client/host cluster — enriches TFIND-002) | client-sdk / runtime config | Client session creation cannot express arbitrary public runtime intent (argv/env/ACP/MCP). |
| TFIND-039 | open (client/host cluster — = deferred host-reconciler transaction) | client-sdk / host split | Client SDK has no client-visible runtime start trigger. |
| TFIND-040 | open (client-surface family — relates TFIND-008/030) | client-sdk / observations | Client SDK lacks a per-event session observation surface. |
| TFIND-041 | open (architectural — track + probe; relates TFIND-015) | runtime / agent-event contract | `ToolUse` event lifecycle is under-discriminated (execution authority via session-mode, not event). |

## Findings

### TFIND-001: Client launch handle is not a session handle

status: in-progress (Codex Agent 1 — SDD-first scoping)

Sidecar (2026-05-18): dispatched to Codex Coding Agent 1. Shares the
exact root cause as TFIND-002/003 (`launch()` also requires
`CurrentHostSession` via `insertLocalRuntimeContext`); the
`SDD_FIREGRID_CLIENT_HOST_BOUNDARY.md` §3 shape generalizes to it.
Bounded question: is TFIND-001 independently resolvable now via an
additive protocol/client down-payment analogous to #327, or is it purely
a manifestation of the same deferred client/host coordinated transaction
(fold it, as 032/033/034 folded into 031)? SDD-first; framing-gated;
no production code before coordinator review + Gurdas framing signoff.

`Firegrid.launch()` creates a `RuntimeContextHandle` with `contextId` and
`snapshot`, but programmatic prompt/start/wait operations are exposed on
`FiregridSessionHandle` from `sessions.createOrLoad()` / `sessions.attach()`.
For scenarios that need prompt + start + wait, tiny-firegrid must drive the
session facade instead of the lower-level launch handle.

Next action: decide whether launch should stay a context-only primitive, or
whether a launch-created context should have an obvious path to a
session-shaped handle.

### TFIND-002: Critical: session creation still requires host identity

status: in-progress (#327 down-payment merged; end-state gated on deferred host transaction)

Sidecar (2026-05-17): one coupled seam with TFIND-003. SDD
`SDD_FIREGRID_CLIENT_HOST_BOUNDARY.md`. **Option B down-payment MERGED**
as #327 (`f730c68bf`): additive `RuntimeContextRequest` /
`RuntimeStartRequest` schemas + deterministic-id constructors in
`@firegrid/protocol/launch` + 3 contract tests; strictly inert
(createOrLoad/start unchanged). Remaining for full closure: the
client/CLI/factory flip
+ a host-side reconciler are a later single coordinated transaction —
tracked cross-lane dependent (relates TFIND-008/006). insertLocalRuntime-
Context cutover concern resolved (#250 already merged; deprecation
supports this direction). Adjacent: TFIND-001 shares this root cause;
`SDD_FIREGRID_SESSION_FACT_CLIENT_SURFACES.md` needs a spec delta.

`Firegrid.sessions.createOrLoad()` requires `CurrentHostSession` because it
creates a host-bound `RuntimeContext` row through `insertLocalRuntimeContext`.
That makes a remote-client-shaped test impossible through the public session
creation API: the client must be composed with host identity, even though a
production client should not be in the same Effect environment as a host.

This is a high-priority schema projection / client-surface gap. The intended
split is client writes durable, namespace-scoped intents and reads projections;
the host owns host binding and live execution. Today the session creation API
still crosses that boundary.

Next action: sidecar should define the client-visible durable create/load
contract that does not require `CurrentHostSession`, or explicitly mark
session creation as host-mediated and expose the client entrypoint that
requests it.

### TFIND-003: Critical: no remote start request surface

status: in-progress (#327 down-payment merged; end-state gated on deferred host transaction)

Sidecar (2026-05-17): coupled with TFIND-002 — same SDD/PR #327, same
Option B signoff (protocol-only `RuntimeStartRequest`; `start()`
unchanged this PR; client flip + host reconciler deferred to a later
coordinated transaction). See TFIND-002 note for full framing.

`FiregridSessionHandle.start()` requires `RuntimeStartCapability`, which is a
host-process capability. In a real deployment a client should not provide this
capability in-process. There is no public client API that records "start this
session" as a durable control-plane request for a host to claim and execute.

The durable-streams-backed toy can model host execution by calling the host
capability in a separate Effect invocation, but it cannot model a true remote
client requesting start through the same public client surface.

Next action: decide whether start is a host-only operation or a client-written
control intent. Then update client-sdk/protocol accordingly.

### TFIND-004: Critical: tests must not compose client and host in one Effect environment

status: open

The durable-streams-backed test briefly composed `FiregridLive` and the tiny
host layer together to satisfy `CurrentHostSession` and
`RuntimeStartCapability`. That made the test pass, but it modeled a deployment
shape a production user should not use. The real boundary is the durable
substrate: the client writes/reads Durable Streams through client-sdk, while a
host process separately observes/executes through host-sdk.

Tiny-firegrid tests should prefer separate Effect invocations for client and
host sides. If a scenario cannot be expressed that way through public APIs, the
missing surface is the finding.

Next action: after `FiregridHost` lands, keep host and client layers separate
in tests and use only the durable backend as shared state.

### TFIND-005: Workflow layer composition leaks type precision

status: blocked (keystone — leak-stack first, #326 last)

Keystone update (2026-05-17): the fix on PR #326 is **correct** —
`.layer` now returns a precise `Layer<<Table>, …>` (protocol typecheck
clean, all 6 prod classes + 14 test occ migrated). As the SDD predicted,
making `.layer` precise **surfaced 4 genuine pre-existing production
requirement-provision bugs** the `any` was masking (now filed as
TFIND-031..034) plus test fallout. Per discipline these were NOT papered
over. Gurdas decision: **stack** — fix TFIND-031..034 as separate scoped
PRs first (fanned to workers), then #326 rebases green and merges last as
the keystone. TFIND-005 is the keystone that also unblocks TFIND-007
step 2 and TFIND-029. #326 stays draft/red until the stack lands.

Decision (Gurdas, 2026-05-17): approve the full breaking sweep — adopt the
canonical self-referential Tag idiom `class X extends DurableTable(ns,
schemas)<X>() {}` with a `defineDurableTable` signature change, all
production call sites migrated in one transaction. Scope is **6 production
call sites + 14 test occurrences** post-#322.

Framing signed off (Gurdas, 2026-05-17): SDD
`SDD_DURABLE_TABLE_SELF_IDENTITY.md` (PR #326) reviewed and approved; the
**curried `(ns,schemas)<Self>()`** public shape is accepted
(options-object / `.tag<Self>()` rejected). The SDD proved the minimal
fix inert and the naive precise fix type-unsound (cross-table Identifier
unification). Implementation in progress on PR #326; zero runtime/behavior
change; coordinator merges on green under the mechanical-once-framed rule.

Composing `Workflow.toLayer`, `DurableTable.layer`, and
`DurableStreamsWorkflowEngine.layer` can leak `any` through `Layer` pipe
inference even when every consumed service is named explicitly. Earlier durable
configuration iterations had to localize this with annotations.

After #323, `FiregridRuntimeHostLive` has a named public surface but still
infers `Layer<any, DurableTableError, never>`. The durable-streams-backed tiny
configuration consumes the production factory directly and must localize a
single `no-unsafe-return` suppression at that return boundary.

Tiny-firegrid should continue treating broad `as unknown as Effect<...>` casts
on configuration exports as a failed model. A narrow internal annotation is only
acceptable when it identifies the production type boundary that leaked.

Sidecar root-cause trace (2026-05-17): the leak is **not** in
`DurableStreamsWorkflowEngine.layer` (that infers precisely as
`Layer<WorkflowEngineTable | WorkflowEngine, DurableTableError, never>`). It is
in `effect-durable-operators` `DurableTable`: `DurableTableTagClass<Schemas,
Self = any>` (`DurableTable.ts:191`) declares `.layer` as
`Layer.Layer<Self, DurableTableError>`, but `defineDurableTable` returns the
tag class via `as unknown as DurableTableTagClass<Schemas>` (`:1016`),
discarding `Self`, so `Self` defaults to `any`. Every `DurableTable`-derived
`.layer()` (`WorkflowEngineTable`, `RuntimeControlPlaneTable`,
`RuntimeOutputTable`) therefore returns `Layer<any, …>`, which poisons every
host/engine composition that merges a table layer. This is load-bearing: it
gates TFIND-007 step 2 (the host-sdk test suite depends on this `any` `ROut`
to discharge internal requirements).

Sidecar deepened analysis (2026-05-17, surface:155): the minimal fix is
**provably inert and the obvious stronger fix is type-unsound** —
1. A `this`-polymorphic / `Self`-flowing `.layer` typechecks 17/17 green
   but a type-probe shows `WorkflowEngineTable.layer()` ROut is still
   `any`. Green only proves no consumer relied on the `any`; the fix
   changed nothing, because `as unknown as DurableTableTagClass<Schemas>`
   + `Self = any` erases identity at the factory return and an already-
   `any` Tag Identifier cannot be recovered downstream.
2. Returning the precise `typeof DurableTableTag` is **unsound**: Effect
   Tag identity is the `Self` type param, not the runtime key. Every
   table built by `defineDurableTable` shares the same lexical
   `DurableTableTag`, so all such tables would **unify** — one table's
   layer would type-satisfy another table's requirement. Strictly worse
   than the `any` leak.
3. The only sound fix is the canonical Effect self-referential idiom:
   `class WorkflowEngineTable extends DurableTable(ns, schemas)<WorkflowEngineTable>() {}`
   — a `defineDurableTable` signature change plus every `extends
   DurableTable(` call site. This exceeds a zero-API-change down-payment.

status note: blocked pending a framing decision (architectural change vs.
accept as a documented latent finding). If approved, an SDD precedes
implementation. Root cause re-verified directly from source.

### TFIND-006: Runtime start remains a toy host capability

status: resolved (#325)

The durable-streams-backed configuration uses real Durable Streams tables and
the real `DurableStreamsWorkflowEngine`, but the host side is still a tiny
`RuntimeStartCapability` implementation with a tiny in-memory active-engine
registry and a tiny `AgentSessionService`.

It does not compose `FiregridRuntimeHostLive`,
`RuntimeContextEngineRegistryLive`, `RuntimeInputIntentDispatcherLive`,
`RuntimeContextWorkflowSessionLive`, or `RuntimeHostAgentToolHostLive`.

PR #325 replaces the durable-streams-backed toy host with
`FiregridRuntimeHostLive`, which brings the production registry, dispatcher,
runtime workflow session, per-context output writer, tool-host support, and
durable-tools observation substrate into the configuration.

Next action: keep the durable configuration on production host composition;
future gaps should become narrower findings rather than rebuilding a tiny host.

### TFIND-007: Host SDK has layer factories, not a named host surface

status: resolved (#323)

The named-type deliverable landed on `main` (#323): `FiregridHost` is
exported from `@firegrid/host-sdk`; tiny-firegrid can now return
`Layer.Layer<FiregridHost, ...>` instead of a local alias. Step 2
(annotating factory return types) remains deferred and is tracked under
TFIND-005 — see the linked note below.

`packages/host-sdk` exports public layer factories such as
`FiregridRuntimeHostLive` and `FiregridLocalHostLive`, plus capability tags
owned by protocol/runtime, but it does not export a named host surface type
that a caller can compose against directly.

Sidecar resolution (PR #323, `sidecar/host-surface`, SDD
`docs/sdds/SDD_FIREGRID_HOST_SURFACE.md`): exports a `FiregridHost` union
type from `@firegrid/host-sdk` — a `@category models` union following
Effect's own `NodeContext`/`BunContext` precedent, not a `Host` service.
Step 2 (annotating the factory return types `Layer.Layer<FiregridHost,
...>`) is **deferred and blocked on TFIND-005**: the factories currently
infer `Layer<any, …>` (the TFIND-005 leak) and the host-sdk test suite
depends on that `any` to discharge internal requirements; pinning the
return before TFIND-005 turns the suite red.

Tiny-firegrid now consumes the exported type instead of inventing a local
host-layer alias.

Next action: complete factory return type annotation after TFIND-005.

### TFIND-008: Client surface and host surface cannot yet be tested as separate processes end-to-end

status: open

The desired test shape is: client Effect program writes context/input/start
requests through client-sdk; separate host Effect program observes durable
state and executes runtime; client Effect program reads output projections.
The current public APIs do not support that shape cleanly because session
creation and start still require host-side Effect services.

This is the most important value produced by the toy so far: it located the
boundary violation at the public API signatures rather than in lower-level
runtime mechanics.

Next action: unblock TFIND-002, TFIND-003, and TFIND-007, then rewrite the
durable-streams-backed test into separate client and host invocations.

### TFIND-009: Durable workflow codec is orphaned within the workflow-engine closure

status: superseded (false positive — codec is load-bearing)

The coverage analysis found
`packages/runtime/src/workflow-engine/internal/codec.ts` is not imported by
`workflow-engine/` production modules. That is a production cleanup finding,
not a tiny-firegrid coverage gap.

Resolution (sidecar, 2026-05-17): **FALSE POSITIVE — no action.**
`internal/engine-runtime.ts` imports all four codec exports
(`decodeWorkflowResult` / `encodeWorkflowResult` / `reviveEncodedResult` /
`reviveExit`) and uses them at 7 call sites; `makeWorkflowEngine` is
reached via the public `@firegrid/runtime/workflow-engine`
(`DurableStreamsWorkflowEngine`) and exercised by
`DurableStreamsWorkflowEngine.test.ts` + `deferred-done-idempotency.test.ts`.
The codec is connected and load-bearing, not vestigial. The coverage
tool's import graph missed `engine-runtime.ts → codec.ts` (toy-closure
walk). Nothing to delete or reconnect; no PR.

### TFIND-010: RuntimeContext engine registry is load-bearing

status: open

The first dispatcher-backed toy used a closed-over execution id rather than a
registry mapping `contextId` to active engine handles. That proved the single
context happy path, but it could not model the important host behavior:
demuxing intents to active per-context engines, leaving no-engine intents for
startup reconciliation, teardown/deregistration, or multi-context isolation.

Later in-memory configurations added the registry shape, but the
durable-streams-backed configuration still uses a tiny local registry instead
of production `RuntimeContextEngineRegistryLive`.

Next action: model production registry behavior in the host-sdk-backed durable
configuration.

### TFIND-011: Startup reconciliation is not yet modeled against Durable Streams

status: open

The per-context architecture requires a newly started owner engine to read the
namespace intent stream for its context and process unconsumed intents before
tailing new ones. The in-memory model documents this shape, but the
durable-streams-backed configuration does not yet prove reconciliation against
the production Durable Streams backend.

Next action: add a durable replay/reconciliation case after the host type and
registry path are wired through production host-sdk.

### TFIND-012: Wait-for output surface still needs production-backed modeling

status: open

The toy has an in-memory `wait-for-output` configuration, but the
durable-streams-backed configuration exercises client `wait.forAgentOutput`
through the output table only for the modeled text path. It does not yet model
the runtime durable-tools `wait_for` surface or the production wait router.

This matters because the host-vs-context audit found that the non-After
`AgentOutput` wait-router arm reads the host-prefixed runtime output stream,
while post-#315 production writes per-context runtime output streams. The toy
model identifies option (a), making the non-After arm context-aware, as the
architecturally aligned fix.

Next action: add a production-backed wait configuration after host/client
surface cleanup.

### TFIND-013: Output journal / A4 path remains unmodeled in the durable configuration

status: open

The durable-streams-backed configuration writes runtime output through
`RuntimeOutputTable` directly. It does not exercise
`RuntimeAgentOutputAfterEvents` / the per-context output authority path that
surfaced the A4 drift.

Next action: extend the durable configuration or add a sibling configuration
that routes output through the production output authority path.

### TFIND-014: Tool execution and AgentToolHost are intentionally deferred

status: open

The current toy session advertises `tools: false` and uses
`toolUseMode: "observation_only"`. It does not model `RuntimeToolUseExecutor`,
`AgentToolHost`, `toolUseToEffect`, or activity-wrapped tool execution.

Next action: add a tool-execution configuration after the host/client surface
is stable enough to avoid hard-coding another toy-only tool seam.

### TFIND-015: Permission flow and codec authority remain unsettled

status: open

The toy does not yet model permission requests or permission responses. That
leaves open the Cycle 1 question: whether codec layers only translate protocol
events, or whether any codec currently completes workflow deferreds / performs
authority-like work for permission-class events.

Next action: add a permission-flow configuration that makes permission request
output observable through the per-context output channel and routes permission
responses back as client input intents, unless production chooses a different
authority boundary.

### TFIND-016: Activity boundaries are not yet represented

status: open

The toy workflow uses `DurableDeferred.await` and direct Effect composition,
but it does not model `Activity.make` / workflow activity execution. Production
uses activity boundaries to isolate side effects, retries, and replay behavior.

Next action: include an activity boundary in the future tool-execution
configuration.

### TFIND-017: DurableTable rows are live tails in the toy adapter

status: open

The in-memory DurableTable adapter's `rows()` stream was changed from a finite
snapshot to snapshot-plus-live-tail semantics to match subscriber use cases.
That is useful for dispatcher-style configurations, but `Stream.runCollect` on
`rows()` will now hang. Snapshot reads should use `query()`.

Next action: keep this documented near the adapter and use `query()` for
snapshot-only reads.

### TFIND-018: Hand-maintained contracts are rejected

status: resolved (#317/#320 cleanup)

Earlier toy iterations introduced hand-maintained contract/type files such as
`properties/type-contracts.ts` and wait-source types. That violated the core
purpose of the package: drift should appear as type errors against production
exports, not as another maintained mirror.

Rule: import production types when they are public and architecturally
meaningful; if the needed type is not exported, record a finding instead of
recreating it locally.

### TFIND-019: Internal transition functions are rejected

status: resolved (#317/#320 cleanup)

Earlier toy iterations included `simulation/transitions.ts` and direct
transition-style helpers. Those are not aligned with the purpose of
tiny-firegrid. The model should be driven through public Effect, Stream,
DurableTable, Workflow, client-sdk, protocol, runtime, and host-sdk surfaces.

Rule: if a scenario needs a direct transition function to be expressible,
production is hiding an architectural seam.

### TFIND-020: Configuration files should each express one system shape

status: open

The first durable-streams iteration exported separate runnable effects for
end-to-end and replay scenarios. That mixed scenarios into the configuration
and made the file read like test infrastructure rather than a named system
configuration.

Direction: one configuration file = one Firegrid system shape. Tests exercise
multiple properties of that shape.

### TFIND-021: Scenario tests should stay above component internals

status: resolved (#317/#320 cleanup)

Lower-level tests such as DurableTable seam tests were removed or rejected
because tiny-firegrid is not a replacement for unit tests. Its tests should
assert full-system properties of a configuration: intent to output, replay,
multi-context isolation, wait semantics, and future tool/permission flows.

### TFIND-022: `src/index.ts` should not become an artificial public API

status: open

The package is private and exists as executable architecture documentation.
Exports should stay minimal. Adding exports just because code exists makes the
toy look like a reusable library and obscures which files are configurations
versus implementation scaffolding.

Next action: review exports before opening the PR and keep only entries needed
by tests or future configurations.

### TFIND-023: Package layout should mirror production package layout

status: resolved (#317/#320 cleanup)

Folders such as `seams/` were rejected because they introduced toy vocabulary.
The directory structure should mirror current production conventions
(`runtime/agent-event-pipeline`, `runtime/agent-adapters`, `host-sdk/host`,
`effect-durable-operators`, `configurations`) so readers can map toy code back
to production code directly.

### TFIND-024: Agent adapter path is still under-modeled

status: open

The toy currently models an `AgentSessionService` and a tiny sandbox output
stream, but it does not yet show how `packages/runtime/src/agent-adapters` fits
between sandbox/process streams, codecs, workflow session send/receive, and
output persistence.

Next action: add an agent-adapter configuration after host/client process
separation is stable.

### TFIND-025: Durable-tools Shape C / wait arbitration remains unmodeled

status: open

The toy does not model the durable-tools wait router, timeout arbitration, or
future Shape C step 2 (`DurableDeferred.raceAll`-style arbitration). Because
wait behavior crosses workflow, output, and tool surfaces, it should be modeled
as a full configuration rather than a lower-level helper test.

Next action: add a durable-tools configuration after TFIND-012.

### TFIND-026: Durable-streams backend reached Group D

status: resolved (#321)

The durable-streams-backed configuration boots `@durable-streams/server`, uses
production `RuntimeControlPlaneTable`, `RuntimeOutputTable`, and
`DurableStreamsWorkflowEngine`, and asserts replay after engine reconstruction
without duplicate client sends.

### TFIND-027: Duplicate inline configuration code is acceptable

status: accepted

Duplication inside tiny-firegrid configurations is acceptable when it keeps the
architectural wiring visible. The package is documentation plus verification;
factoring every repeated line into helpers can make the system shape harder to
read. Duplication should still not obscure public boundaries or create hidden
toy APIs.

### TFIND-028: RuntimeStartCapabilityLive did not capture workflow support services

status: resolved (#325)

Switching the durable-streams-backed configuration to the production
`FiregridRuntimeHostLive` surfaced that `RuntimeStartCapabilityLive` captured
`RuntimeContextEngineRegistry` and `AgentToolHost`, but not the host-scoped
services needed later by `runtimeContextWorkflowSupportLayer`. Calling
`RuntimeStartCapability.start()` as a public host capability failed at runtime
with a missing `RuntimeOutputTable`.

The fix captures the full host context when constructing the capability and
provides it when running the claimed context workflow. This keeps
client/host-separated tests on the public capability instead of reaching for a
private start path.

The ambient capture does not currently introduce a type/lint leak: focused
host-sdk and tiny-firegrid typecheck plus eslint pass. It is still an indirect
dependency expression; TFIND-029 tracks the clearer explicit-dependency shape.

Next action: keep `FiregridRuntimeHostLive` in tiny-firegrid so future support
layer regressions surface in this configuration.

### TFIND-029: RuntimeStartCapabilityLive should enumerate workflow support dependencies

status: in-progress (`sidecar/runtime-start-deps`)

Sidecar (2026-05-17): assigned as an independent parallel task; verify
what #325 did (ambient capture) then either implement explicit
enumeration (mechanical) or justify ambient via a short SDD (framing-
gated). Draft PR for visibility.

TFIND-028 fixed the runtime bug by capturing the full host context when
constructing `RuntimeStartCapabilityLive` and re-providing it when `start()`
runs. That is behaviorally correct, but it captures every ambient service
rather than naming the services `claimAndRunRuntimeContextWorkflow` needs
through `runtimeContextWorkflowSupportLayer`.

A more explicit production shape would make those requirements visible in the
layer contract instead of relying on ambient context capture. That would make
future support-layer changes fail at composition/type boundaries rather than
at runtime.

Next action: refactor `RuntimeStartCapabilityLive` to enumerate the workflow
support dependencies it must retain, or document why Effect context capture is
the intended host-capability pattern.

### TFIND-030: Snapshot agent output events are typed as records, not protocol unions

status: in-progress (#329 — framing signed off: Q1=C, Q2=strict)

Framing signed off (Gurdas, 2026-05-18): Q1 = **Option C** (smallest
sound down-payment — protocol-owned `AgentOutputEvent` union; switch only
the protocol envelope/observation decode + client-sdk snapshot type;
runtime `events/output.ts` untouched); Q2 = **strict reject**
(non-conforming `event` → decode error/`Option.none()`, an intentional
observable change to `snapshot()`/`wait.*`, documented in #329). Full
SSOT consolidation deliberately deferred → tracked as TFIND-035 (a
tracked dependent, not a bridge). Implementation in progress on #329.

Sidecar (2026-05-18): verified real (not discoverability). The typed
`AgentOutputEventSchema` union is `@firegrid/runtime`-owned; client-sdk
and protocol are runtime-source-free, so exposing it needs a
**protocol-owned union = cross-package schema-ownership change**, and the
protocol decode currently parses `event` only as a `Record` + `_tag`
string (a sound fix changes the protocol DECODE CONTRACT — a behavior
change). Decisive: `SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` already
prescribes `event: AgentOutputEventSchema` — current `Record` is a
divergence from the approved target; plus two divergent envelope decoders
(runtime typed vs protocol Record) = latent SSOT finding. SDD on PR #329;
framing-gated on Q1 (ownership mechanism) + Q2 (decode reject vs
permissive — observable behavior). No code until Gurdas signoff.

The durable-streams-backed test needs a local `textDeltas` projection that
checks `agentOutputs[].event` as `Record<string, unknown>` instead of using the
typed `AgentOutputEvent` union. The runtime output rows are decoded correctly
at runtime, but the client snapshot projection type loses the discriminated
event shape.

This weakens client-side code that wants to branch on `_tag` or inspect event
payloads from `session.snapshot()` without local record checks or casts.

Next action: tighten the client-sdk snapshot/projection type so decoded
`agentOutputs[].event` is exposed as the public `AgentOutputEvent` union.

### TFIND-031: host/toolkit composition omits a shared DurableTable tag-family provision

status: in-progress (#331 — Option Y; shared-store gate DISCHARGED, structural proof)

Shared-store gate DISCHARGED (2026-05-18, structural proof on #331, not
convention): `DurableWaitStoreLive` materializes NO store of its own (all
5 services are pure `Effect.map(DurableToolsTable, …)` adapters);
`DurableToolsWaitForLive` calls `DurableToolsTable.layer()` exactly once
and feeds the same ref to both `WaitRouterLive` (waker) and the recorder
tags over one `durableToolsTableLive` — Effect Layer memoization ⇒
waker+recorder are one materialized store; a divergent store is
structurally impossible at source. Emit-then-wait hazard closed at the
source. Agent 2 proceeding with Y autonomously (gate was the sole
escalation trigger; it passed). Remaining: re-thread support-layer
DurableWait* discharge to the 3 leak seams, deterministic
record→blocked→wake confirmation test, ~42 Cat-A/B/C fallout, verify,
flip #331, rebase #326.

Update (2026-05-18): the contained ambient-tag fixes are done (client-sdk
launch provideService; `HostRuntimeContextExecutionEnv` capture of
RuntimeControlPlaneTable|RuntimeOutputTable|CurrentHostSession|RuntimeHostConfig).
The remaining 3 seams (toolkit-layer:215, agent-tool-host-live:90,
commands:163) leak the 4 `DurableWait*` tags — an architectural fork
(SDD `SDD_TFIND031_DURABLE_WAIT_SUBSTRATE_OWNERSHIP.md`, PR #331). Gurdas
signed off **Option Y** (execution-scoped: merge `DurableWaitStoreLive`
into `runtimeContextWorkflowSupportLayer`; no public host-contract change,
no test ambient edits) with a NON-NEGOTIABLE emit-then-wait correctness
gate: a deterministic blocked-pending test must PROVE
`DurableWaitStoreLive` and `HostOwnedDurableToolsWaitForLive` resolve to
ONE shared materialized store (router wakes on the store waits are
recorded in); divergence → restructure to one store or re-escalate, never
assume. On green, #326 rebases → keystone merge (unblocks
TFIND-007-step2 + TFIND-029).

Surfaced by TFIND-005. Initially filed as 4 separate leaks
(TFIND-031..034); Agent 2's finding-grade diagnosis (2026-05-17) shows
they are **one root cause, not four**: all four production boundaries
plus the test fallout leak the *same tag family* —
`RuntimeControlPlaneTable`, `RuntimeOutputTable`, and the four
`DurableWait*` row tags. The `any` collapsed every consumer's
requirements channel, so a single missing provision site in the
host/toolkit composition manifested at 4 production type-boundaries +
test boundaries. Triaged as ONE root finding with multiple
manifestations — fixed as a single scoped PR, not a 4-PR scatter
(narrower, smaller, correct shape).

Manifestations (folded in): `client-sdk/src/firegrid.ts` (TFIND-032
... see superseded rows), `host-sdk/src/host/agent-tool-host-live.ts`,
`host-sdk/src/host/commands.ts` (CLI inherits),
`host-sdk/src/agent-tools/execution/toolkit-layer.ts`
(HandlersFrom/DurableWaitRowLookup shape).

Test fallout categorized by Agent 2: Cat A — `as Layer<never>` cast
masks (2 files, remove cast); Cat B — genuine requirement surfacing (5
files, fixed by the root provision); Cat C — inference loss (1 file,
`react-types.test.ts`: provider correct, test needs explicit type args).
Protocol src+test fully clean — confirms the TFIND-005 core fix is sound.

Next action: Agent 2 traces the single provision site, lands the root
provision + test-fallout fix as ONE scoped PR (separate from #326); then
#326 rebases green and merges last as the keystone (unblocks
TFIND-007-step2 + TFIND-029).

### TFIND-032: (folded into TFIND-031)

status: superseded (manifestation of TFIND-031 — `agent-tool-host-live.ts`)

Not an independent bug. Same root as TFIND-031 (shared tag-family
provision missing). See TFIND-031.

### TFIND-033: (folded into TFIND-031)

status: superseded (manifestation of TFIND-031 — `commands.ts`)

Not an independent bug. Same root as TFIND-031. CLI inherits this
boundary. See TFIND-031.

### TFIND-034: (folded into TFIND-031)

status: superseded (manifestation of TFIND-031 — `toolkit-layer.ts`)

Not an independent bug. The `HandlersFrom`/`DurableWaitRowLookup` shape
is the same root tag-family provision gap viewed through the toolkit
handler chain. See TFIND-031.

### TFIND-035: Two divergent agent-output envelope decoders (SSOT consolidation)

status: open (tracked dependent of TFIND-030)

Surfaced during TFIND-030. There are two envelope decoders for
agent-output rows: runtime's (`agent-event-pipeline/events/output.ts`,
already parses `event: AgentOutputEventSchema` — typed) and protocol's
(`session-facade/schema.ts` — previously a `Record`; TFIND-030 makes it
parse the new protocol-owned union). TFIND-030 Option C deliberately
leaves the runtime decoder and the runtime-owned `AgentOutputEventSchema`
in place to keep blast radius minimal. This is the deferred SSOT work:
relocate/consolidate to a single protocol-owned canonical union with
runtime re-export, collapsing the two decoders. Deliberate tracked
dependent, NOT a bridge — must be closed, not left as a permanent fork.

Next action: after TFIND-030 lands, scope the canonical relocation
(option A/B of SDD #329) as its own coordinated PR.

### TFIND-038: Client session creation cannot express arbitrary runtime intents

status: open (client/host cluster — enriches TFIND-002)

The Codex ACP tool-call test manually constructs a `RuntimeContext` with
`makeLocalRuntimeContextForHostSession` and writes it through
`RuntimeControlPlaneTable.contexts.upsert(...)`. It does this because the
client session facade cannot currently create/load a session with arbitrary
runtime configuration: binary argv, env bindings, ACP protocol selection, and
MCP server declarations.

That is not just test awkwardness. A real consumer that wants to launch a
specific agent binary with a specific MCP setup has the same gap: the
client-visible session creation surface does not yet express the full public
runtime intent needed for this scenario.

Sidecar triage (2026-05-18, surface:153): part of the client/host boundary
cluster — a sharper manifestation of TFIND-002. The #327
`RuntimeContextRequest` schema is the seam; the likely down-payment is an
additive enrichment of that request to carry full public runtime intent
(argv/envBindings/agentProtocol/MCP), analogous to Option B. Not fanned
out separately — to be folded into the consolidated client/host
transaction (see TFIND-039 / TFIND-001 SDD).

### TFIND-039: Client SDK has no client-visible runtime start trigger

status: open (client/host cluster — = the deferred host-reconciler transaction)

The Codex ACP tool-call test manually extracts `RuntimeStartCapability` from
the host context and calls `start({ contextId })`. That is a host capability,
not a real client operation. The test reaches into it because the client SDK
does not expose a durable start request or any other client-visible way to ask
a host to start a runtime context.

This is the bigger operational split gap: Firegrid can model a client appending
input intent rows and reading projections, but starting the runtime still
requires an in-process host service. Either hosts should auto-start eligible
contexts when they become active, or the client plane needs a durable
start-trigger row that a host-side reconciler observes and claims.

Sidecar triage (2026-05-18, surface:153): this **is** the deferred
host-reconciler transaction already identified as the cross-lane
end-state of TFIND-002/003 (`SDD_FIREGRID_CLIENT_HOST_BOUNDARY.md` §3/§5).
The #327 `RuntimeStartRequest` schema is its client-side half (merged,
inert). NOT a new independent workstream — it is the named form of the
cluster end-state; to be scoped as ONE consolidated client/host
reconciler SDD/transaction after the TFIND-001 investigation lands.

### TFIND-040: Client SDK lacks a per-event session observation surface

status: open (client-surface family — relates TFIND-008/030)

The Codex ACP tool-call test subscribes directly to `RuntimeControlPlaneTable`
and `RuntimeOutputTable` for durable assertions, but still polls
`session.snapshot()` to assemble final text because the client SDK lacks a
session-scoped event stream. Today the choices are either low-level durable
table subscriptions or broad snapshot polling.

This matters for client-shaped tests and real consumers that want to react to
agent output incrementally. A `session.subscribe()` stream or a richer
`session.wait.*` family would let tests and applications observe events without
polling snapshots or manually opening substrate tables.

Sidecar triage (2026-05-18, surface:153): distinct client-surface
ergonomics finding (a `session.subscribe()` / richer `session.wait.*`).
Relates to TFIND-008 (separate-process e2e) and consumes TFIND-030's
typed `AgentOutputEvent` decode. Architectural; track open, scope after
TFIND-030 lands and the client/host transaction shape is settled.

### TFIND-041: ToolUse event lifecycle is under-discriminated

status: open (architectural — track + probe; relates TFIND-015)

`ToolUse` is normalized as a shared `AgentOutputEvent`, but execution
authority is not carried by the event. ACP and stdio-jsonl both emit
`ToolUse`, while the workflow core interprets it by consulting
codec/session mode. Evidence:
`packages/runtime/src/agent-event-pipeline/events/contract.ts` defines
`ToolUse` as a single event shape;
`packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts`
marks emitted tool calls `providerExecuted: false`, session
`toolUseMode: "client_result_roundtrip"`;
`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts` declares
`toolUseMode: "observation_only"` and rejects `ToolResult` input;
`packages/host-sdk/src/host/runtime-context-workflow-core.ts:230`
compensates with codec-aware branching (`if agentProtocol === "acp"
return undefined`) before deciding whether to execute through
`RuntimeToolUseExecutor`.

Load-bearing decision to track: either (A) promote execution authority
to an event-level discriminant (`ToolUseRequest` vs `ToolUseObservation`,
or an explicit provider-executed/requested split), or (B) keep
session-mode as the authority axis and document that workflow
interpretation is codec/session-aware by design. Current production
shape is (B) by default rather than by explicit decision.

Sidecar triage (2026-05-18, surface:153): genuine production
architectural finding; distinct from TFIND-015 (broader codec authority)
and TFIND-014 (toy-scope tool execution). NOT fanned out — track now;
the Codex coordinator probes via the stdio-jsonl config whether one
workflow body can express both lifecycles without codec knowledge. The
A-vs-B decision is a future Gurdas framing call, informed by that probe;
no sidecar code until then.
