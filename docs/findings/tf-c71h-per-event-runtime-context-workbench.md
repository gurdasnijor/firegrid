# tf-c71h — per-event RuntimeContext workbench (trace evidence)

- **Date:** 2026-06-02
- **Kind:** tiny-firegrid WORKBENCH finding (methodology.md "The workbench
  pattern"). The trace is the deliverable; this file is prose with citations.
- **Sim:** `packages/tiny-firegrid/src/simulations/per-event-runtime-context/`
- **Run:** `2026-06-02T21-54-42-508Z__per-event-runtime-context`
  (`packages/tiny-firegrid/.simulate/runs/<runId>/trace.jsonl`)
- **Decision support for:** §0.1 of the RuntimeContext reconcile proposal
  (`docs/proposals/PROPOSAL_RUNTIME_CONTEXT_KEYED_SUBSCRIBER_RECONCILE_2026-06-02.md`)
  and `docs/analysis/2026-06-02-runtime-shape-blast-radius-and-prior-art.md` §4.
- **Frame (source-verified, not re-litigated here):** the actor/per-event model
  is already in production — `PermissionRoundtripWorkflow` /
  `ToolDispatchWorkflow` are per-event fresh executions (await-once / run,
  return). EXACTLY ONE body diverges: `subscribers/runtime-context.ts`'s
  `while (!reachedTerminal)` parked loop (`Workflow.suspend`,
  runtime-context.ts:113-120). This workbench gathers trace evidence that the
  RuntimeContext loop can adopt the per-event fresh-execution shape for the
  MULTI-event-per-key session-input case. It is fresh-execution-per-event over a
  durable cursor — NOT return-and-re-drive (a returned execution cannot be
  re-armed: `signal.ts:150`; and `engine.resume` no-ops a missing execution:
  `engine-runtime.ts:184-185`).

## What the sim does

`host.ts` composes the REAL `FiregridRuntime(spec, defaultProductionAdapterLayer())`
and overrides ONLY the inbound session-input channel bindings
(`session.prompt`, `host.prompt`, `session.close`; plus exported production STUB
Lives for `host.sessions.start` / `session.cancel`) to route each public input
to a fresh `workbench.per-event-runtime-context` handler execution over two real
`DurableTable`s on real durable streams: an append-only input log keyed
`${contextId}:${seq}` and a per-context consume cursor keyed `${contextId}`. The
parked `RuntimeContextSessionWorkflow` is left registered-but-dormant.
`host.permissions.respond` is left as the factory's production binding.

The per-event body mirrors `runtime-context.ts` MINUS the while/suspend loop:
`startOrAttach` (Activity-memoized) → read the durable cursor (O(1)) → read
exactly this event's input row (O(1)) → `terminal` ⇒ `deregister` & return, else
`adapter.send` + advance cursor + return. No fake codec/adapter/sandbox/recorder
and no Tag-swap of the spawn path: the fixture is the real ACP example agent
(`src/bin/fake-acp-agent-process.ts`) spawned through the production
`ProductionCodecAdapterLive`. `driver.ts` is `@firegrid/client-sdk`-only and
drives three prompts + a close into one session, sequentially.

## The five proofs (read off the trace)

**1. Per-event, run-to-completion; the parked body is dormant; real spawn.**
Three prompts + one close ⇒ **four** fresh `workbench.per-event-runtime-context.execute`
roots (trace L107, L175, L243, L298), each completing (its `workbench.per_event.body`
returns: L103, L171, L239, L294, all status OK). The parked workflow
`unified.runtime-context-session` has **zero** execution spans in the entire
trace — its only mention is its `workflow.register` span (registered-but-dormant;
the per-event handler is registered alongside it). A **real** process spawn is
present: `firegrid.agent_event_pipeline.source.local_process.open_byte_pipe` (L54)
and `firegrid.unified.adapter.start_or_attach` against the real production codec
adapter.

**2. Per-key ordering (OBSERVED, not forced).** Each body span annotates
`firegrid.workbench.seq` and `firegrid.workbench.cursor_consumed`; in every event
`seq === cursor.consumed` at entry (`seq_matched_cursor=true`): seq 0/1/2/3 met
cursor 0/1/2/3. The driver drives sequentially, so this confirms the cursor is a
correct per-key consume position; it does not by itself prove serialization under
concurrent appends (see "What this does not prove").

**3. Durable cursor advances 0→1→2; no double-send.** The cursor advances via
`workbench.per-event.advance_cursor` activities for seq 0/1/2 (L102, L170, L238);
the body reads cursor_consumed 0→1→2→3 across the four executions. No double-send
is guaranteed by **Activity memoization**: `adapter.send` runs inside an
Activity-memoized `Activity.make` per execution (L84, L154, L220), so a retried
execution does not re-fire an already-delivered send. (Full crash-recovery — kill
the host mid-execution and confirm the cursor + activity table resume without a
re-send — is **public-surface-blocked** from the airgapped driver: it would need
generation teardown/recovery controls the client SDK does not expose, exactly as
`unified-kernel-validation` notes for its P1B/P2C probes. The durable substrate
that makes it work — the cursor row + the engine activity table — is present and
exercised; the recovery *trigger* is not reachable from the public seam.)

**4. Multi-turn continuity (the §D3 question).** `startOrAttach` is called on
**every** event (L69, L137, L205, L273 — four calls, same `contextId`), but the
process byte pipe is opened **once** (`open_byte_pipe` appears once, L54). The
three later `startOrAttach`es are no-op reattaches to the first event's live
process (codec-adapter.ts:408 / adapter.ts registry). The driver observed agent
output on all three turns (`output_matched_count=3`, three `TextChunk`s), i.e. a
single live process served all three per-event executions. The terminal close's
per-event execution `deregister`s once (L289/L293), and the process exits (L283).

**5. Complexity contrast.** The per-event body does O(1) work per event: one
`cursor.get` + one input-row `get` (both keyed point reads). The parked body
re-reads **all** of an execution's signals every wake via `readSignalsFor`
(runtime-context.ts:114 → `signal.ts:220-227`, a full `coll.toArray.filter`
rescan) and holds a long-lived suspended fiber per session. The workbench shows
no long-lived per-session fiber — each execution is born, advances O(new rows),
and dies.

## What this does NOT prove (be honest)

- **Type/lint boundary enforcement** is a compile-time + lint property, not a sim
  output. The workbench's payoff is that it *designs the `Workflow` contract* the
  production per-event tier would implement, which is what would let the
  dep-cruiser/eslint airgap forbid the parked primitive. "Fewer SDDs" is the
  downstream payoff of encoding the decision as a type + lint.
- **Per-key serialization under concurrency.** The driver is sequential, so
  `seq === cursor.consumed` is observed, not stress-tested. Whether two truly
  concurrent appends for one `contextId` serialize is owned by the channel/engine
  layer; the cursor design *observes* divergence (it would surface as
  `seq_matched_cursor=false`) but does not enforce ordering by itself.
- **Crash-recovery re-drive** — public-surface-blocked (proof 3).
- **The permission/tool relay path was not exercised in this run.** The fixture
  requests a permission mid-turn, but the driver's "prompt → brief wait → next
  prompt" cadence aborts each turn before the fixture reaches its `requestPermission`
  (snapshot `permission_request_count=0`, `tool_use_count=0`, outputs were
  `Ready,TextChunk,TextChunk,TextChunk`). So this run does not demonstrate the
  permission round-trip end-to-end — see the coupling finding below.

## Surfaced finding — the per-event migration is larger than `runtime-context.ts`

The production sibling workflows relay their results back to the session body via
`sendSignal({ workflow: RuntimeContextSessionWorkflow, ... })`
(`permission-and-tool.ts:45-64,134-163` for permission; the same shape for tool
dispatch). In the unified architecture the permission DECISION reaches the blocked
agent only through the session body's `adapter.send(PermissionResponse)` (the ACP
codec resolves the pending `requestPermission` from a delivered `PermissionResponse`
input: `acp/index.ts:782-799`). A per-event RuntimeContext that leaves those
relays pointed at the (now dormant) `RuntimeContextSessionWorkflow` would **strand
the decision**: `engine.resume` no-ops a missing execution (engine-runtime.ts:184),
so the dormant body is *not* armed (proof 1 stays clean), but the agent's
`requestPermission` then only resolves via the codec's 20s `Cancelled` safety-net
(`acp/index.ts:53`).

**Implication for §0.1:** migrating the one holdout body to the per-event shape
must ALSO retarget the permission/tool relay sinks (and `host.permissions.respond`)
to the per-event handler — it is not a single-file change. This is a contained,
nameable coupling, not a system-wide rewrite, and it is the next thing the
migration design must address. (Category: 1/2 — spec/impl coupling for the
proposed tier; tracked under tf-c71h.)

## Tooling observation (category 4)

The host.ts eslint airgap blocks a NAMED import of the
`RuntimeContextSessionAdapter` specifier
(`eslint.config.js` `ImportSpecifier[imported.name='RuntimeContextSessionAdapter']`,
intent: "do not import recorder adapters or stub RuntimeContextSessionAdapter
Lives"). The rule is written to block STUB *provision* of the adapter; it also
blocks legitimate *consumption* of the real Tag by a workbench-authored workflow
body. This sim consumes the real Tag via the `@firegrid/runtime/unified` namespace
(`Unified.RuntimeContextSessionAdapter`) and provides the real
`defaultProductionAdapterLayer()` — no `Layer.succeed` over the adapter exists, so
it exercises production code (the rule's intent is honoured). The production
per-event tier, being `@firegrid/runtime` code rather than a sim, would not face
this rule at all. If the workbench pattern (a sim-authored body that consumes the
real adapter Tag) becomes common, the rule could be narrowed to its true target —
`Layer.succeed(RuntimeContextSessionAdapter, …)` provision (already covered by a
separate selector) and recorder imports — without the blanket specifier ban. The
rule was left UNCHANGED here (no enforcement gate weakened).

## Sources

`packages/tiny-firegrid/src/simulations/per-event-runtime-context/{host,driver,index}.ts` ·
trace `runs/2026-06-02T21-54-42-508Z__per-event-runtime-context/trace.jsonl`
(L54/L69/L84/L102/L103/L107/L137/L154/L170/L171/L175/L205/L220/L238/L239/L243/L273/L283/L289/L293/L294/L298) ·
`packages/runtime/src/unified/subscribers/runtime-context.ts:113-120` ·
`packages/runtime/src/unified/subscribers/permission-and-tool.ts:45-64,134-163` ·
`packages/runtime/src/unified/signal.ts:150,220-227` ·
`packages/runtime/src/engine/internal/engine-runtime.ts:184-185` ·
`packages/runtime/src/unified/codec-adapter.ts:408` ·
`packages/runtime/src/sources/codecs/acp/index.ts:53,717-799` ·
`docs/analysis/2026-06-02-runtime-shape-blast-radius-and-prior-art.md` §4.
