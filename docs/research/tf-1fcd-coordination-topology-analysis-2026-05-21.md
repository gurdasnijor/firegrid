# tf-1fcd Coordination Topology Analysis

Date: 2026-05-21
Run: `2026-05-21T09-21-52-281Z__coordination-topology`
Mode: live frontier-model A/B/C run

This note interprets the native tiny-firegrid artifacts for the first tractable
coordination-topology run. It is intentionally post-run analysis, not driver
scoring.

## Artifact Set

- Trace:
  `packages/tiny-firegrid/.simulate/runs/2026-05-21T09-21-52-281Z__coordination-topology/trace.jsonl`
- `simulate:show 2026-05-21T09-21-52-281Z__coordination-topology`
- `simulate:perf 2026-05-21T09-21-52-281Z__coordination-topology`
- Durable channel/tool rows as represented in native trace spans and
  `Toolkit.handle` parameters.

## Run Summary

`simulate:show` reported one trace with 72,555 spans and zero errored spans.
The side breakdown was:

```txt
host=67369 sdk=3213 agent-tools=715 subprocess=592 codec=561 driver=104
```

The driver span recorded the intended artifact surface:

```txt
coordination.mode=live-frontier
coordination.live_arms=single,developer-authored-orchestration,choreography
coordination.arm_count=3
coordination.participant_count=7
coordination.completed_participant_count=7
coordination.analysis_surface=trace.jsonl,simulate:show,simulate:perf,durable-channel-rows
```

All seven participant lifecycle spans completed:

| Arm | Participant | Duration |
| --- | --- | ---: |
| A single | single-agent | 75.4s |
| B developer-authored orchestration | investigator | 49.2s |
| B developer-authored orchestration | builder | 63.9s |
| B developer-authored orchestration | reviewer | 66.1s |
| C choreography | builder-peer | 65.2s |
| C choreography | reviewer-peer | 83.2s |
| C choreography | planner-peer | 89.3s |

## Native Tool And Channel Evidence

Runtime-context tool execution appeared through native `Toolkit.handle` and
`firegrid.host.agent_tools.tool_use.execute` spans. Successful agent-tool
execution counts by primitive:

```txt
call=1
send=15
wait_for=2
wait_for_any=3
```

Successful channel/tool calls by target:

```txt
coordination.worker_action call=1
coordination.artifacts send=7
coordination.claims send=3
coordination.reports send=3
coordination.scores send=2
coordination.artifacts wait_for=2
coordination.claims/coordination.artifacts wait_for_any=3
```

The single-agent arm called `coordination.worker_action`, then published a
final artifact and score row. The final artifact identified the unstable
provider idempotency key, the `claimNext` double-claim predicate, and the
completed-run fence as task-relevant issues.

The developer-authored orchestration arm followed the fixed
investigator -> builder -> reviewer path. Native `wait_for` spans show the
builder and reviewer waiting on `coordination.artifacts`, and `send` spans show
investigation, implementation, review/report, and score artifacts published
through the shared channel surface.

The choreography arm published three claim rows and each peer used
`wait_for_any` over the shared claim/artifact workspace before publishing
artifacts. The trace therefore shows peer observation and publication through
durable channels rather than driver-side partitioning after launch.

## Performance Notes

`simulate:perf` reported a 343.9s wall-clock window. The largest self-time
spans were ACP prompt/runtime waits, not a tight driver polling loop:

```txt
firegrid.agent_event_pipeline.acp.prompt: 85.6s, 79.4s, 71.9s, 62.6s, ...
```

The perf report did show model/runtime idle gaps between roughly 5.3s and
10.8s. For this run those gaps align with frontier participant latency and
session waiting, not a bespoke evidence scraper or hot-polling loop in the
simulation driver.

## Findings

The run satisfies the V0 shape: A/B/C only, real frontier-model participants,
public session launch/prompt/start/wait, and native Firegrid artifacts as the
evidence surface.

The single-agent arm produced the most direct patch analysis. It found the core
idempotency and retry bugs without coordination overhead.

The developer-authored orchestration arm produced a legible fixed handoff:
investigation first, implementation plan second, review/score last. This is
useful as the fixed-graph baseline.

The choreography arm demonstrated shared claim/artifact observation through
`wait_for_any` and durable rows. It is still a V0 trial: role hints strongly
shaped peer behavior, and one run is not enough to claim choreography is better
than the fixed graph or single-agent baseline.

## Product-Surface Gaps To Keep Visible

The run was possible without reintroducing an in-driver evidence harness, but
the analysis still required manual trace queries to summarize channel activity.
That should remain a product-surface ergonomics gap rather than a simulation
helper:

- `tf-9x11`: router-backed channel discovery/filtering should make the shared
  workspace easier for agents and analysis tools to navigate.
- `tf-1r3h`: sync/async closure semantics should make lifecycle and wait
  completion easier to reason about without bespoke loops.
- `tf-2osu`: public experiment ergonomics should expose thin, native summaries
  over trace spans and durable rows.

## Fixture Smoke

Credential-less CI remains a separate non-experiment smoke path. The smoke run
`2026-05-21T09-21-01-640Z__coordination-topology` produced 434 spans, zero
errored spans, and no perf idle gaps. It validates public session launch and
channel-tool plumbing only; it is not evidence for the coordination experiment.
