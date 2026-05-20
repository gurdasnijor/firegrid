# Gary Architecture Assessment — Canonical Convergence

Date: 2026-05-20
Assessed main: `7ecaa9102` (`tf-ygz3 Lane D slice 7`, PR #528)
Audience: coordinator handoff / next-wave dispatch

Update mode: this document is now a running architecture-assessment log for
post-wave findings that should be batched to the coordinator for backlog,
priority, and sequencing decisions.

## Current Verdict

Firegrid is now **about 90-93% converged** on the target architecture from
`docs/architecture/host-sdk-runtime-boundary.md`.

That number is materially higher than the earlier `tf-k4uo` assessment because
the load-bearing wave after PR #512 landed the big missing pieces:

- `packages/runtime/src/durable-tools/` was finally deleted in PR #519.
- `ChannelRegistry` was replaced by Effect-native channel Tags plus
  `ChannelInventory` in PR #502.
- Runtime-owned workflow definitions moved under runtime paths across PRs
  #499, #503, and #507.
- `RuntimeAgentToolExecution` is now a real runtime execution seam, not just a
  proposal: PR #504 plus PR #518 moved the first meaningful tool arms.
- Dependency guardrails are hard-error, with explicit debt carveouts now reduced
  to 8 files by PRs #509, #520, #524, #526, and #528.
- Schema projection moved several shared shapes into `@firegrid/protocol`,
  including observations, verified-webhook schemas, projection helpers, and
  operation-entry wrapper cleanup.
- Dark-factory deterministic substrate smokes now prove sleep and waitFor over
  the public-ish path without LLM/provider dependency.

The remaining work is not architectural discovery. It is gap closure around
known seams.

Since the first pass, PR #529 also added the compact `docs/cannon/` source of
truth, refreshed the public README around choreography rather than
orchestration, and aligned the package README surfaces around "protocol schema
catalog -> multiple bindings/projections -> runtime substrate." Treat that as a
documentation/canon clarity improvement, not as a change to the core boundary
verdict below.

## What Still Remains

### P0: Finish The 8-File Host-SDK Substrate Debt

The source of truth is `currentHostSdkSubstrateDebt` in `.dependency-cruiser.cjs`.
As of `7ecaa9102`, the 8 carved-out files are:

- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts`
- `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts`
- `packages/host-sdk/src/host/control-request-reconciler.ts`
- `packages/host-sdk/src/host/internal/runtime-context-helpers.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-core.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts`
- `packages/host-sdk/src/host/runtime-input-deferred.ts`
- `packages/host-sdk/src/host/session-log-channel.ts`

These carveouts are the finish-line scoreboard. Do not reframe the architecture
again until this list is near zero.

Recommended split:

1. **Consumer migration / shim retirement.** Move remaining consumers off
   host-sdk re-export shims such as `runtime-context-workflow-core.ts`.
2. **Execution relocation.** Finish moving agent-tool execution mechanics from
   host-sdk into runtime-owned services.
3. **Runtime shell relocation.** Move engine lifecycle/input-deferred/control
   request mechanics below the binding line, leaving host-sdk as Layer
   composition.
4. **Immediate guardrail ratchet.** After each merge, remove the matching
   carveout and run `pnpm run lint:deps`.

Gaps acceptable for private beta: zero or one well-named compatibility shim with
no runtime behavior. Gaps not acceptable: host-sdk owning live workflow bodies,
durable substrate mechanics, or common operation execution.

### P2: Defer `session_new_all` Unless Evidence Demands It

`docs/research/tf-lwqm-spawn-all-wiring.PROPOSAL.md` correctly identifies that
legacy `spawn_all` returns terminal artifacts, while the §6 factory flow needs
running child session handles.

Updated recommendation: do **not** make this a private-beta blocker. Repeated
`session_new` calls are sufficient unless measured usage proves that a batch
primitive is needed.

If the work is ever taken, introduce **new `session_new_all`** rather than
bending `spawn_all`, for the reasons already documented:

- It matches the existing session-plane vocabulary (`session_new`,
  `session_prompt`, `session_close`).
- It returns running handles, which are semantically distinct from terminal
  spawn results.
- It keeps legacy `spawn_all` behavior available for historical tests or
  non-session execution if needed.

This is now P2 optional ergonomics. Keep it in the backlog as a clean future
projection, but spend near-term capacity on the 8-file carveout reduction,
external trigger path, and projection-surface cleanup.

### P0/P1: Projection Surface Cleanup

The root README and package README refresh established the intended product
framing: client SDK, CLI, MCP/tool surface, and future REST/gRPC/JSON-RPC
surfaces are all projections of protocol-owned contracts over the same runtime
substrate.

Open follow-up already captured: `tf-aago` — "Projection surfaces: client SDK
and CLI presets over protocol launch/channel contracts."

Target shape:

```text
protocol operation / channel schema
  -> client SDK helper
  -> CLI preset or explicit config
  -> MCP/tool binding
  -> future REST/gRPC/JSON-RPC binding
  -> runtime capability
```

Important example: CLI convenience flags such as a future `--agent claude` or
`--agent codex` should lower to explicit protocol launch/runtime config such as
`local.jsonl({ argv, agentProtocol: "stdio-jsonl" })`. They should not become a
separate runtime configuration language.

This is P0 if a private-beta user will start from CLI/client docs. It is P1 if
private beta is driven by operator-owned host composition.

### P0/P1: External Trigger Path

Runtime already owns verified webhook ingestion, and protocol now owns the
stable verified-webhook schema projection. The remaining question is the first
application binding:

```text
real webhook request
  -> runtime verified ingest
  -> durable fact / channel source
  -> host/app channel binding
  -> planner wait_for(channel)
```

Recommendation: Linear first, because it matches the factory-vision narrative.
Route installation belongs in the app or host-sdk integration layer; signature
verification and durable fact writes stay in runtime.

This can be P1 if deterministic §6 smokes remain enough for the immediate
private-beta candidate. It becomes P0 if private beta means "real external event
starts the factory" rather than "operator/test harness starts the factory."

### P1: Real Side-Effect Adapters

The next correctness frontier is not Firegrid substrate correctness; it is
world-facing effects:

- Linear issue/comment/read integration.
- GitHub PR/comment/status integration.
- Slack/human notification integration.

The architectural placement should follow the canonical firewall:

- protocol owns request/response schemas when shared;
- runtime owns execution adapters if they touch providers, credentials,
  retries, or durable side effects;
- host-sdk/app composition installs the live Layers and channel bindings.

Recommended order: GitHub or Linear first, not both. Pick the one that unlocks
the first private-beta story and keep the first adapter intentionally narrow.

### P1: Rebaseline Schema Projection

`tf-krts` was the right inventory, but the wave consumed and obsoleted several
items. Run a new schema-projection inventory against `7ecaa9102` before
dispatching more schema moves.

Private beta can ship with minor protocol projection gaps if the app/agent
surface does not expose them. It should not ship with a shape that client-sdk
and host-sdk both define separately.

### P2: Engine-Native Primitives

`streamWait`, `streamWaitAny`, and related engine primitives still look like
the right long-term substrate. They are not required to complete this private
beta if the current workflow-backed wait path remains correct and performance
is acceptable.

Keep the trigger condition concrete: open this track if measured system latency
approaches a meaningful fraction of LLM/provider network latency, or if another
workflow-body composition leak appears. Until then, do not block private beta on
engine-native primitive work.

## Running Boundary Findings

Use this section as a live log for new architecture findings that are real but
not yet sequenced into implementation beads.

### Finding: `appendRuntimeIngress` Is Control-Plane Authority, Not A Channel

`packages/host-sdk/src/host/commands.ts` still implements
`appendRuntimeIngress` by reading `RuntimeContextRead`, obtaining
`RuntimeControlPlaneTable`, inserting a `RuntimeInputIntent`, and returning a
pending ingress row.

This is direct durable-table authority in `host-sdk`. That is a real boundary
debt, but the target is **not** "turn every control-table write into a
channel." The cleaner distinction is:

- channels are agent/application semantic event capabilities;
- launch/start/prompt/session control are protocol/session operations projected
  through client SDK, CLI, MCP, REST, etc.;
- runtime tables/workflows remain implementation substrate below both surfaces.

Recommended backlog shape: move `appendRuntimeIngress` and related prompt/start
write paths behind a narrow runtime/control-plane capability or session facade.
Do not expose `RuntimeControlPlaneTable` upward, and do not model launch/prompt
as arbitrary agent-visible `send(control.table, ...)` unless there is a
deliberate body-plan faculty for it.

Private-beta impact: acceptable if hidden behind current host/client helpers and
not exposed in end-user docs; not acceptable if new public examples require
callers to import durable tables or construct table rows.

### Finding: `state-changes-channel.ts` Is The Correct CDC-Channel Pattern

`packages/host-sdk/src/host/state-changes-channel.ts` wraps
`DurableTable.rows()` / `ProjectionStream<Row>` behind an opaque ingress
channel. Its test asserts that the agent-visible wait input contains only the
semantic channel name, not the backing table name.

This is a good boundary example:

```text
host/app binding adapter may touch DurableTable.rows()
  -> StateChangesChannel<Row>
  -> agent sees wait_for("state.rows", ...)
```

The adapter can live in `host-sdk` or app integration if it remains a
presentation binding over a narrow runtime/provider tag. If it starts owning
runtime execution, durable write authority, or workflow mechanics, move that
portion below the runtime line.

### Finding: Channels Are Not A Universal Replacement For Control APIs

Channels should hide low-level transports for event/fact observation and
semantic send/call faculties. They should not become a vague replacement for
every runtime control operation.

Recommended rule:

- `wait_for(channel)`, `send(channel)`, `call(channel)` for agent choreography;
- `session.prompt`, `session.start`, `session.close`, launch, and permissions
  response helpers as protocol/session projections;
- implementation may lower both through runtime capabilities, durable streams,
  workflow engine, tables, or future engine-native primitives.

This keeps "channels as nervous system" from turning into "channels as naked
database driver with a prettier name."

### Finding: `control-request-reconciler.ts` Still Has A Real Runtime Purpose

`packages/host-sdk/src/host/layers.ts` still composes
`RuntimeControlRequestReconcilerLive`, `RuntimeControlRequestWorkflowEngineLive`,
and, unless disabled, `RuntimeControlRequestReconcilerDaemonLive` into
`FiregridRuntimeHostLive`.

That file is not dead code. Its current job is the Path C hybrid bridge:

```text
protocol-owned control request rows
  -> host-side daemon observes context/start/lifecycle request rows
  -> runtime control workflows execute/claim the request
  -> completion rows record terminal outcome
```

PRs #499/#503/#507 moved the workflow definitions below the runtime line, but
the dispatcher/daemon shell and direct `RuntimeControlPlaneTable` access still
live in host-sdk. That is why it remains on the 8-file
`currentHostSdkSubstrateDebt` carveout list.

Recommended backlog shape: split this file into:

- host-sdk composition entrypoint / optional daemon toggle;
- runtime-owned control request dispatcher/daemon implementation;
- protocol-owned request/completion row schemas.

Do not delete it as unused. Do not turn it into an agent-facing channel. The
right target is "runtime owns the execution/daemon mechanics; host-sdk composes
the capability."

## Recommended Sequencing To Private Beta

### Phase 1: Close Architectural Invariants

Goal: make the canonical firewall true enough that private beta bugs are product
bugs, not substrate ambiguity.

1. Finish the highest-value `RuntimeAgentToolExecution` arms still in host-sdk.
2. Move/retire the pure re-export shims and ratchet carveouts after each move.
3. Move the control-request runtime shell below the binding line, or explicitly
   document any remaining host-sdk piece as host composition rather than
   substrate.
4. Put `appendRuntimeIngress`/session control writes behind a narrow
   runtime/control-plane capability or session facade when that area is touched.
5. Stop when `.dependency-cruiser.cjs` has either zero carveouts or only named
   compatibility shims with no behavior.

Acceptance:

- `pnpm run verify` green.
- `pnpm run lint:deps` green with no broad carveout growth.
- `rg "@firegrid/host-sdk" packages/runtime/src` stays zero.
- `packages/runtime/src/durable-tools/` stays deleted.
- Dark-factory deterministic smoke covers sleep, waitFor, and delegation.
- End-user docs/examples do not teach durable-table or workflow-engine handles as
  public launch/prompt/channel APIs.

### Phase 2: Private-Beta Functional Loop

Goal: make one credible end-to-end factory loop work without architectural
shortcuts.

1. Choose external trigger source: recommend Linear.
2. Implement verified webhook route + channel binding in app/host integration.
3. Add one real side-effect adapter: recommend GitHub PR/comment or Linear
   comment, depending on the beta story.
4. Extend deterministic smoke before live LLM/provider smoke.
5. Run a bounded live smoke only after deterministic path is green.

Acceptable beta gaps:

- One external integration instead of all planned integrations.
- `session_new_all` entirely deferred; repeated `session_new` is sufficient.
- Protocol projection backlog for surfaces not exposed to beta users.
- Engine-native primitives deferred if performance is comfortably below LLM
  latency budget.
- `appendRuntimeIngress` still implemented in host-sdk internals if hidden behind
  host/client helpers and tracked as boundary debt.

Unacceptable beta gaps:

- Runtime imports host-sdk.
- Client-sdk imports runtime.
- durable-tools resurrection or wait-router compatibility shims.
- Host-sdk common operation execution growing new behavior.
- Agent-facing channels exposing workflow handles, execution ids, stream URLs,
  table names, or engine services.
- Public client/CLI examples requiring durable-table imports, table-row
  constructors, or workflow engine handles.

### Phase 3: Performance And Product Hardening

Goal: convert a correct private-beta loop into a robust beta.

1. Run `pnpm --filter @firegrid/tiny-firegrid simulate:perf` after the loop is
   stable.
2. Compare Firegrid overhead to provider/LLM latency. If internal overhead is
   material, dispatch engine-native `streamWait/streamWaitAny`.
3. Add multi-run flake detection and replay artifacts for beta-critical paths.
4. Expand real adapters only after one adapter has the correct retry,
   credential, and observation model.

## What Coordinator Should Include In Their Handoff

Please fold these points into
`docs/handoffs/COORDINATOR_HANDOFF_canonical_convergence_2026-05-20.md`:

- The current convergence number should be stated as **~90-93%**, not the older
  65% from `tf-k4uo`.
- The **8-file carveout list** is now the most useful objective scoreboard.
  Future coordinators should inspect `.dependency-cruiser.cjs` first.
- PR #519 is the architectural turning point: durable-tools deletion is done.
  Do not let future work reintroduce durable-tools or wait-router compatibility
  surfaces.
- The remaining high-value work is a three-track finish:
  1. carveout ratchet to zero;
  2. external trigger + first real side-effect adapter;
  3. projection-surface cleanup across README/client SDK/CLI/MCP.
- Lane D's no-ratchet finding is healthy, not a failure. It tells us the next
  reductions require consumer migration or real substrate moves, not grep-only
  cleanup.
- Private beta can tolerate narrow integration coverage, deferred
  `session_new_all`, and deferred engine-native primitives. It cannot tolerate
  architectural invariant violations or public docs that teach substrate handles.
- The next coordinator should avoid another broad SDD wave. Dispatch small
  implementation slices tied to specific files, invariants, and acceptance
  greps.

## Coordinator Dispatch Shape

Recommended next dispatches:

1. **Runtime boundary lane:** pick two of the 8 carveout files and move/retire
   them; update `.dependency-cruiser.cjs` in the same PR.
2. **Projection lane:** use `tf-aago` to align CLI/client SDK launch/channel
   helpers with protocol-owned contracts and the README's projection framing.
3. **Integration lane:** draft Linear verified-webhook trigger path and a first
   narrow adapter plan; implement only after route/channel placement is
   confirmed.

Keep one lane free for merge/rebase/guardrail repair. At this point, progress
will be constrained more by merge discipline than by lack of architectural
clarity.
