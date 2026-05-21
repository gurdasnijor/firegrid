# tf-1fcd Coordination Topology MVP

This tiny-firegrid simulation is the runnable scaffold for
`docs/research/agent-orchestration-vs-choreography-experiment.md`.
The Firegrid-specific execution contract is
`docs/research/firegrid-coordination-experiment-execution-contract.md`.

The headline path is a live frontier-model experiment. Enable it explicitly:

```bash
FIREGRID_COORDINATION_EXPERIMENT_LIVE=1 \
ANTHROPIC_API_KEY=... \
pnpm --filter @firegrid/tiny-firegrid simulate:run coordination-topology
```

With live mode enabled, the simulation runs the minimum A/B/C arms from the
experiment design:

- A `single`: one Claude ACP participant owns the whole task packet and uses
  Firegrid tools to publish the final artifact and run metadata.
- B `developer-authored-orchestration`: the driver defines a fixed
  investigator -> builder -> reviewer graph. Agents do not choose the topology,
  and there is no manager-agent participant.
- C `choreography`: peer Claude ACP participants share claims and artifacts;
  each peer receives a role prompt, observes the workspace, claims work, and
  publishes artifacts from local decisions.

The host defines the experiment substrate inline: claims, reports, artifacts,
scores, and a deterministic worker-action callable channel. Participants launch
through `Firegrid.sessions.createOrLoad(...).prompt(...).start()` with the
locked runtime-context MCP primitive profile enabled. The participant-facing
contract is the one from the experiment doc: observe workspace, claim work,
publish findings/artifacts, record review, and produce a final artifact. In
live mode, the driver only launches sessions and waits for participant lifecycle
completion. It does not compute a canonical experiment verdict from participant
text or tool-output scraping. Live prompts describe the task, tools, role
constraints, and success criteria, but intentionally avoid exact JSON payload
examples whose echo could be mistaken for evidence.

The experiment evidence is the normal tiny-firegrid evidence set:

- `trace.jsonl` for driver spans, runtime tool-use spans, channel append/call
  spans, and session lifecycle spans;
- `simulate:show` for the compact run summary;
- `simulate:perf` for latency/span timing;
- durable channel rows behind the typed claims, reports, artifacts, scores, and
  worker-action channel contracts.

Interpretation happens after the run in a trace-backed analysis note. See
`docs/research/tf-1fcd-coordination-topology-analysis-2026-05-21.md`.

CI and credential-less local runs use `fixture-smoke` mode. That path launches a
deterministic stdio-jsonl fixture only to validate public session launch and
channel-tool plumbing. It is deliberately labeled non-experiment output and must
not be used as the agentic-patterns result.
