# tf-ll90.5.1 — shape-c terminal-ordering, real-path run

Date: 2026-06-03
Run: `2026-06-03T10-53-11-659Z__shape-c-terminal-ordering`
Trace: `packages/firelab/.simulate/runs/2026-06-03T10-53-11-659Z__shape-c-terminal-ordering/trace.jsonl`
(local artifact — `.simulate/` is gitignored; the load-bearing span values are
quoted inline below)
Bead: `tf-ll90.5.1`
Outcome: `DriverCompleted` · 202 spans · sides `sdk=152 driver=34 subprocess=15`

Rebuilds the retired pre-unified `shape-c-terminal-ordering` probe (a
vitest-probe sim with no real spawn) as a REAL-PATH run. The invariant under
test: **a session's terminal completion is bound to the durable lifecycle (the
terminal input/signal), not to a raw `agent_output` event.**

## Probe

The sim folder is exactly `index.ts`, `driver.ts`, `host.ts`. `driver.ts`
imports only `@firegrid/client-sdk` and `effect`. `host.ts` composes the REAL
`FiregridRuntime` unified factory with `defaultProductionAdapterLayer` and **no
channel/observer overrides** — the only host config is a
`RuntimeEnvResolverPolicy` authorizing `ANTHROPIC_API_KEY` for the real spawn.
The terminal path under test is the default `FiregridRuntime` close binding.

The driver uses the public client seam only:

- `firegrid.sessions.createOrLoad` with a `local.jsonl` ACP runtime whose argv is
  the real off-the-shelf agent `npx -y @agentclientprotocol/claude-agent-acp@0.36.1`
- `session.prompt` (a no-tools marker-reply prompt) + `session.start`
- `session.wait.forAgentOutput` until the agent completes a turn
- `session.snapshot` (pre-close)
- `session.close({ reason })` — the explicit durable terminal
- `session.snapshot` (post-close)

No `Effect.runPromise`/`process.exit`; the driver returns `void` and emits a
span tree. No verdict object is computed in-sim (per methodology §"Three jobs").

## Real-path evidence

Real `claude-acp` subprocess over the production local-process sandbox:

```text
trace line 47: firegrid.agent_event_pipeline.source.local_process.open_byte_pipe   (1×, "real subprocess spawn")
trace line 56: firegrid.unified.adapter.start_or_attach   firegrid.context.id=session:firelab:shape-c-terminal-ordering
driver attr:   firegrid.shape_c_terminal.spawn_target = "npx -y @agentclientprotocol/claude-agent-acp@0.36.1"
sides:         subprocess=15
```

A full turn of **raw `agent_output`** arrived before any terminal, and the real
agent actually answered (the marker was produced):

```text
firegrid.shape_c_terminal.turn_output_tags        = Ready,Status,TextChunk,TextChunk,TextChunk,Status,TurnComplete
firegrid.shape_c_terminal.turn_complete_observed  = true
firegrid.shape_c_terminal.marker_observed         = true
firegrid.shape_c_terminal.terminated_observed_pre_close = false
```

`TurnComplete` is a raw `agent_output`. It did **not** terminate the session: no
`adapter.deregister` span exists between the turn and the explicit close, and the
process stayed registered (`start_or_attach` ran again for the next input at line
165). This is the negative half of the invariant — agent_output does not bind
the lifecycle.

The retired `signal.ts` path is gone: **0** `firegrid.unified.signal.*` spans in
the trace. Delivery is the per-event path (`unified.runtime-context-session`,
keyed `contextId:inputKey`).

## Terminal-ordering evidence (the invariant)

The explicit `session.close()` is the only thing that bound the lifecycle end:

```text
firegrid.shape_c_terminal.close_acknowledged = true

trace line 190: firegrid.unified.session.terminal_signal   ctx=session:firelab:shape-c-terminal-ordering   start=1780484003557927958
trace line 180: firegrid.unified.adapter.deregister         ctx=session:firelab:shape-c-terminal-ordering   start=1780484003574698500
```

For the same `firegrid.context.id`:

- `terminal_signal.start` ≤ `deregister.start`  (Δ = **16.8 ms**) — the seam
  `session.terminal_ordering` invariant
  (`packages/firelab/src/runner/seam-coverage.ts:297`,
  `countTerminalBeforeDeregister`) holds: **terminal-before-deregister = 1**.
- The `deregister` span (JSONL line 180) *ends* before the `terminal_signal`
  span (line 190): the deregister executes **inside** the terminal-driven
  per-event handler. `emitSessionTerminalSignal`
  (`packages/runtime/src/unified/channel-bindings.ts:252`) opens the
  `terminal_signal` span and executes the terminal `RuntimeContextSessionWorkflow`
  handler, whose `kind:"terminal"` branch
  (`packages/runtime/src/unified/subscribers/runtime-context.ts:88`) runs
  `adapter.deregister` (`codec-adapter.ts:541`, Scope.close → reap).

So the deregister is causally downstream of — and nested within — the durable
terminal input, not any `agent_output`. Span counts in this run:

```text
firegrid.agent_event_pipeline.source.local_process.open_byte_pipe : 1   (real spawn)
firegrid.unified.adapter.start_or_attach                          : 2   (prompt input + terminal input; spawn deduped)
firegrid.unified.adapter.send                                     : 1   (the prompt forward)
firegrid.unified.session.terminal_signal                          : 1   (the close)
firegrid.unified.adapter.deregister                               : 1   (downstream of the terminal)
firegrid.unified.signal.*                                         : 0   (retired path absent)
```

## Process-leak watch (tf-r06u.36 terminal-completion-relay leak)

No leak observed on this path. The explicit close produced exactly one
`adapter.deregister` (Scope.close → process reaped) bound to the terminal signal;
there is no `terminal_signal` left without a following `deregister`, and no
orphaned `start_or_attach` without a matching deregister at session end. The
process-reap completed before the driver's post-close snapshot.

## Finding (classification: confirms landed per-event invariant)

This run validates, on the real path (real `claude-acp` spawn, real production
`FiregridRuntime`, real local-process sandbox, real ACP codec), that **terminal
completion binds the durable lifecycle, not raw `agent_output`**:

1. A real `TurnComplete` agent_output was observed and did **not** deregister the
   session (negative half).
2. The explicit durable terminal (`session.close` → `terminal_signal`) drove the
   `adapter.deregister`, with `terminal_signal` preceding and enclosing the
   deregister for the same `context.id` (positive half).

This is the post-#863 per-event realization of the seam
`session.terminal_ordering`. It is also the natural follow-on to
`tf-ll90-4-control-plane-cancel-close.md` (2026-06-01), which recorded
`session.close` failing as an `unknown channel` (terminal:0, deregister:0) before
the close binding was wired; on current `main` the close binding reaches the
kernel and the ordering invariant holds.

No production gap surfaced. The complementary natural-exit case
(`Terminated` agent_output → observer-relayed terminal input → deregister)
remains covered by `natural-exit-terminal` (tf-r06u.36); this sim covers the
explicit-close terminal that claude-acp (a long-lived server that never
self-exits) requires.
