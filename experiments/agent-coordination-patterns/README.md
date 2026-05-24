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
- Registers the choreography board as real Firegrid MCP channels:
  `coordination.work`, `coordination.claims`, `coordination.findings`,
  `coordination.questions`, `coordination.reviews`, and `coordination.final`.
- Writes per-arm execution metadata, prompt, session output, board rows, trace
  path, and summary JSON.
- Scores trace artifacts for basic correctness and overhead signals.
- Compiles a Markdown finding from the recorded artifacts.

The prompt templates are the experimental treatment. They tell each arm what
coordination pattern to use; they do not replace Firegrid session, channel, or
client execution.

## Run

From the repo root:

```bash
pnpm exec tsx experiments/agent-coordination-patterns/src/index.ts init
```

Then run the live arms:

```bash
pnpm exec tsx experiments/agent-coordination-patterns/src/index.ts run \
  --scenarios solo-baseline,parallel-slices,review-revision \
  --arms single,central,choreography
```

Use `--scenarios all` to include the event-driven stress scenarios:

- `shared-board`: delayed questions/findings on `coordination.*`.
- `ambiguous-debug`: incident rows for `agent_silent` and `unknown-channel`
  triage.
- `webhook-burst`: bursty inbound webhook-like rows with duplicate delivery.

Score and compile:

```bash
pnpm exec tsx experiments/agent-coordination-patterns/src/index.ts score \
  --run-dir .firegrid/agent-coordination-patterns/latest

pnpm exec tsx experiments/agent-coordination-patterns/src/index.ts finding \
  --run-dir .firegrid/agent-coordination-patterns/latest
```

## Environment

The default runtime is `claude-acp`:

```bash
ANTHROPIC_API_KEY=... pnpm exec tsx experiments/agent-coordination-patterns/src/index.ts run --arms single,central
```

You can override the participant command:

```bash
pnpm exec tsx experiments/agent-coordination-patterns/src/index.ts run \
  --agent codex-acp \
  --agent-protocol acp \
  --agent-command "npx -y @zed-industries/codex-acp@0.14.0"
```

## Next Implementation Step

Run the full matrix with real participant runtimes and compare:

- completion status and wall-clock duration;
- trace spans, error spans, and tool-call spans;
- `agent_silent` and `unknown-channel` counts;
- board rows, claim rows, duplicate work, and final artifact quality.
