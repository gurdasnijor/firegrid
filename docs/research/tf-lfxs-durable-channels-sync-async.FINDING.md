# tf-lfxs: Durable Channels Sync/Async Spike Finding

Verdict: **GREEN (narrow)**

Run:
`2026-05-21T04-07-32-532Z__durable-channels-sync-async-spike`

Trace:
`packages/firelab/.simulate/runs/2026-05-21T04-07-32-532Z__durable-channels-sync-async-spike/trace.jsonl`

## What Was Tested

`firegrid-durable-channels-sync-async-spike.SYNC_HANDSHAKE.1`
`firegrid-durable-channels-sync-async-spike.SYNC_HANDSHAKE.2`
`firegrid-durable-channels-sync-async-spike.SYNC_HANDSHAKE.3`

The driver invoked a sim-local reflected `HostSessionsCreateOrLoad` callable
binding. The binding still writes the normal control-plane request row through
the existing request-row substrate, then waits for the host-owned runtime
context row to be reflected before the call returns. The driver then attached
to the public session handle and exercised the public prompt/start/wait surface.

`firegrid-durable-channels-sync-async-spike.ASYNC_MAILBOX.1`
`firegrid-durable-channels-sync-async-spike.ASYNC_MAILBOX.2`
`firegrid-durable-channels-sync-async-spike.ASYNC_MAILBOX.3`

The async mode declared one neutral bidirectional channel over a sim-owned
DurableTable. The driver observed a deterministic agent issue two public
`send` tool calls, then a `wait_for` over the same neutral channel. The
`wait_for` matched the second durable row from the existing `WaitForWorkflow`
path.

## Trace Evidence

`simulate:show` reported:

- `spans: 572`
- `traces: 1`
- `errored: 0`
- `sides: host=507 sdk=41 driver=11 subprocess=10 codec=2`

Sync path:

- `firegrid.tf_lfxs.sync_handshake.call` ran on the driver side and wrapped
  `firegrid.channel.host.sessions.create_or_load.call`.
- The underlying channel span retained
  `firegrid.channel.binding_pattern=request-row-only` and
  `firegrid.channel.binding_source=tf-lfxs-sync-handshake-spike`, proving the
  spike used the existing request-row substrate with a binding-layer barrier.
- The call span included the host control-request workflow and the driver-side
  `firegrid.durable_table.rows` / `firegrid.durable_table.get` reflection wait.
- The verdict span recorded
  `firegrid.tf_lfxs.sync.barrier_centralized=true`.

Async path:

- The driver span recorded `firegrid.tf_lfxs.async.channel=tf-lfxs.events`.
- The driver observed `firegrid.tf_lfxs.async.saw_send_calls=2` and
  `firegrid.tf_lfxs.async.saw_wait_for=true`.
- `firegrid.agent_tools.wait_for.execute` ran
  `firegrid.workflow_engine.execution.execute`.
- `firegrid.agent_tools.wait_for.workflow.match_activity` observed
  `firegrid.wait.source=CallerFact`.
- The driver-side verdict span recorded
  `firegrid.tf_lfxs.async.sent_count=2`,
  `firegrid.tf_lfxs.async.matched_id=mailbox-2`,
  `firegrid.tf_lfxs.async.matched_kind=candidate.ready`, and
  `firegrid.tf_lfxs.async.matched_shard=beta`.

`simulate:perf` reported:

- `window: 2026-05-21T04:07:32.536Z -> 2026-05-21T04:07:32.957Z (420.3ms)`
- `idle gaps: (none above threshold)`
- HTTP rolls included the control stream, runtime workflow streams, durable
  tools stream, and the sim mailbox stream.

## Driver Shape

The proof orchestration now lives in `driver.ts`:

- SYNC: driver calls the reflected callable binding and records the returned
  session/context evidence.
- ASYNC: driver uses `session.prompt`, `session.start`, and
  `session.wait.forAgentOutput` to observe the agent's `send` and `wait_for`
  tool calls and final marker.
- Host code composes the host/runtime/channel layers and the sim-owned
  DurableTable binding.

One host-private detail remains intentionally private: the reflected
`createOrLoad` binding is built in `host.ts` because it composes the
control-plane DurableTable and the sim-specific reflection wait. The driver
imports that sim-local Layer only to make the callable Tag available. After the
reflected call returns, the driver attaches through the public session handle;
the `session.whenReady` call only warms the runner's separately materialized
client read model before prompt/start/wait, and is not the sync barrier under
test. The production follow-up is to move that reflection semantics into the
real `createOrLoad` callable binding so callers do not need the extra readiness
step.

## Verdict Rationale

GREEN criteria were met.

The sync mode centralized a real bespoke barrier: the existing
`createOrLoad` request-row call currently acks the request before reflection,
which is why callers historically needed separate readiness checks. The spike
showed that the same callable channel contract can absorb the reflection wait
in the binding layer, with no new public verb.

The async mode needed no new mailbox abstraction. The existing channel
direction model was enough: a bidirectional channel supplied an append target
and an observation stream; the existing `send` lowering appended durable rows;
the existing `wait_for` lowering resumed through the workflow-backed wait path.

The spike did not introduce provider-specific channels and did not expose
Effect `Channel`, `Queue`, `Mailbox`, `Stream`, or `Sink` as Firegrid channel
API.

## Boundary

This PR does not migrate production `createOrLoad` semantics or delete
`whenReady`. It proves that the sync/async durable-channel framing has
implementation weight and identifies the likely production follow-up:
move the request-reflection barrier into callable bindings for operations
where the result gates the next client action.

`firegrid-durable-channels-sync-async-spike.VERDICT.1`
`firegrid-durable-channels-sync-async-spike.VERDICT.2`
`firegrid-durable-channels-sync-async-spike.VERDICT.3`
`firegrid-durable-channels-sync-async-spike.API_WEIGHT.1`
`firegrid-durable-channels-sync-async-spike.API_WEIGHT.2`
