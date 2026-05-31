# Production-flow OTel coverage

Status: empirical artifact (regenerated per simulation run)
Date: 2026-05-31
Owner: Firegrid Architecture
Predecessors:
- `SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md` (Phase 3 — adapter Tag, observer, factory, e2e loop)
- `SDD_FIREGRID_UNIFIED_PRODUCTION_CODEC_ADAPTER.md` (Phase E — production codec adapter)
- `2026-05-31-unified-architecture-mental-model.md`

## Purpose

The `unified-kernel-validation` simulation's production-flow scenario closes the codec → journal → observer → workflow → relay → session loop. This doc captures the OTel evidence: every architectural seam the unified architecture introduces is exercised, and every one of them emits a span. Run-time proof that the wiring is real.

## How to regenerate

```bash
# 1. Run the sim end-to-end.
pnpm --filter @firegrid/tiny-firegrid simulate:run unified-kernel-validation

# 2. Produce the seam coverage report for the most recent run.
pnpm trace:seams

# Or against a specific runId:
pnpm trace:seams 2026-05-31T13-45-15-150Z__unified-kernel-validation
```

The script reads `packages/tiny-firegrid/.simulate/runs/<runId>/trace.jsonl`, scans every span, and asserts each documented architectural seam has at least one matching span. Exit code is non-zero if any seam is uncovered. A `seam-coverage.json` artifact lands in the run directory.

## What "seam" means

Every place where one architectural tier hands off to another is a seam. The unified architecture has ~16:

| Seam | Span name | What it proves fired |
|---|---|---|
| `client.channel.dispatch` | `firegrid.channel.dispatch` | Channel router dispatched a call/send/wait_for verb (driver entry point) |
| `signal.send` | `firegrid.unified.signal.send` | `sendSignal` — durable record + workflow resume |
| `signal.record` | `firegrid.unified.signal.record` | `recordSignal` — durable record without resume (used by auto-relays inside Activities) |
| `session.body` | `firegrid.unified.session.body` | `RuntimeContextSessionWorkflow` body iteration |
| `adapter.start_or_attach` | `firegrid.unified.adapter.start_or_attach` | Adapter spawn/attach |
| `adapter.send` | `firegrid.unified.adapter.send` | Input forwarded to codec |
| `adapter.deregister` | `firegrid.unified.adapter.deregister` | Terminal cleanup |
| `permission.workflow.execute` | `unified.permission-roundtrip.execute` | `PermissionRoundtripWorkflow` execute (driver call OR observer fork) |
| `permission.request.write` | `unified.permission.request/{key}` | Permission roundtrip wrote the open-request row |
| `permission.relay` | `unified.permission.relay/{key}` | Auto-relay back to session (§E) |
| `tool.workflow.execute` | `unified.tool-dispatch.execute` | `ToolDispatchWorkflow` execute |
| `tool.execute` | `unified.tool.execute/{toolUseId}` | Tool executor invocation |
| `tool.relay` | `unified.tool.relay/{toolUseId}` | Auto-relay back to session (§D) |
| `journal.observer.daemon` | `firegrid.unified.journal_observer.daemon` | `JournalObserverLive` is alive |
| `workflow.engine.execute` | `firegrid.workflow_engine.execution.execute` | Engine running a workflow |
| `workflow.engine.resume` | `firegrid.workflow_engine.execution.resume.body` | Engine waking a parked body |
| `codec.acp.initialize` | `firegrid.agent_event_pipeline.acp.initialize` | Real ACP codec: connection.initialize fired |
| `codec.acp.new_session` | `firegrid.codec.sdk.call` | Real ACP codec: newSession SDK call fired |
| `codec.acp.prompt` | `firegrid.agent_event_pipeline.acp.prompt` | Real ACP codec: connection.prompt fired |
| `codec.acp.session_update` | `firegrid.agent_event_pipeline.acp.session_update` | Real ACP codec: incoming agent updates (tool_call etc.) |
| `codec.acp.exit` | `firegrid.agent_event_pipeline.acp.exit` | Real ACP codec: clean teardown |

A run that misses any of these has a wiring regression — the architecture is no longer end-to-end. The check is hard.

## Sample coverage (from a real sim run)

```
OTel seam coverage — packages/tiny-firegrid/.simulate/runs/2026-05-31T13-45-15-150Z__unified-kernel-validation
Total spans in trace: 1333
Seams: 16/16 covered

  ✓ client.channel.dispatch          26× — Channel router dispatches a call/send/wait_for verb
  ✓ signal.send                      20× — sendSignal — durable record + workflow resume
  ✓ signal.record                     1× — recordSignal — durable record without resume (auto-relay land)
  ✓ session.body                     21× — RuntimeContextSessionWorkflow body iteration
  ✓ adapter.start_or_attach           1× — Adapter startOrAttach — spawn/attach to agent process
  ✓ adapter.send                      3× — Adapter send — input forwarded to codec
  ✓ adapter.deregister                1× — Adapter deregister — terminal cleanup
  ✓ permission.workflow.execute       5× — PermissionRoundtripWorkflow execute (driver call or observer fork)
  ✓ permission.request.write          6× — Permission roundtrip writes the open-request row
  ✓ permission.relay                  3× — PermissionRoundtripWorkflow relays decision back to session (§E)
  ✓ tool.workflow.execute             5× — ToolDispatchWorkflow execute
  ✓ tool.execute                      4× — ToolDispatchWorkflow invokes the executor
  ✓ tool.relay                        4× — ToolDispatchWorkflow relays result back to session (§D)
  ✓ journal.observer.daemon           1× — JournalObserverLive daemon
  ✓ workflow.engine.execute          47× — WorkflowEngine.execute — driver workflow invocation
  ✓ workflow.engine.resume           97× — WorkflowEngine.resume — engine waking a parked body
```

Counts vary across scenarios. The production-flow scenario alone fires:
- 1× `adapter.start_or_attach`
- 3× `adapter.send` (prompt → tool-result → permission-response; terminal short-circuits)
- 1× `adapter.deregister`
- 1× `tool.execute`
- 1× `permission.relay`
- 1× `tool.relay`

Plus repeated signal/engine activity. The other counts come from scenarios 1-6.

## Span hierarchy (production-flow chain)

The trace shows this hierarchy for one input → codec → observer → workflow → relay round-trip:

```
firegrid.channel.dispatch (verb=send, target=unified.session.send_input)
└── firegrid.unified.signal.send (name=prompt-1)
    └── firegrid.workflow_engine.execution.resume.body (RuntimeContextSessionWorkflow)
        └── firegrid.unified.session.body
            └── unified.session.send/{ctxId:attempt}/0 (Activity)
                └── firegrid.unified.adapter.send (kind=prompt, adapter.kind=fake-codec)
                    └── (codec writes ToolUse row to RuntimeOutputTable.events)

firegrid.unified.journal_observer.daemon
└── (consumes the ToolUse row)
    └── firegrid.workflow_engine.execution.execute (ToolDispatchWorkflow, toolUseId=tu-…)
        └── unified.tool.execute/{toolUseId} (Activity)
            └── (executor returns resultJson)
        └── unified.tool.relay/{toolUseId} (Activity)
            └── firegrid.unified.signal.send (name=tool-result:{toolUseId})
                └── firegrid.workflow_engine.execution.resume.body (session)
                    └── firegrid.unified.session.body (cursor++)
                        └── unified.session.send/{ctxId:attempt}/1 (Activity)
                            └── firegrid.unified.adapter.send (kind=tool-result)
                                └── (codec writes PermissionRequest row)

… and so on through the permission roundtrip + final deregister.
```

Every arrow above corresponds to a parent → child span in the trace. The full chain is one TraceId, and `parentSpanId` links every step back to the originating `firegrid.channel.dispatch`.

## How to use this in practice

- **Verify a new wiring lands cleanly:** run the sim, then `pnpm trace:seams`. Anything in the red column means an architectural seam is structurally absent — either the code doesn't run, or it forgot its instrumentation.
- **Debug a missing relay:** if `tool.relay` shows 0×, the `ToolDispatchWorkflow` body's terminal `sendSignal` activity didn't run; check observer wiring or the workflow body.
- **Track regression on follow-up SDDs:** keep this seam set as a hard invariant. Any change to the architectural surface that drops a seam needs to either explain why or add an equivalent one.

## Seam set as living invariant

The list above is canonical. If a new seam gets added to the architecture (e.g. a peer-event observer relay), it should land in `scripts/trace-seam-coverage.ts` `SEAMS` array at the same time. The script is the source of truth for "what does end-to-end coverage mean today."
