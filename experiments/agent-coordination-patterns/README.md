# Agent Coordination Patterns Experiment Harness

This is the live experiment harness for
`docs/research/agent-coordination-patterns-experiment.md`.

It is intentionally outside `packages/tiny-firegrid/`. tiny-firegrid remains
useful for deterministic regression simulations, but the headline experiment
should run through Firegrid's public session/tool/trace surfaces.

## What Works In This Scaffold

- Creates a run directory under `.firegrid/agent-coordination-patterns/runs/`.
- Records the shared task packet.
- Runs the live single-agent and central-orchestrator arms through
  `pnpm firegrid -- run`.
- Writes per-arm command metadata, prompt, stdout, stderr, trace path, and
  summary JSON.
- Scores trace artifacts for basic correctness and overhead signals.
- Compiles a Markdown finding from the recorded artifacts.

The choreography arm is specified but gated until the typed board channels are
registered in the Firegrid host. That is deliberate:
`agent-coordination-patterns-experiment.NO_PRIVATE_COORDINATION.1` forbids
silently replacing durable channel coordination with a private file board.

## Run

From the repo root:

```bash
pnpm exec tsx experiments/agent-coordination-patterns/src/index.ts init
```

Then run the currently executable live arms:

```bash
pnpm exec tsx experiments/agent-coordination-patterns/src/index.ts run \
  --arms single,central \
  --task .firegrid/agent-coordination-patterns/latest/task.md
```

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

Add a board-aware host path that registers:

- `coordination.work`
- `coordination.claims`
- `coordination.findings`
- `coordination.questions`
- `coordination.reviews`
- `coordination.final`

Once those are host-declared channels, enable the choreography arm. Until then,
the scaffold refuses to fake choreography through local-only state.
