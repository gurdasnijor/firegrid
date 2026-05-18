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
| TFIND-001 | open | client-sdk | `Firegrid.launch()` returns a context handle, not a session handle. |
| TFIND-002 | open | client-sdk / host boundary | `sessions.createOrLoad()` still requires host identity. |
| TFIND-003 | open | client-sdk / host boundary | No remote start request surface. |
| TFIND-004 | open | tests / architecture | Tests must not compose client and host in one Effect environment. |
| TFIND-005 | in-progress (`sidecar/workflow-layer-precision`) | Effect layer typing | Workflow/table layer composition leaks type precision. |
| TFIND-006 | open | tiny host coverage | Durable configuration still models a tiny host capability. |
| TFIND-007 | in-progress (#323) | host-sdk | Host SDK lacks a named host surface type. |
| TFIND-008 | open | end-to-end shape | Client and host cannot yet be tested as separate processes end-to-end. |
| TFIND-009 | open | workflow-engine | Durable workflow codec appears orphaned in the engine closure. |
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

## Findings

### TFIND-001: Client launch handle is not a session handle

status: open

`Firegrid.launch()` creates a `RuntimeContextHandle` with `contextId` and
`snapshot`, but programmatic prompt/start/wait operations are exposed on
`FiregridSessionHandle` from `sessions.createOrLoad()` / `sessions.attach()`.
For scenarios that need prompt + start + wait, tiny-firegrid must drive the
session facade instead of the lower-level launch handle.

Next action: decide whether launch should stay a context-only primitive, or
whether a launch-created context should have an obvious path to a
session-shaped handle.

### TFIND-002: Critical: session creation still requires host identity

status: open

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

status: open

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

status: in-progress (`sidecar/workflow-layer-precision`)

Composing `Workflow.toLayer`, `DurableTable.layer`, and
`DurableStreamsWorkflowEngine.layer` can leak `any` through `Layer` pipe
inference even when every consumed service is named explicitly. Earlier durable
configuration iterations had to localize this with annotations.

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

Next action: fix `DurableTable` so `Self` flows into the returned tag-class
type (the tag is its own identifier; the cast just discards it). Then revisit
TFIND-007 step 2 and remove local annotations downstream.

### TFIND-006: Runtime start remains a toy host capability

status: open

The durable-streams-backed configuration uses real Durable Streams tables and
the real `DurableStreamsWorkflowEngine`, but the host side is still a tiny
`RuntimeStartCapability` implementation with a tiny in-memory active-engine
registry and a tiny `AgentSessionService`.

It does not compose `FiregridRuntimeHostLive`,
`RuntimeContextEngineRegistryLive`, `RuntimeInputIntentDispatcherLive`,
`RuntimeContextWorkflowSessionLive`, or `RuntimeHostAgentToolHostLive`.

Next action: once `FiregridHost` lands, add a host-sdk-backed configuration or
replace the tiny host where possible.

### TFIND-007: Host SDK has layer factories, not a named host surface

status: in-progress (#323)

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

Next action: land #323 (named type unblocks the toy now); complete step 2
after TFIND-005.

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

status: open

The coverage analysis found
`packages/runtime/src/workflow-engine/internal/codec.ts` is not imported by
`workflow-engine/` production modules. That is a production cleanup finding,
not a tiny-firegrid coverage gap.

Next action: sidecar should verify whether the file is vestigial post-Shape C
step 1 and delete or reconnect it in a production cleanup PR.

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
