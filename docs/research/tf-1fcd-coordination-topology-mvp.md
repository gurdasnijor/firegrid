# tf-1fcd Coordination Topology MVP

This tiny-firegrid simulation is the runnable scaffold for
`docs/research/agent-orchestration-vs-choreography-experiment.md`.

The headline path is a live frontier-model experiment. Enable it explicitly:

```bash
FIREGRID_COORDINATION_EXPERIMENT_LIVE=1 \
ANTHROPIC_API_KEY=... \
pnpm --filter @firegrid/tiny-firegrid simulate:run coordination-topology
```

With live mode enabled, the simulation runs the minimum A/B/C arms from the
experiment design:

- A `single`: one Claude ACP participant owns the whole task packet and must use
  Firegrid tools before its final marker.
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
live mode, `GREEN` is reserved for runs whose trace evidence shows every
required participant marker and the minimum channel-specific primitive use for
its arm; otherwise the run reports `INCONCLUSIVE`.

CI and credential-less local runs use `fixture-smoke` mode. That path launches a
deterministic stdio-jsonl fixture only to validate public session launch and
channel-tool plumbing. It is deliberately labeled non-experiment output and must
not be used as the agentic-patterns result.

Validation run on 2026-05-21:

```txt
live run: 2026-05-21T08-35-16-983Z__coordination-topology
simulate:show: spans=39967 traces=1 errored=0 mode=live-frontier
verdict: GREEN; missing_evidence_count=0
participant evidence:
  single/single-agent: call(worker_action), send(artifacts), send(scores)
  developer-authored-orchestration/investigator: send(artifacts)
  developer-authored-orchestration/builder: wait_for(artifacts), send(artifacts)
  developer-authored-orchestration/reviewer: wait_for(artifacts), send(artifacts), send(scores)
  choreography/planner-peer: send(claims), wait_for_any(claims+artifacts), send(artifacts)
  choreography/builder-peer: send(claims), wait_for_any(claims+artifacts), send(artifacts)
  choreography/reviewer-peer: send(claims), wait_for_any(claims+artifacts), send(artifacts)
simulate:perf window: 183374ms
```
