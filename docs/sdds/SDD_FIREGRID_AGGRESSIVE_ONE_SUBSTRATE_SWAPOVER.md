# SDD: Firegrid Aggressive One-Substrate Swapover

Status: dispatch-ready
Created: 2026-05-20
Owner: Firegrid Runtime / Host SDK / Agent Tools
Primary bead: `tf-auuv`

## Purpose

This SDD turns the one-substrate architecture and the body-plan SDD into a
bounded pre-flight plus two-phase execution plan for tonight. It is not a
research plan. It assumes the existing SDDs and the simulation corpus are
sufficient to attempt the production swapover now, with Phase 0 reserved only
for three final concrete doubts named by review.

The target is deliberately aggressive:

1. Collapse the old `durable-tools/` wait substrate onto the workflow engine.
2. Delete the wait-router / wait-store machinery instead of preserving
   compatibility shims.
3. Build the channel abstraction on top of the simpler workflow-engine
   substrate immediately after the collapse.

## Source Inputs

Authoritative architecture:

- `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md`
- `docs/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md`

Empirical baseline and investigations:

- `docs/research/tf-9ut-workflow-core-paths-empirical-finding.md`
- `docs/research/tf-zuom-inv1-stream-zip-body.FINDING.md`
- PR #458 / `tf-2kel`: INV-2 `WaitForWorkflow` nested workflow validation
- PR #457 / `tf-r5e3`: INV-3 restart-replay for the old wait-router shape
- PR #461 / `tf-r3mo`: INV-4 channel registry surface validation
- PR #460 / `tf-tg8q`: INV-5 multi-context activation gap
- PR #462 / `tf-ui4l`: INV-6 activity-shape comparison

## Synthesis

Firegrid currently has two live durable wait substrates:

1. `DurableStreamsWorkflowEngine`, which already supports workflow execution,
   Activity result records, `DurableClock`, `DurableDeferred`, replay, and
   restart recovery.
2. `packages/runtime/src/durable-tools/`, a second wait substrate containing
   `WaitFor.match`, wait rows, completion rows, and the wait-router fiber.

The old substrate is not merely stale dependency residue. `tf-9ut` proved both
production call sites are live in one simulation:

- runtime-context body: `waitForAgentOutput` over `AgentOutputAfter`
- agent-tool `wait_for`: `tool-use-to-effect.ts` over `CallerFact`

That same fact makes the swapover tractable: one empirical sim can validate both
call-site migrations.

The replacement evidence is already strong enough:

- INV-1 validates the runtime-context replacement body:
  `Stream.zipLatest(inputs, outputs).runForEach(handler)`.
- INV-2 validates the agent-tool replacement:
  `WaitForWorkflow = Activity(Stream.runHead(filtered source))` raced against
  `DurableClock.sleep` with `DurableDeferred.raceAll`.
- INV-4 validates that the agent-facing channel shape can hide `source._tag` and
  `stream` from MCP `tools/list`.
- INV-6 recommends keeping today's `Activity.make + Stream.runHead` shape for
  find-first waits. Do not add alpha/beta/gamma Activity primitives tonight.

Phase 0 refined the runtime-context production body beyond INV-1's raw
`zipLatest` shape. Wave-2A proved permission request/response routing works with
the two existing streams. Wave-2C proved `zipLatest` waits for both sides to
initialize and should not be used as if each emitted pair is semantically
correlated. Therefore Phase 1 Lane 1 should use a merge-shaped event stream with
explicit durable state, not a bare or sentinel-seeded `zipLatest` pair handler.

The only important precision correction is INV-3: it proves restart replay for
the old `WaitFor.match` / wait-router shape, not directly for the new
`WaitForWorkflow` shape. That does not block the swapover. It becomes a final
Phase 1 acceptance test: add a scoped-host-bounce smoke for the exact new
`WaitForWorkflow` shape.

## Non-Goals

- No further open-ended spike or research lanes. Phase 0 below is the only
  pre-flight work: three bounded de-risk checks whose outputs directly select
  the Phase 1 implementation shape.
- No new workflow-engine API.
- No Activity primitive redesign tonight.
- No compatibility shim for `WaitFor.match`.
- No preservation of source-shaped agent inputs after the channel phase.

## Phase 0: Final De-Risk Wave

Goal: remove the three remaining concrete doubts before the production cutover
lanes fan out. This is not a research phase. It is a one-hour maximum,
fully-parallel simulation/source-read wave. Phase 1 starts when the verdicts are
in. A `RED` blocks only the affected Phase 1 lane; it does not cancel the
one-substrate direction.

### Wave-2A: Permission-Stream Consumption

Question:

- Can permission-response intents be consumed as ordinary runtime input stream
  events in the runtime-context stream body, or does the body need a separate
  permission stream?

Work:

- Build a tiny-firegrid runtime-context stream body sim that triggers a
  permission request mid-flight.
- Drive a permission response.
- Prove one of these shapes:
  - `GREEN-zip-2`: widened `runtimeInputStream` carries permission responses.
  - `GREEN-zip-3`: body uses a third permission stream alongside inputs and
    outputs.
  - `RED-needs-redesign`: permission consumption should not be changed in Phase
    1.

Phase 1 effect:

- `GREEN-zip-2`: Lane 1 folds permission responses into the runtime input
  stream.
- `GREEN-zip-3`: Lane 1 implements the three-stream body shape.
- `RED-needs-redesign`: Lane 1 preserves current observable permission behavior
  through the output/event handler and defers approval-channelization to Phase 2
  Lane 5. It must not block the substrate deletion on a permission redesign.

### Wave-2B: Runtime Body Restart-Replay

Question:

- Does the runtime-context stream body continue correctly across a scoped host
  bounce, including replay of previously observed input/output rows?

Work:

- Combine the INV-1 stream-body sim with the INV-3 scoped-bounce pattern.
- Start the runtime-context workflow.
- Push inputs and outputs.
- Bounce the host scope while the body is mid-stream.
- Push additional rows after restart.
- Assert continued handling by the same context workflow.
- If possible, run the converged merge-shaped state-machine variant described
  in Phase 1 Lane 1. If the sim only covers the raw INV-1 `zipLatest` body, its
  verdict must be recorded as `GREEN-substrate-restart-resumes;
  STATE-MACHINE-VARIANT-NEEDS-VALIDATION-IN-LANE-1`.

Verdict:

- `GREEN`: Phase 1 Lane 1 can claim restart-replay coverage.
- `GREEN-substrate-restart-resumes; STATE-MACHINE-VARIANT-NEEDS-VALIDATION-IN-LANE-1`:
  Phase 1 can continue, but Lane 1 must validate the durable state-machine
  variant in its own tests before integration fan-in.
- `IDENTIFIED-DRIVER-PATTERN`: Phase 1 can continue if the remaining issue is
  sim-driver setup rather than substrate semantics; record the driver pattern.
- `RED`: Phase 1 Lane 1 does not fan out until the runtime-body replay shape is
  corrected.

### Wave-2C: `Stream.zipLatest` Empty-Side Semantics

Question:

- What happens when one side of `Stream.zipLatest(inputs, outputs)` has not
  emitted yet?

Work:

- First read the vendored Effect source/tests for `Stream.zipLatest`.
- If the source read is conclusive, record `SOURCE-RESOLVED` with the exact
  semantic statement.
- If ambiguous, run the smallest possible sim: one stream emits one row, the
  other remains empty, then observe whether the combined stream emits.

Phase 1 effect:

- If `zipLatest` requires both sides to emit before the first pair, Lane 1 must
  not use bare `zipLatest` as the production event driver.
- The preferred production shape is `Stream.merge` over side-tagged input and
  output streams, with handler state deciding what each event means.
- If Lane 1 keeps any `zipLatest` variant, it must prove why that variant cannot
  stall on an input-only or output-only first event and cannot treat a pair as a
  semantic correlation.

## Phase 1: Collapse To One Substrate

Goal: production no longer executes or exports `WaitFor.match`, wait-router,
wait-store, or durable-tools. The workflow engine becomes the only durable wait
substrate.

This phase should be dispatched as one coordinated cutover after Phase 0
verdicts land. Lanes 1, 2, 3, and 6 can start concurrently. Lane 4 is a fan-in
lane: it starts after Lanes 1, 2, and 3 are merged into the integration branch.
Lane 5 owns continuous validation, but its final dark-factory smoke runs on the
integration branch after the fan-in. Avoid sequencing this as a cautious
five-PR migration; this is a greenfield PoC and the deletion is the
simplification.

### Lane 1: Runtime-Context Stream Body

Owns:

- `packages/host-sdk/src/host/runtime-context-workflow-core.ts`
- directly adjacent runtime-context workflow tests

Work:

- Port INV-1's one-substrate intent into the production runtime-context workflow
  body, refined by Phase 0's merge/correlation findings.
- Replace `waitForAgentOutput`, `nextAgentOutput`, and the recursive reactive
  output wait loop with a side-tagged merged stream:

```ts
Stream.merge(
  runtimeInputStream.pipe(Stream.map(event => ({ _tag: "Input" as const, event }))),
  runtimeOutputStream.pipe(Stream.map(event => ({ _tag: "Output" as const, event }))),
).pipe(
  Stream.runForEach(event => handleRuntimeContextEvent(event)),
)
```

- Keep the existing behavior handlers where possible:
  `handleRuntimeInput`, `handleAgentOutput`, tool-use activity dispatch, terminal
  exit handling.
- Stop using `WaitFor.match` for `AgentOutputAfter`.
- Stop using per-row output wait deferreds for the runtime-context body's own
  observation waits.
- Treat the merged stream as an "event arrived" signal, not as a semantic pair.
  The handler must correlate permission requests/responses and other paired
  events by stable ids / sequences, not by latest-opposite-side value.
- Store handler state durably. The state must survive replay and host bounce:
  last processed input sequence, last processed output sequence, pending
  permission requests, pending permission responses, and any other in-flight
  correlation state. Do not use an ephemeral `Ref.make(state)` as the authority.
- Preferred durable state shape: one-at-a-time Activity-result fold, where each
  processed event transition writes an Activity result and restart reconstructs
  state by folding those Activity result records. If Lane 1 chooses another
  shape, it must prove equivalent replay behavior in its tests.
- Follow the Wave-2A permission verdict exactly:
  - `GREEN-zip-2`: consume permission responses as ordinary runtime input
    stream events.
  - `GREEN-zip-3`: include a separate permission stream in the body fold.
  - `RED-needs-redesign`: keep approval-channelization out of Phase 1 and
    preserve current observable permission behavior through the output/event
    handler.
- Follow the Wave-2C empty-side verdict exactly. If `zipLatest` requires both
  sides to emit before the first pair, prefer the merged event stream above. Do
  not introduce an input-before-output stall.

Acceptance:

- No production `WaitFor.match` call remains in
  `runtime-context-workflow-core.ts`.
- `workflow-core-paths` no longer emits
  `firegrid.runtime_context.workflow.output.wait`.
- Runtime-context body spans show the merged event driver and durable
  state-transition handling.
- Wave-2B runtime-body restart-replay is `GREEN` or the coordinator explicitly
  accepts either an `IDENTIFIED-DRIVER-PATTERN` bound or the
  `GREEN-substrate-restart-resumes; STATE-MACHINE-VARIANT-NEEDS-VALIDATION-IN-LANE-1`
  bound. In the latter case, Lane 1's own tests must validate the durable
  state-machine variant before integration fan-in.

### Lane 2: Agent-Tool `WaitForWorkflow`

Owns:

- new `WaitForWorkflow` module
- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts`
- minimal adjacent tests

Work:

- Add production `WaitForWorkflow`.
- Use the INV-2 body shape exactly:
  - `Workflow.make`
  - `Activity.make`
  - `Stream.runHead(filteredSource)`
  - `DurableClock.sleep`
  - `DurableDeferred.raceAll`
- Cut `runWaitForTool` from `WaitFor.match(...)` to
  `engine.execute(WaitForWorkflow, ...)`.
- Use deterministic execution identity exactly:
  `wait:${contextId}:${toolUseId}`.
- Preserve current tool result shape.

Acceptance:

- `wait_for` tool calls create workflow execution spans.
- Activity result records are written.
- `DurableDeferred.raceAll` done spans appear.
- `DurableClock.sleep` schedule spans appear.
- No `CallerFact` wait-router completions occur for `wait_for`.

### Lane 3: Type, Env, And Export Cleanup

Owns:

- runtime exports
- host runtime substrate env aliases
- capability/type relocation

Work:

- Move still-needed types out of `packages/runtime/src/durable-tools/`.
- Keep typed observation streams and caller-owned fact stream resolution, but
  place them under a name that does not imply durable-tools ownership.
- Remove durable wait row lookup/upsert requirements from host runtime
  environments once Lane 1 and Lane 2 no longer need them.
- Remove `WaitFor`, `DurableToolsWaitForLive`, `DurableToolsTable`, wait-row,
  completion-row, and wait-router exports from `@firegrid/runtime`.

Acceptance:

- Production env aliases no longer mention durable wait rows.
- Runtime package public exports no longer expose durable-tools.
- Remaining source/stream capability names are substrate-neutral enough for the
  channel registry to consume in Phase 2.

### Lane 4: Delete `durable-tools/`

Owns:

- `packages/runtime/src/durable-tools/`
- `packages/host-sdk/src/host/host-owned-durable-tools.ts`
- docs/tests that directly reference the deleted package

Work:

- Delete `packages/runtime/src/durable-tools/` in full.
- Delete `HostOwnedDurableToolsWaitForLive`.
- Remove wait-router layer composition from host runtime substrate.
- Delete or migrate durable-tools-specific tests.
- Do not leave a compatibility shim.

Acceptance:

```bash
rg "WaitFor\\.match|DurableToolsWaitFor|wait_router|DurableToolsTable|HostOwnedDurableTools" \
  packages/runtime/src packages/host-sdk/src
```

returns no production hits.

### Lane 5: Tests And Sim Acceptance

Owns:

- runtime-context workflow test sync helper
- `workflow-core-paths` sim assertions
- dark-factory / tiny-firegrid smoke wiring

Work:

- Promote `waitUntilWorkflowStarted`.
- Convert hanging runtime-context tests away from `Fiber.join` as a start
  synchronization primitive.
- Update `workflow-core-paths` acceptance from old-span counting to before/after
  substrate proof.
- Run `workflow-core-paths` as the cheap per-PR and integration-branch gate.
- Run dark-factory as a coordinator-triggered smoke on the integration branch,
  not as a required per-lane check, because it needs live ACP/provider setup.

Gate command:

```bash
bash scripts/phase1-workflow-core-paths-gate.sh
```

For an already-captured run:

```bash
bash scripts/phase1-workflow-core-paths-gate.sh <run-id>
```

Acceptance:

Old spans are zero:

- `firegrid.durable_tools.wait_for.match`
- `firegrid.runtime_context.workflow.output.wait`
- `firegrid.durable_tools.wait_router.complete_match`

New spans are present:

- merged runtime body + durable state-transition spans
- workflow execution for `firegrid.agent_tools.wait_for`
- workflow-engine Activity execution
- `DurableDeferred.raceAll`
- `DurableClock.sleep`

### Lane 6: Exact New-Shape Replay Smoke

Owns:

- new tiny-firegrid restart/bounce sim or focused test

Work:

- Add a scoped-host-bounce test for the exact Phase 1 `WaitForWorkflow` shape.
- Start `WaitForWorkflow` while no matching row exists.
- Bounce the scoped host / engine worker while the Activity side is suspended.
- Append the matching row after restart.
- Assert the same workflow execution completes with a match.
- Include a timeout case if cheap.

Acceptance:

- This test proves what INV-3 did not: restart replay for
  `Activity(Stream.runHead) + DurableDeferred.raceAll + DurableClock.sleep`.
- INV-3 remains useful as old-shape evidence but is not cited as direct proof of
  the new-shape replay path.

### Phase 1 Global Acceptance

Phase 1 is complete when:

- Phase 0 verdicts are recorded and their implementation consequences are
  reflected in Lane 1.
- `packages/runtime/src/durable-tools/` is deleted.
- No production code imports or calls `WaitFor.match`.
- The runtime-context body is a merged event stream + durable state-machine
  handler.
- Agent-tool `wait_for` is `engine.execute(WaitForWorkflow, ...)`.
- `workflow-core-paths` completes with old spans at zero and new spans present.
- Dark-factory still reaches its terminal finding path on the integration
  branch.
- The exact new-shape replay smoke passes.
- `pnpm run verify` is green, or any remaining failure is explicitly unrelated
  and accepted by the coordinator for the integration branch. The cutover should
  merge to `main` from that integration branch after this list is satisfied.

## Phase 2: Channel Body Plan On Top

Goal: build the agent-facing channel abstraction directly on the workflow-engine
substrate from Phase 1. The agent sees semantic channels and a small verb set,
not substrate source taxonomy.

This phase should begin immediately after Phase 1 compiles and the sims pass.
Do not reintroduce a dynamic wait-router to implement channels.

### Lane 1: Channel Registry

Owns:

- new `packages/host-sdk/src/host/channel-registry.ts`
- host composition entry points for channel registration

Work:

- Add host-side channel registry.
- Register opaque channel ids with:
  - direction: ingress / egress / call
  - schema metadata
  - substrate binding to typed stream or append target
- First required channel: `factory.events`.

Acceptance:

- Host can register `factory.events` without exposing `CallerFact` or stream
  names to the agent.

### Lane 2: `wait_for(channel)`

Owns:

- `packages/host-sdk/src/agent-tools/bindings/tools.ts`
- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts`
- any protocol schema files for tool input

Work:

- Start after Phase 2 Lane 1 has committed the registry shape. It does not need
  to wait for every host channel registration, but it must share the registry
  contract.
- Change visible `wait_for` input to:

```ts
{
  channel: string
  match?: unknown
  timeoutMs?: number
}
```

- Resolve channel to typed stream + trigger behind the registry.
- Execute `WaitForWorkflow`.
- Make `match` optional.
- Support `timeoutMs: 0` discovery semantics:
  latest-or-none / immediate snapshot, depending on the channel binding.

Acceptance:

- MCP `tools/list` for `wait_for` contains `channel`, optional `match`, and
  optional `timeoutMs`.
- MCP `tools/list` does not contain `source`, `source._tag`, or `stream`.
- Dark-factory can call `wait_for(channel: "factory.events", timeoutMs: 0)` and
  observe the seeded fact.

### Lane 3: Channel Metadata In MCP

Owns:

- runtime-context MCP tool surface
- tools/list metadata helpers

Work:

- Surface registered channel inventory in tool metadata.
- Include enough schema information for the agent to form a valid match without
  guessing substrate row tags.
- Keep metadata compact; this is a body plan, not a database browser.

Acceptance:

- The agent can discover that `factory.events` exists and what shape it carries.
- No substrate storage names are exposed.

### Lane 4: `send(event)`

Owns:

- event channel append path
- `send` tool binding and execution case

Work:

- Implement `send` for writable event channels.
- Back `event(name)` with the same durable stream substrate as Phase 1 uses for
  waits.
- Do not expose `CallerFact`.

Acceptance:

- A toy two-agent sim works:
  one agent sends `event("plan.ready")`, another waits for
  `event("plan.ready")`, no orchestrator.

### Lane 5: `call(approval)`

Owns:

- permission request/response channel adapter
- `call` tool binding and execution case

Work:

- Wrap existing permission request/response flow as a callable channel.
- Agent calls `call(approval(...), request)`.
- Host maps request/response through the current permission substrate.
- Remove dark-factory driver auto-approve glue from the core happy path.

Acceptance:

- Dark-factory progresses through permission using an agent-visible
  `call(approval, ...)` faculty.

### Lane 6: `wait_for_any`

Owns:

- `wait_for_any` tool binding and execution case

Work:

- Accept an array of channel wait descriptors.
- Race N `WaitForWorkflow` executions or equivalent workflow-engine effects.
- Return `{ winnerIndex, channel, result }`.

Acceptance:

- A toy sim waits on two channels and correctly returns the first one to fire.

### Phase 2 Global Acceptance

Phase 2 is complete when:

- MCP tools expose channel-shaped `wait_for`; no source-shaped wait API remains.
- `factory.events` is registered and discoverable.
- Dark-factory can discover the seeded fact with `timeoutMs: 0`.
- Dark-factory no longer needs permission auto-approve driver glue for the core
  path.
- A two-agent `event(name)` choreography sim passes.
- `wait_for_any` works over at least two registered channels.

## Existing Bead Guidance For Coordinator

Use existing beads where they already fit:

- `tf-auuv`: Phase 1 integration / one-substrate collapse.
- `tf-uo2c`: promote `waitUntilWorkflowStarted`; make this a Phase 1 Lane 5
  dependency or fold it into Lane 5 if the PR is not landed.
- `tf-lawq`: Phase 2 Lane 1/2 channel registry + opaque `ChannelTarget`.
- `tf-ma6c`: multi-context concurrent activation. This does not block Phase 1
  or basic Phase 2 channel registry work, but it blocks realistic multi-agent
  `event(name)` choreography. Attach it to Phase 2 Lane 4 if not already fixed.
- `tf-fmwg`: Phase 2 Lane 4 `event(name)`.
- `tf-v8i4`: Phase 2 Lane 5 `approval(handle)`.
- `tf-ynd4`: Phase 2 verb additions; split if needed so `send`, `call`, and
  `wait_for_any` can run in parallel.

Create new beads only where the existing graph lacks a concrete owner:

- Phase 0 Wave-2A: permission-stream consumption sim.
- Phase 0 Wave-2B: runtime body restart-replay sim.
- Phase 0 Wave-2C: `Stream.zipLatest` empty-side source-read / minimal sim.
- Phase 1 Lane 1: production runtime-context merged stream body.
- Phase 1 Lane 2: production `WaitForWorkflow` and `wait_for` cutover.
- Phase 1 Lane 3: type/env/export cleanup.
- Phase 1 Lane 4: delete `durable-tools/`.
- Phase 1 Lane 6: exact new-shape replay smoke.
- Phase 2 Lane 3: channel metadata in MCP.

## Coordinator Dispatch Notes

Dispatch Phase 0 first: Wave-2A, Wave-2B, and Wave-2C run in parallel and return
their verdicts. Then dispatch Phase 1 against those verdicts. Tell lanes
explicitly that Phase 1 is not a spike. Their job is production cutover and
deletion against this SDD.

Phase 1 merge order matters:

1. Lanes 1, 2, 3, and 6 start concurrently.
2. Merge Lanes 1, 2, and 3 into the integration branch.
3. Lane 4 deletes `durable-tools/` on top of that fan-in.
4. Lane 5 validates continuously, with final `workflow-core-paths` and
   dark-factory smoke on the integration branch.

The only merge gate that matters for Phase 1 is the global acceptance list. Do
not gate on preserving old API shape. Do not gate on stale dependencies. Do not
gate on INV-3 wording, except to require the exact new-shape replay smoke.

When Phase 1 compiles and the two sims pass, dispatch Phase 2 without waiting
for a retrospective. Phase 2 is the channel/body-plan surface that the substrate
collapse is meant to unblock.
