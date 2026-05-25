# Agent Coordination Patterns Experiment Harness

This is the live experiment harness for
`docs/research/agent-coordination-patterns-experiment.md`.

It is intentionally outside `packages/tiny-firegrid/`. tiny-firegrid remains
useful for deterministic regression simulations, but the headline experiment
should run through Firegrid's public session/tool/trace surfaces.

## What Works In This Scaffold

- Creates a run directory under `.firegrid/agent-coordination-patterns/runs/`.
- Records the shared task packet.
- Composes a real `FiregridLocalHostLive` in-process for each arm and drives
  sessions through `@firegrid/client-sdk`.
- Registers the choreography board as real Firegrid channels, visible to agents
  through MCP tools and to the experiment driver through
  `Firegrid.channels.{send,waitFor,waitForAny}`:
  `coordination.work`, `coordination.claims`, `coordination.findings`,
  `coordination.questions`, `coordination.reviews`, and `coordination.final`.
- Treats `coordination.final` as the completion contract for each arm; an arm
  that produces prose but no final board artifact is marked failed.
- Uses self-contained task packets for the default scenarios, so participants
  do not need shell, filesystem, or repository access to complete the task.
- Sets the host's runtime ACP session permission policy to `allow` so
  conductor-created child sessions can use the declared Firegrid coordination
  tools without a separate human permission UI.
- Writes per-arm execution metadata, prompt, session output, board rows, trace
  path, and summary JSON.
- Scores trace artifacts for correctness, overhead, span-side breakdowns,
  context lifetimes, and representative event timelines.
- Compiles Markdown score, trace, and finding reports from the recorded
  artifacts.
- Writes `TRACE_QUERIES.sql` for deeper DuckDB analysis over the same Firegrid
  OTel JSONL spans.
- Compiles a comprehensive experiment report that maps metrics and durable
  board traces back to the research questions.
- Publishes the core matrix report snapshot and structured analysis data under
  `reports/core-matrix-2026-05-25/`.

The prompt templates are the experimental treatment. They tell each arm what
coordination pattern to use; they do not replace Firegrid session, channel, or
client execution.

## Firegrid Surface Map

The harness is split like a small Firegrid application:

- `src/app/coordination-board.ts` is experiment-specific application code. It
  declares the shared board channels and their row schema.
- `src/host.ts` is the host composition. It composes `FiregridLocalHostLive`,
  the MCP server layer, the local process provider, and the experiment board
  channels. It does not import the Firegrid client.
- `src/client.ts` is the client-side driver. It imports
  `@firegrid/client-sdk`, creates one conductor session per arm, sends the
  arm prompt, and waits for board/session output through public client
  methods. It does not create worker sessions directly and it does not import
  runtime host composition.
- `src/run.ts` owns experiment concerns: scenario selection, durable-streams
  test-server lifecycle, per-arm traces, and artifact files.
- `src/score.ts` and `src/finding.ts` read the artifacts and compile the
  report. They are measurement code, not Firegrid control surfaces.

The conductor is a normal Firegrid agent session with normal Firegrid tools.
It launches participants with `session_new`, prompts them with
`session_prompt`, observes them with `wait_for` on `session.agent_output`, and
publishes the arm result with `send` to `coordination.final`. The bootstrap code
only starts that conductor and records artifacts.

## Run

From the repo root:

```bash
pnpm exec tsx --eval '
  import {
    defaultParticipantRuntime,
    runExperimentMatrix,
  } from "./experiments/agent-coordination-patterns/src/run.ts"

  void runExperimentMatrix({
    scenarioIds: ["solo-baseline", "parallel-slices", "review-revision"],
    arms: ["single", "central", "choreography"],
    runtime: defaultParticipantRuntime,
    timeoutMs: 300_000,
  }).then(console.log)
'
```

That code is intentionally just normal TypeScript. It imports the experiment
plan runner; the Firegrid host and client boundaries remain in `src/host.ts`
and `src/client.ts`. The run itself is conducted inside Firegrid by the
conductor session.

```ts
import {
  defaultParticipantRuntime,
  runExperimentMatrix,
} from "./src/run.ts"

await runExperimentMatrix({
  scenarioIds: ["solo-baseline", "parallel-slices", "review-revision"],
  arms: ["single", "central", "choreography"],
  runtime: defaultParticipantRuntime,
  timeoutMs: 300_000,
})
```

Include the event-driven stress scenarios by passing their scenario ids:

- `shared-board`: delayed questions/findings on `coordination.*`.
- `ambiguous-debug`: incident rows for `agent_silent` and `unknown-channel`
  triage.
- `webhook-burst`: bursty inbound webhook-like rows with duplicate delivery.

Score and compile:

```bash
pnpm exec tsx --eval '
  import { scoreLatestRun } from "./experiments/agent-coordination-patterns/src/score.ts"
  void scoreLatestRun().then(console.log)
'

pnpm exec tsx --eval '
  import { compileLatestFinding } from "./experiments/agent-coordination-patterns/src/finding.ts"
  void compileLatestFinding().then(console.log)
'

pnpm exec tsx --eval '
  import { compileLatestExperimentReport } from "./experiments/agent-coordination-patterns/src/report.ts"
  void compileLatestExperimentReport().then(console.log)
'
```

## Environment

The default runtime is `claude-acp`:

```bash
ANTHROPIC_API_KEY=... pnpm exec tsx --eval '
  import { runExperimentMatrix } from "./experiments/agent-coordination-patterns/src/run.ts"
  void runExperimentMatrix().then(console.log)
'
```

Override the participant runtime in the typed plan:

```ts
await runExperimentMatrix({
  arms: ["single", "central"],
  runtime: {
    agent: "codex-acp",
    agentProtocol: "acp",
    command: ["npx", "-y", "@zed-industries/codex-acp@0.14.0"],
    secretEnv: [],
  },
})
```

## Next Implementation Step

Run the full matrix with real participant runtimes and compare:

- completion status and wall-clock duration;
- trace spans, error spans, and tool-call spans;
- `agent_silent` and `unknown-channel` counts;
- board rows, claim rows, duplicate work, and final artifact quality.
