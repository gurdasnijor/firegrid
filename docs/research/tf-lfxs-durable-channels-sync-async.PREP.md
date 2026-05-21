# tf-lfxs prep: durable channels sync/async spike

Status: prep-hold. Do not execute until the channel-collapse cascade settles.

Framing read: `/Users/gnijor/gurdasnijor/firegrid/docs/sdds/SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md`.
That SDD was present in the primary checkout during prep but absent from this
worktree's `origin/main` base, so this note records the prep inventory without
copying the SDD.

## SDD Claim Under Test

The SDD claims the existing channel verb set has two durable communication
modes:

- Sync handshake: `call` / `spawn` over request evidence plus durable workflow
  completion/awakeable semantics.
- Async mailbox: `send` plus `wait_for` over DurableTable-backed channel rows.

The spike should decide whether naming this split earns abstraction weight, or
whether it remains docs terminology.

## ACIDs To Reuse

- `firegrid-agent-body-plan.CHANNEL_REGISTRY.4`: Channel Tags bind ingress
  channels to typed streams, egress channels to append targets, and call
  channels to request-response handlers.
- `firegrid-agent-body-plan.WAIT_FOR_CHANNEL.3`: wait_for resolves its channel
  field through the MCP-edge string-to-Tag adapter and only accepts
  ingress-capable channel Tags.
- `firegrid-agent-body-plan.WAIT_FOR_CHANNEL.5`: wait_for returns matched
  channel rows as matched:true event payloads and timeout results as
  matched:false timedOut:true.
- `firegrid-agent-body-plan.SLICE_D_VERBS.2`: The send tool resolves only
  egress-capable channel Tags and appends a payload decoded by the channel
  schema.
- `firegrid-agent-body-plan.SLICE_D_VERBS.3`: The call tool resolves call
  channel Tags and dispatches requests decoded by the request schema, while
  preserving the approval channel fallback.
- `firegrid-agent-body-plan.SLICE_D_VERBS.4`: The wait_for_any tool resolves
  only ingress-capable channel Tags, races the descriptors, and returns the
  first winner index, channel, and result.
- `firegrid-workflow-driven-runtime.PHASE_6_AGENT_TOOLS.10`: wait_for composes
  the durable-tools WaitFor.match surface, mapping EventQuery to a FieldEquals
  trigger over the named source collection, optionally raced against
  DurableClock.sleep for the timeout variant.

## Candidate Bespoke Barriers

### Strong candidate: `createOrLoad` plus `whenReady`

Files:

- `packages/protocol/src/channels/host-sessions-create-or-load.ts`
- `packages/protocol/src/launch/host-session-create-or-load-request.ts`
- `packages/client-sdk/src/firegrid.ts`
- `packages/client-sdk/src/internal/projection-wait.ts`

Current shape:

- `HostSessionsCreateOrLoadChannel` is already a `CallableChannel`.
- `makeHostSessionsCreateOrLoadRequestRowChannel` binds that call to
  `requestHostSessionCreateOrLoad`.
- The binding span explicitly marks
  `firegrid.channel.binding_pattern = request-row-only`.
- The call writes the context request row and returns `{ sessionId, contextId }`
  immediately.
- Client readiness then leaks through `session.whenReady`, which uses
  `projectionWait(control.contexts.rows(), contextId match)`.

Why it matters:

- This is exactly the SDD's "call acks, then bespoke reflection barrier" case.
- A true sync handshake would make `createOrLoad` return only once the context
  row is reflected, eliminating the separate user-visible `whenReady` call for
  the common prompt-after-create path.

Execution caution:

- Do not migrate production behavior during the spike unless the deletion is
  trivial and obviously safe. The first execution should prove the shape in a
  sim-local binding or test adapter, not rewrite the client SDK.

### Medium candidate: `projectionWait` after append

Files:

- `packages/client-sdk/src/internal/projection-wait.ts`
- `packages/client-sdk/src/firegrid.ts`

Current shape:

- `projectionWait` is an ephemeral SDK helper over `Stream.runHead`.
- It is used for `waitUntilContextReady` and for client waits over agent-output
  channel projection rows.

Why it matters:

- `waitUntilContextReady` looks collapsible into the sync handshake.
- Agent-output waits are not necessarily collapsible: they are observational
  waits over the async result stream, which fits the SDD's mailbox/observe-later
  side rather than the call side.

### Async candidate: channel `send` plus `wait_for`

Files:

- `packages/protocol/src/channels/core.ts`
- `packages/protocol/src/agent-tools/schema.ts`
- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts`
- `packages/runtime/src/agent-event-pipeline/tool-execution/runtime-agent-tool-execution.ts`
- `packages/runtime/src/workflow-engine/workflows/wait-for.ts`

Current shape:

- `makeEgressChannel` binds an append target.
- `send` decodes payloads by the channel schema and invokes the egress binding.
- `wait_for` resolves only ingress-capable channel registrations and dispatches
  through `RuntimeAgentToolExecution.waitFor`.
- Runtime wait execution uses `WaitForWorkflow.execute`, which lowers to a
  workflow and `Stream.runHead(filter)` over `RuntimeObservationStreams`.

Why it matters:

- This already looks like the async mailbox mode without a new public API.
- The spike should prove this path in the same trace as the sync handshake, not
  introduce a new mailbox abstraction.

## One-Trace Two-Mode Sim Plan

Proposed simulation id: `durable-channels-sync-async-spike`.

Mode 1: durable handshake / call-style reflection barrier.

- Build a sim-local call channel around the existing
  `HostSessionsCreateOrLoadChannel` contract.
- The naive binding should mirror current behavior: request row is inserted,
  then readiness is observed separately through `whenReady` /
  `projectionWait`.
- The candidate sync-handshake binding should insert the same request row and
  then wait for the reflected context/completion before returning from
  `binding.call`.
- The driver records trace markers for request row insert, context reflection,
  call return, and prompt/start after call return.
- Evidence sought: the candidate binding centralizes the barrier in one place,
  and the driver no longer needs an explicit `session.whenReady`-style step for
  the handshake path.

Mode 2: durable mailbox / send plus wait_for fanout.

- Declare one neutral sim event channel with both ingress and egress bindings
  over a sim-owned DurableTable collection or CallerFact stream.
- Use the existing `send` lowering to append at least two jobs/events.
- Use `wait_for` or `wait_for_any` to observe a matching row later.
- Keep provider/product data out of the channel; use neutral event payloads such
  as `{ kind: "candidate.ready", id, shard }`.
- Evidence sought: sender returns after append, observer later resumes from the
  durable row, and no new public verbs or Effect `Channel`/`Queue` API enters
  Firegrid's public surface.

Both modes should run in one trace so `simulate:show` and `simulate:perf` can
show the two communication modes side by side.

## Verdict Criteria

GREEN:

- The sim centralizes at least one real bespoke barrier, preferably
  `createOrLoad` plus `whenReady`, into a call-style binding or adapter.
- The async mode uses existing `send` plus `wait_for` mechanics without adding
  a new mailbox abstraction.
- No new public verbs are introduced.
- No Effect `Channel`, `Queue`, `Mailbox`, `Stream`, or `Sink` type leaks into
  Firegrid channel contracts.

YELLOW:

- The sim proves the terminology describes existing code, but no real barrier
  becomes simpler or centralizable.
- The finding should recommend keeping the sync/async language as docs-only
  guidance.

RED:

- The spike needs a new layer duplicating Effect `Stream`/`Sink`/`Effect` or
  an in-memory `Queue`/`Mailbox` contract to make the story work.
- The spike wants product-specific channels or new protocol/provider helpers.
- The spike adds public API weight beyond the existing channel directions and
  verb set.

## Execution Checklist After Unblock

1. Rebase onto stable `origin/main` after the channel cascade settles.
2. Add a focused feature spec if the sim introduces new behavior; otherwise
   reference the existing ACIDs above in tests and sim assertions.
3. Implement only the sim-local adapters needed for the two-mode trace.
4. Run the sim and capture:
   - `pnpm --filter @firegrid/tiny-firegrid simulate:run durable-channels-sync-async-spike`
   - `pnpm --filter @firegrid/tiny-firegrid simulate:show <run-id>`
   - `pnpm --filter @firegrid/tiny-firegrid simulate:perf <run-id>`
5. Write `docs/research/tf-lfxs-durable-channels-sync-async.FINDING.md` with
   GREEN/YELLOW/RED verdict and trace evidence.
6. Run `pnpm preflight` before task-exit.
