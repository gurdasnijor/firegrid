# Agent Coordination Patterns Experiment Finding

Status: draft generated from run artifacts

## Scenario Matrix

### review-revision — Review And Revision

Axis: quality through critique

Hypothesis: A draft-review-revise task should reveal whether extra participants improve correctness enough to justify overhead.

Expected divergence: central or choreography should show explicit critique/revision evidence; single may be faster but more likely to miss edge cases.

### solo-baseline — Solo Baseline

Axis: coordination overhead floor

Hypothesis: A localized task with one clear owner should favor the single-agent arm; multi-agent arms should pay coordination overhead without enough upside.

Expected divergence: single should have lower duration, fewer spans, fewer tool calls, and comparable artifact quality.

### webhook-burst — Webhook Burst Triage

Axis: bursty inbound event load

Hypothesis: Bursty inbound events should reveal whether arms can deduplicate, prioritize, and avoid over-coordinating under load.

Expected divergence: single may process linearly; central should delegate independent incidents; choreography should show durable claims preventing duplicate work.


## Arm Summary

| Scenario | Arm | Status | Duration ms | Captured sessions | Outputs | Runtime contexts | Board rows | Spans | Trace errors | Client closed | Tool-call spans |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| review-revision — Review And Revision | central | completed | 81950 | 1 | 75 | 3 | 1 | 2852 | 0 | 0 | 8 |
| review-revision — Review And Revision | choreography | completed | 170854 | 1 | 72 | 4 | 8 | 5395 | 0 | 3 | 24 |
| review-revision — Review And Revision | single | completed | 25178 | 1 | 10 | 1 | 1 | 589 | 0 | 0 | 1 |
| solo-baseline — Solo Baseline | central | completed | 57126 | 1 | 55 | 3 | 1 | 2551 | 0 | 0 | 6 |
| solo-baseline — Solo Baseline | choreography | completed | 124997 | 1 | 45 | 4 | 5 | 3724 | 0 | 3 | 14 |
| solo-baseline — Solo Baseline | single | completed | 27037 | 1 | 10 | 1 | 1 | 589 | 0 | 0 | 1 |
| webhook-burst — Webhook Burst Triage | central | completed | 91150 | 1 | 111 | 3 | 5 | 3691 | 0 | 0 | 14 |
| webhook-burst — Webhook Burst Triage | choreography | completed | 88715 | 1 | 74 | 4 | 10 | 3630 | 0 | 0 | 16 |
| webhook-burst — Webhook Burst Triage | single | completed | 25309 | 1 | 35 | 1 | 5 | 1039 | 0 | 0 | 5 |

## Board Rows By Channel

| Scenario | Arm | Channels |
| --- | --- | --- |
| review-revision — Review And Revision | central | coordination.final:1 |
| review-revision — Review And Revision | choreography | coordination.work:1, coordination.claims:2, coordination.findings:2, coordination.reviews:2, coordination.final:1 |
| review-revision — Review And Revision | single | coordination.final:1 |
| solo-baseline — Solo Baseline | central | coordination.final:1 |
| solo-baseline — Solo Baseline | choreography | coordination.claims:2, coordination.findings:2, coordination.final:1 |
| solo-baseline — Solo Baseline | single | coordination.final:1 |
| webhook-burst — Webhook Burst Triage | central | coordination.work:4, coordination.final:1 |
| webhook-burst — Webhook Burst Triage | choreography | coordination.work:4, coordination.claims:4, coordination.findings:1, coordination.final:1 |
| webhook-burst — Webhook Burst Triage | single | coordination.work:4, coordination.final:1 |

## Trace Shape

| Scenario | Arm | Top sides | Highest-cost span | Highest-cost total ms | Contexts shown |
| --- | --- | --- | --- | ---: | ---: |
| review-revision — Review And Revision | central | host:2371/4256145.2ms, codec:110/219813ms, unknown:76/78696.5ms | firegrid.durable_table.rows | 1032685.4 | 3 |
| review-revision — Review And Revision | choreography | host:4329/11147901.3ms, agent-tools:466/2319289.8ms, unknown:134/1052895.9ms | firegrid.durable_table.rows | 2798265.4 | 4 |
| review-revision — Review And Revision | single | host:486/632742ms, codec:14/23819.5ms, unknown:35/20657.5ms | firegrid.durable_table.rows | 168427.5 | 1 |
| solo-baseline — Solo Baseline | central | host:2128/2755711.7ms, codec:97/140674.4ms, unknown:70/53820.5ms | firegrid.durable_table.rows | 671238.8 | 3 |
| solo-baseline — Solo Baseline | choreography | host:2989/7456272.8ms, agent-tools:328/1829289.4ms, unknown:104/833121.4ms | firegrid.durable_table.rows | 1812632.7 | 4 |
| solo-baseline — Solo Baseline | single | host:486/716674.4ms, codec:14/26930.8ms, unknown:35/23468.7ms | firegrid.durable_table.rows | 190644.9 | 1 |
| webhook-burst — Webhook Burst Triage | central | host:3011/4768830.7ms, codec:147/245555.4ms, unknown:102/88049.7ms | firegrid.durable_table.rows | 1156102.6 | 3 |
| webhook-burst — Webhook Burst Triage | choreography | host:2864/4954648.8ms, agent-tools:351/1183884ms, unknown:118/479817.1ms | firegrid.durable_table.rows | 1161370.4 | 4 |
| webhook-burst — Webhook Burst Triage | single | host:811/637101.2ms, codec:36/24151.6ms, unknown:55/20925.5ms | firegrid.durable_table.rows | 169464.6 | 1 |

## Final Artifacts

| Scenario | Arm | Title | Body excerpt |
| --- | --- | --- | --- |
| review-revision — Review And Revision | central | Review-and-Revision: Harness improvement plan (central arm) | Evidence inspected: task packet + replies from two child sessions (drafter, reviewer) via session.agent_output TextChunks. DRAFT (from drafter child): plan bullets included contract-enforced coordination.final schema/scorer; agents told only Firegrid tools (n… |
| review-revision — Review And Revision | choreography | Final: Experiment harness improvement plan (review-revision) | DRAFT: Board-only oracle; driver schema-validates; require claims+(findings\|reviews) before final; <=1200-char final; arm-agnostic probe each peer >=1 non-final row; synth questions row for missing tools. REVIEW: F1 oracle needs deterministic fold. F2 driver-… |
| review-revision — Review And Revision | single | Review-and-revision: harness improvement plan (single arm) | Evidence inspected: only the task packet (no repo/shell access available or used). DRAFT PLAN: 1. Make coordination.final the sole success oracle; scorer ignores prose. 2. Add board-schema validation at send time (kind, title, status, workId). 3. Emit per-arm… |
| solo-baseline — Solo Baseline | central | Add explicit tool-boundary preamble to task packet | Recommendation: Add a one-paragraph 'Tool boundary' preamble at the TOP of every scenario task packet (before 'Provided materials'), naming the four forbidden tool families explicitly: shell, filesystem/terminal, repository inspection, and Firegrid execute. S… |
| solo-baseline — Solo Baseline | choreography | Require coordination.final body to cite the board rowIds it converged from | Evidence inspected (task packet only): - Driver scores a run by waiting for coordination.final; run is incomplete without it. - Rules already gate final on >=1 claim AND >=1 finding/review present. - Stated risks: optional-prose finals make cross-arm scoring … |
| solo-baseline — Solo Baseline | single | Add per-arm minimum board-row expectations to the task packet | Evidence inspected: only this task packet (Experiment goal, Current harness shape, Known measurement risks, Task, Output contract). Recommendation: extend the packet with a short 'Per-arm board-row expectations' section that names the minimum durable rows eac… |
| webhook-burst — Webhook Burst Triage | central | Webhook burst triage — central orchestrator | Deduped incident groups (by external entity): 1) linear:TF-101 — severity P2 (label flip bug→regression). Evidence rows: linear:TF-101:a, linear:TF-101:duplicate (same external event id, deduped). 2) linear:TF-102 — severity P1 (customer escalation comment). … |
| webhook-burst — Webhook Burst Triage | choreography | Webhook burst triage — deduped groups + recommendation | Evidence inspected (coordination.work rowIds): - 520c320d linear:TF-101:a — TF-101 label bug→regression - 60be49da linear:TF-101:duplicate — same external id as TF-101:a - 80d09943 linear:TF-102:a — TF-102 customer escalation - c8458570 github:check:failed — … |
| webhook-burst — Webhook Burst Triage | single | Webhook Burst Triage — deduped incident groups | Evidence inspected (4 coordination.work rows): - linear:TF-101:a — linear.issue.updated TF-101 (labels bug→regression, atMs 0) - linear:TF-101:duplicate — duplicate delivery, same external entity TF-101 (atMs 500) - linear:TF-102:a — linear.issue.updated TF-1… |

## Representative Timelines

### review-revision — Review And Revision / central

```text
     3.1ms  sdk       ok     firegrid.client.session.create_or_load
     3.2ms  sdk       ok     firegrid.channel.host.sessions.create_or_load.call
     5.6ms  sdk       ok     firegrid.client.session.prompt
    10.5ms  host      ok     firegrid.workflow_engine.workflow.register
      11ms  host      ok     firegrid.workflow_engine.workflow.register
      11ms  host      ok     firegrid.workflow_engine.workflow.register
    12.9ms  host      ok     firegrid.host.control_request.workflow_engine.layer
    13.1ms  host      ok     firegrid.runtime_context.subscriber.dispatch
    13.3ms  host      ok     firegrid.runtime_context.subscriber.source
    14.6ms  host      ok     firegrid.workflow_engine.workflow.register
    14.6ms  host      ok     firegrid.workflow_engine.workflow.register
    14.7ms  host      ok     firegrid.workflow_engine.workflow.register
    15.2ms  host      ok     firegrid.workflow_engine.execution.execute
    18.6ms  unknown   ok     firegrid.mcp.publish_runtime_context_base
```

### review-revision — Review And Revision / choreography

```text
     3.6ms  sdk       ok     firegrid.client.session.create_or_load
     3.7ms  sdk       ok     firegrid.channel.host.sessions.create_or_load.call
     7.3ms  sdk       ok     firegrid.client.session.prompt
    11.4ms  host      ok     firegrid.workflow_engine.workflow.register
      12ms  host      ok     firegrid.workflow_engine.workflow.register
      12ms  host      ok     firegrid.workflow_engine.workflow.register
      14ms  host      ok     firegrid.host.control_request.workflow_engine.layer
    14.3ms  host      ok     firegrid.runtime_context.subscriber.dispatch
    14.5ms  host      ok     firegrid.runtime_context.subscriber.source
    15.9ms  host      ok     firegrid.workflow_engine.workflow.register
    15.9ms  host      ok     firegrid.workflow_engine.workflow.register
    15.9ms  host      ok     firegrid.workflow_engine.workflow.register
    16.5ms  host      ok     firegrid.workflow_engine.execution.execute
    19.6ms  unknown   ok     firegrid.mcp.publish_runtime_context_base
```

### review-revision — Review And Revision / single

```text
     4.2ms  sdk       ok     firegrid.client.session.create_or_load
     4.4ms  sdk       ok     firegrid.channel.host.sessions.create_or_load.call
     7.4ms  sdk       ok     firegrid.client.session.prompt
    11.6ms  host      ok     firegrid.workflow_engine.workflow.register
    12.1ms  host      ok     firegrid.workflow_engine.workflow.register
    12.2ms  host      ok     firegrid.workflow_engine.workflow.register
    14.6ms  host      ok     firegrid.host.control_request.workflow_engine.layer
    14.9ms  host      ok     firegrid.runtime_context.subscriber.dispatch
    15.3ms  host      ok     firegrid.runtime_context.subscriber.source
    20.1ms  host      ok     firegrid.workflow_engine.workflow.register
    20.1ms  host      ok     firegrid.workflow_engine.workflow.register
    20.2ms  host      ok     firegrid.workflow_engine.workflow.register
    20.9ms  host      ok     firegrid.workflow_engine.execution.execute
    25.2ms  unknown   ok     firegrid.mcp.publish_runtime_context_base
```

### solo-baseline — Solo Baseline / central

```text
     4.9ms  sdk       ok     firegrid.client.session.create_or_load
     5.1ms  sdk       ok     firegrid.channel.host.sessions.create_or_load.call
     8.2ms  sdk       ok     firegrid.client.session.prompt
    14.4ms  host      ok     firegrid.workflow_engine.workflow.register
      15ms  host      ok     firegrid.workflow_engine.workflow.register
    15.1ms  host      ok     firegrid.workflow_engine.workflow.register
    17.9ms  host      ok     firegrid.host.control_request.workflow_engine.layer
    18.2ms  host      ok     firegrid.runtime_context.subscriber.dispatch
    18.5ms  host      ok     firegrid.runtime_context.subscriber.source
    22.3ms  host      ok     firegrid.workflow_engine.workflow.register
    22.4ms  host      ok     firegrid.workflow_engine.workflow.register
    22.5ms  host      ok     firegrid.workflow_engine.workflow.register
    25.4ms  host      ok     firegrid.workflow_engine.execution.execute
    35.2ms  unknown   ok     firegrid.mcp.publish_runtime_context_base
```

### solo-baseline — Solo Baseline / choreography

```text
     5.5ms  sdk       ok     firegrid.client.session.create_or_load
     5.7ms  sdk       ok     firegrid.channel.host.sessions.create_or_load.call
     9.2ms  sdk       ok     firegrid.client.session.prompt
    14.9ms  host      ok     firegrid.workflow_engine.workflow.register
    15.5ms  host      ok     firegrid.workflow_engine.workflow.register
    15.6ms  host      ok     firegrid.workflow_engine.workflow.register
    18.2ms  host      ok     firegrid.host.control_request.workflow_engine.layer
    18.5ms  host      ok     firegrid.runtime_context.subscriber.dispatch
    19.7ms  host      ok     firegrid.runtime_context.subscriber.source
    21.8ms  host      ok     firegrid.workflow_engine.workflow.register
    21.8ms  host      ok     firegrid.workflow_engine.workflow.register
    21.9ms  host      ok     firegrid.workflow_engine.workflow.register
    23.6ms  host      ok     firegrid.workflow_engine.execution.execute
    31.3ms  unknown   ok     firegrid.mcp.publish_runtime_context_base
```

### solo-baseline — Solo Baseline / single

```text
    23.5ms  sdk       ok     firegrid.client.session.create_or_load
    23.8ms  sdk       ok     firegrid.channel.host.sessions.create_or_load.call
    36.6ms  sdk       ok     firegrid.client.session.prompt
    45.2ms  host      ok     firegrid.workflow_engine.workflow.register
    46.1ms  host      ok     firegrid.workflow_engine.workflow.register
    46.2ms  host      ok     firegrid.workflow_engine.workflow.register
    49.7ms  host      ok     firegrid.host.control_request.workflow_engine.layer
    50.2ms  host      ok     firegrid.runtime_context.subscriber.dispatch
    50.8ms  host      ok     firegrid.runtime_context.subscriber.source
    52.7ms  host      ok     firegrid.workflow_engine.workflow.register
    52.8ms  host      ok     firegrid.workflow_engine.workflow.register
    52.8ms  host      ok     firegrid.workflow_engine.workflow.register
    53.9ms  host      ok     firegrid.workflow_engine.execution.execute
      64ms  unknown   ok     firegrid.mcp.publish_runtime_context_base
```

### webhook-burst — Webhook Burst Triage / central

```text
       3ms  sdk       ok     firegrid.client.session.create_or_load
     3.1ms  sdk       ok     firegrid.channel.host.sessions.create_or_load.call
     5.7ms  sdk       ok     firegrid.client.session.prompt
    11.4ms  host      ok     firegrid.workflow_engine.workflow.register
    11.9ms  host      ok     firegrid.workflow_engine.workflow.register
      12ms  host      ok     firegrid.workflow_engine.workflow.register
    13.8ms  host      ok     firegrid.host.control_request.workflow_engine.layer
      14ms  host      ok     firegrid.runtime_context.subscriber.dispatch
    14.2ms  host      ok     firegrid.runtime_context.subscriber.source
    15.1ms  host      ok     firegrid.workflow_engine.workflow.register
    15.1ms  host      ok     firegrid.workflow_engine.workflow.register
    15.2ms  host      ok     firegrid.workflow_engine.workflow.register
    15.7ms  host      ok     firegrid.workflow_engine.execution.execute
    18.8ms  unknown   ok     firegrid.mcp.publish_runtime_context_base
```

### webhook-burst — Webhook Burst Triage / choreography

```text
     5.5ms  sdk       ok     firegrid.client.session.create_or_load
     5.7ms  sdk       ok     firegrid.channel.host.sessions.create_or_load.call
     9.8ms  sdk       ok     firegrid.client.session.prompt
    14.5ms  host      ok     firegrid.workflow_engine.workflow.register
    14.8ms  host      ok     firegrid.workflow_engine.workflow.register
    14.9ms  host      ok     firegrid.workflow_engine.workflow.register
    16.8ms  host      ok     firegrid.host.control_request.workflow_engine.layer
    17.1ms  host      ok     firegrid.runtime_context.subscriber.dispatch
    17.3ms  host      ok     firegrid.runtime_context.subscriber.source
    18.3ms  host      ok     firegrid.workflow_engine.workflow.register
    18.3ms  host      ok     firegrid.workflow_engine.workflow.register
    18.4ms  host      ok     firegrid.workflow_engine.workflow.register
    18.9ms  host      ok     firegrid.workflow_engine.execution.execute
    22.4ms  unknown   ok     firegrid.mcp.publish_runtime_context_base
```

### webhook-burst — Webhook Burst Triage / single

```text
     4.7ms  sdk       ok     firegrid.client.session.create_or_load
     4.8ms  sdk       ok     firegrid.channel.host.sessions.create_or_load.call
     8.2ms  sdk       ok     firegrid.client.session.prompt
      14ms  host      ok     firegrid.workflow_engine.workflow.register
    14.5ms  host      ok     firegrid.workflow_engine.workflow.register
    14.6ms  host      ok     firegrid.workflow_engine.workflow.register
    16.8ms  host      ok     firegrid.host.control_request.workflow_engine.layer
    17.2ms  host      ok     firegrid.runtime_context.subscriber.dispatch
    17.6ms  host      ok     firegrid.runtime_context.subscriber.source
    21.5ms  host      ok     firegrid.workflow_engine.workflow.register
    21.5ms  host      ok     firegrid.workflow_engine.workflow.register
    21.6ms  host      ok     firegrid.workflow_engine.workflow.register
    22.2ms  host      ok     firegrid.workflow_engine.execution.execute
    26.3ms  unknown   ok     firegrid.mcp.publish_runtime_context_base
```

## Initial Interpretation

- Treat this as a generated scaffold finding, not a final research conclusion.
- Generic coordination conclusions require comparing successful arms on the same task packet.
- Firegrid-specific implementation findings should be separated from generic coordination findings.

## Acceptance Hooks

- agent-coordination-patterns-experiment.ARTIFACTS.3
