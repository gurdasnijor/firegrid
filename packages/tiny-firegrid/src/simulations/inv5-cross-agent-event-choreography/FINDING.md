# FINDING — tf-tg8q: INV-5 cross-agent `event(name)` choreography

Validates body-plan SDD Slice C.2 (`event(name)` peer pheromone, line 283 of
`docs/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md`) and frames the choreography
thesis (SMI-1992) empirically against the current Firegrid substrate.

**TL;DR.** The choreography MECHANISM is sound — one real
claude-agent-acp process called a real `emit_event` MCP tool, the row
landed in a real CallerFact stream, and a host-side observer can read
it. But a SUBSTRATE GAP blocks the multi-agent variant the bead asked
for: `FiregridRuntimeHostLive` does not terminate a runtime-context
workflow when its agent finishes its task, so the control-request
reconciler stays blocked inside `claimAndRunRuntimeContextWorkflow` for
the first context and never activates the engine for the second. The
sim runs end-to-end (`outcome: DriverCompleted`) but only the emitter's
half completes. This gap is the load-bearing INV-5 finding and is a
NAMED substrate prerequisite for the body-plan's `event(name)` Slice
C.2 to ship.

## What the sim does

Folder: `packages/tiny-firegrid/src/simulations/inv5-cross-agent-event-choreography/`

- `host.ts` composes:
  - An app-owned `inv5.events` `DurableTable` bound as the
    `CallerOwnedFactStreams.streamFor("inv5.events")` source — same
    pattern as `dark-factory` and `wait-pre-attach-roundtrip`.
  - The standard `FiregridMcpServerLayer` (runtime-context MCP) for
    `wait_for` / `session_close`.
  - A **sim-local HTTP MCP server** mirroring `FiregridMcpServerLayer`'s
    compose shape, exposing a single `emit_event(name, payload)` Effect
    AI `Tool` whose handler writes one row to the `inv5.events`
    `DurableTable`. The bound URL is late-published via a module-level
    Effect `Deferred` so the driver can wire it into the runtime
    config's `mcpServers` for both sessions.

- `driver.ts` brings up two ACP sessions, both via
  `firegrid.sessions.createOrLoad(...)` with `runtime: local.jsonl({...,
  runtimeContextMcp: { enabled: true }, mcpServers: [{name: "inv5-events",
  server: {type: "url", url: emitBase.url}}]})`. The emitter prompt
  instructs only `emit_event(name='plan.ready', ...)` + (after the
  diagnostic in §"Substrate gap" below was added) `session_close`. The
  waiter prompt instructs only `wait_for(CallerFact stream='inv5.events',
  whereFields={name:'plan.ready'})` + `session_close`. Neither prompt
  names the other agent.

## Acceptance result

Bead acceptance criteria, mapped to the empirical run
(`packages/tiny-firegrid/.simulate/runs/2026-05-20T07-07-29-605Z__inv5-cross-agent-event-choreography/trace.jsonl`):

- **(a) Two distinct claude-agent-acp processes.** *PARTIAL.* The
  emitter's `firegrid.agent_event_pipeline.source.local_process.open_byte_pipe`
  span exists and carries the emitter's `contextId`. The waiter's never
  does — its runtime-context engine is never activated (see §"Substrate
  gap"). Two distinct *sessions* are created (different `externalKey`s,
  different `contextId`s), but only one results in a live ACP
  subprocess.
- **(b) The wait satisfies when the emit lands.** *NOT VALIDATED at the
  agent-tool boundary.* The host-side substrate is sound — the
  `inv5.tool.emit_event` span records `inv5.event.id` and the row is
  durably inserted into the `inv5.events` stream; the
  `CallerOwnedFactStreams.streamFor("inv5.events")` adapter exposes it
  to the wait router. But because the waiter agent never starts, its
  `wait_for` tool call never reaches the router. This is the same
  pre-attach-scan codepath validated by INV-3 (tf-ovrk) for the
  single-agent case; INV-5's incremental ask — observing it across
  two distinct ACP agents — is blocked by §"Substrate gap".
- **(c) trace.jsonl shows event flow emitter→stream→waiter.** *PARTIAL.*
  The emitter→stream half is present: `inv5.tool.emit_event` span
  (`{firegrid.side: "host", inv5.event.name: "plan.ready", inv5.event.id:
  "inv5:plan.ready:..."}`) is reachable from the emitter's MCP request
  span by `inv5.event.id`. The stream→waiter half cannot be produced
  until the substrate gap closes.
- **(d) FINDING demonstrates the choreography thesis empirically.**
  *YES, with the substrate prerequisite named.* See §"What this means
  for SMI-1992 / Slice C.2".

## Substrate gap (the headline finding)

Historical note: `FiregridRuntimeHostLive`'s control-request path processed
`startRequests` via `Effect.forEach(...)` with default concurrency=1 before the
runtime dispatcher moved to
`packages/runtime/src/control-plane/control-request-dispatcher.ts`.
For each start request it calls
`claimAndRunRuntimeContextWorkflow(context, registry, agentToolHost)`,
which BLOCKS until the per-context workflow terminates
(`packages/host-sdk/src/host/commands.ts:83-100`). The workflow only
terminates when the underlying claude-agent-acp session ends — but the
ACP agent stays alive after responding to a prompt; it doesn't
"complete" on its own. Net effect:

```
reconcile_once cycle N
  Effect.forEach(startRequests)             (concurrency=1)
    reconcileStartRequest(emitter)
      startRuntime(emitter)
        claimAndRunRuntimeContextWorkflow(emitter)
          executeRuntimeContextWorkflowForContextId(...)   ← BLOCKS FOREVER
```

The trace confirms this:
- Only **2** `firegrid.host.control_request.reconcile_once` spans in
  the whole 8-minute run (cycle 1 at t=0.977s noop; cycle 2 at t=5.978s
  reconciled the emitter contextRequest in 11ms). Cycle 3+ never
  emitted a span because it is still inside `claimAndRun` for the
  emitter when the run ended.
- The lifecycle reconcile loop (separate fiber, processes cancel/close
  requests, doesn't block on workflow execution) ran 19 times over
  76 seconds, confirming the host fiber is alive — the controlLoop
  alone is stuck.
- `firegrid.host.runtime_context.engine.dispatch_intent` for the waiter
  records `firegrid.runtime_context.engine.active: false`: the waiter
  agent's first prompt arrived at the engine registry, but the registry
  had no entry for the waiter's `contextId` because `claimActive` was
  never called for it (claimActive is called inside `claimAndRun`,
  which is stuck on the emitter).

### Mitigations tried, and why they don't yet close the gap

1. **Sequential driver fan-out.** Wait for `runSession(emitter)` to
   return before starting `runSession(waiter)`. The emitter's runSession
   returns once the agent's text output contains the emitter result
   marker — but the per-context workflow is still active; the
   reconciler is still blocked. The waiter's
   `firegrid.client.session.prompt` then fails with `runtime context
   ... not found` for 60 retries (60 attempts × 1s) and gives up. The
   exception sequence (`AppendError` → `runtime context not found`)
   matches the no-context-row diagnosis: the waiter's contextRequest
   is appended but its `context.reconcile` never runs (cycle 3 stuck
   in claimAndRun for emitter).

2. **Self-close from the agent prompt.** Add a third instruction to the
   emitter prompt to call `session_close(sessionId: <derived from
   externalKey>)` after `emit_event`. The trace shows no
   `session_close` tool span. Reading
   `packages/protocol/src/agent-tools/schema.ts:446-473`,
   `session_close` is *agent-facing* but its semantics are
   "request closure of an existing RuntimeContext-backed session" —
   plausibly aimed at peer/child contexts, not the calling session
   itself. Either the agent declines to call it on its own
   `sessionId`, or the host's `session_close` handler doesn't actually
   terminate the calling workflow. Untangling which is a separate
   diagnostic.

3. **Public client-side termination API.** `FiregridSessionHandle`
   (`packages/client-sdk/src/firegrid.ts:160-174`) exposes
   `prompt / start / snapshot / wait / permissions` — there is no
   `cancel()` or `close()`. The driver has no public surface to end
   a session it created.

### What the gap implies for Slice C.2

The body-plan SDD's `event(name)` peer pheromone (Slice C.2 line 283) is
the choreography thesis's strongest case: an agent expresses intent by
writing to a named event channel; other agents observing the same
channel discover it asynchronously. For this to be more than a
single-agent affordance (which `wait-pre-attach-roundtrip` already
validates: one agent emits, agent restarts later, wait scan finds the
row), the substrate must let **multiple agents coexist within one
host**. Today it doesn't.

Three plausible paths to close it (NOT proposed scope for INV-5; this
finding NAMES them):

- **Multi-context concurrency in the reconciler.** Make
  `reconcileStartRequest`'s `Effect.forEach` concurrency-unbounded (or
  per-context-bounded), and decouple `claimAndRun` from the reconcile
  cycle (fork the workflow execution, return immediately from
  `reconcileStartRequest`). This is the smallest substrate change.
- **Client-side session termination API.** Add
  `FiregridSessionHandle.cancel()` / `.close()` that writes a lifecycle
  request the host honors by terminating the workflow. Allows
  driver-mediated session lifecycle without relying on agent
  self-discipline.
- **Honest agent termination.** A workflow body that completes when the
  agent emits a designated "done" output (e.g. a TextChunk marker or a
  specific tool call), without requiring the ACP process itself to
  exit. Hooks cleanly into the existing reactive-loop runner.

## What this means for SMI-1992 / Slice C.2

The empirical result is **two-part**:

1. **The choreography mechanism is sound.** The combination of
   `CallerOwnedFactStreams` + a typed event row + a wait router that
   pre-attach-scans existing rows IS a working peer-pheromone substrate.
   The emit half ran end-to-end through a real ACP agent calling a real
   MCP tool. The wait half is validated by INV-3 (tf-ovrk) for the
   single-agent restart case and by `wait-pre-attach-roundtrip` for the
   pre-seeded-row case.

2. **The multi-agent variant is gated on a substrate prerequisite —
   concurrent multi-context engine activation in `FiregridRuntimeHostLive`.**
   Slice C.2's `event(name)` cannot be shipped as a peer-pheromone
   primitive (its body-plan claim) until that prerequisite lands. The
   reframe matters: a sim that pre-seeds an event and demonstrates a
   single agent picking it up is sufficient for `event(name)` as
   *callback-shaped restart*; it is NOT sufficient for `event(name)`
   as *concurrent peer pheromone*. The body-plan SDD's "strongest case"
   framing for Slice C.2 commits to the latter.

## Sim-local concessions (not load-bearing for the finding)

- The `emit_event` tool is a sim-local Effect AI `Tool` exposed via a
  separate HTTP MCP server, not the canonical `FiregridAgentToolkit`.
  This is acceptable for INV-5 because the bead asks for an "append-
  fact-shaped tool"; the agent surface is incidental to the
  choreography thesis. Production would expose this through Slice C.2's
  typed channel registry, not as an ad-hoc tool.

- The waiter's `wait_for` uses the substrate-leaky `source: { _tag:
  "CallerFact", stream: "inv5.events" }` shape because Slice A (opaque
  `ChannelTarget`) is upstream of Slice C.2 in the body-plan SDD and is
  validated separately by INV-4 (tf-r3mo). Composing the two — the
  channel registry naming `event('plan.ready')` over the
  `inv5.events` substrate — is a downstream concern.

- A single shared `inv5EventStreamName = "inv5.events"` constant binds
  the emit-tool handler, the `CallerOwnedFactStreams` adapter, and the
  waiter's prompt. The body-plan's typed inventory would replace the
  string with a registered channel handle; the substrate
  (`DurableTable` + `streamFor`) is unchanged.

## How to re-run

```
cd packages/tiny-firegrid
pnpm simulate run inv5-cross-agent-event-choreography
pnpm simulate show
```

Latest trace at `.simulate/latest.json → trace.jsonl`. The
emit→stream half is the most useful signal:

```
grep '"name":"inv5.tool.emit_event"' .simulate/runs/*__inv5-*/trace.jsonl
grep '"firegrid.host.control_request.reconcile_once"' .simulate/runs/*__inv5-*/trace.jsonl
```

A reconcile_once count of `2` (vs. the expected ~`run_seconds/5`) is
the substrate-gap fingerprint.
