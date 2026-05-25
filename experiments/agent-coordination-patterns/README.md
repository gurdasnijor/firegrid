# Agent Coordination Patterns

This is a Firegrid application that uses Firegrid itself as the durable
execution workbench for comparing agent coordination patterns.

The experiment asks three patterns to solve the same task packets:

- `single`: one agent owns the whole task.
- `central`: one conductor delegates to child sessions, observes their output,
  and synthesizes the result.
- `choreography`: peer sessions coordinate through a shared durable board.

The point is not a benchmark harness wrapped around Firegrid. The point is that
Firegrid supplies the execution substrate: durable sessions, typed channels,
agent-visible tools, event traces, and replayable artifacts.

## Application Shape

The app has the same split a production Firegrid app should have:

- `src/app/coordination-board.ts` defines the application channel surface.
  It registers `coordination.work`, `coordination.claims`,
  `coordination.findings`, `coordination.questions`, `coordination.reviews`,
  and `coordination.final` as typed Firegrid channels backed by a durable board
  table.
- `src/host.ts` composes the Firegrid host. It provides `FiregridLocalHostLive`,
  an MCP edge, the local process runtime, and the coordination-board channels.
  It does not import the client.
- `src/client.ts` is the public client side. It uses `@firegrid/client-sdk` to
  create a conductor session, send the arm prompt, inject inbound board events,
  wait for `coordination.final`, and snapshot the conductor output. It does not
  import host composition.
- `src/run.ts` is experiment automation: scenario selection, per-arm isolation,
  trace file destinations, and artifact directories.
- `src/score.ts`, `src/finding.ts`, and `src/report.ts` are offline analysis
  over the artifacts produced by the Firegrid run.

The conductor is just another Firegrid agent session. It receives normal
Firegrid tools, uses `session_new` to create participants, uses
`session_prompt` to assign work, uses `wait_for` on `session.agent_output` to
observe child output, and publishes the arm's result by sending to
`coordination.final`.

## What Firegrid Provides

- Durable agent sessions and child sessions for each participant.
- App-defined board channels exposed both to agents and to the client.
- Durable board rows that make coordination behavior inspectable after the run.
- OTel traces for session lifetime, tool calls, host/client/codec work, and
  runtime errors.
- Public client methods for creating sessions, sending prompts, waiting on
  channels, and reading snapshots.

The prompt templates are the experimental treatment. They tell each arm what
coordination pattern to use; they do not replace Firegrid session, channel, or
client execution.

## Results

The checked-in core matrix is in
[`reports/core-matrix-2026-05-25.md`](reports/core-matrix-2026-05-25.md).

The structured data bundle is in
[`reports/core-matrix-2026-05-25/`](reports/core-matrix-2026-05-25/):

- `SCORE.md`, `FINDING.md`, and `TRACE.md` summarize the run.
- `scores.json`, `run-summary.json`, and per-arm `score.json` files provide
  structured metrics.
- Per-arm `board-rows.json`, `final-artifact.json`, `sessions.json`, and
  `prompt.md` files show the qualitative coordination trace.
- `TRACE_QUERIES.sql` contains DuckDB queries for raw trace files from a fresh
  local run.

Headline from the core matrix:

- The single-agent arm was fastest and cheapest for bounded tasks.
- The choreography arm produced the richest durable coordination evidence.
- The central arm made delegation and review visible, but paid coordination
  overhead without beating the single-agent arm on latency.
- All nine arms completed with zero `agent_silent`, zero `unknown-channel`, and
  zero trace error spans.

## Reproducing

To run the experiment locally, use the app modules directly:

- Compose the host with `makeAgentCoordinationFiregridHost` from `src/host.ts`.
- Create the client layer with `makeAgentCoordinationFiregridClient` from
  `src/client.ts`.
- Start a conductor session through the client path and wait for
  `coordination.final`.

The matrix runner in `src/run.ts` repeats that same app flow across scenarios
and arms while assigning isolated namespaces and trace destinations. The
default participant runtime is `claude-acp` and expects `ANTHROPIC_API_KEY` in
the environment.

The core matrix used for the checked-in report ran these scenarios:

- `solo-baseline`: coordination overhead floor.
- `review-revision`: quality through critique.
- `webhook-burst`: bursty inbound event load.

Other available scenarios:

- `shared-board`: delayed questions/findings on `coordination.*`.
- `ambiguous-debug`: incident rows for `agent_silent` and `unknown-channel`
  triage.
- `parallel-slices`: independent work slices for multi-agent delegation.

The analysis pipeline is intentionally separated from execution:

- `scoreLatestRun()` compiles metrics from the latest run directory.
- `compileLatestFinding()` writes the concise finding.
- `compileLatestExperimentReport()` writes the full report.

## Extending

To adapt this example:

- Add or change app channels in `src/app/coordination-board.ts`.
- Change host composition in `src/host.ts`.
- Change the client workflow in `src/client.ts`.
- Add scenario packets in `src/scenarios.ts`.
- Add analysis dimensions in `src/score.ts` and report rendering in
  `src/report.ts`.
