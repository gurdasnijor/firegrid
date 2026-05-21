# Experiment: Which Agent Coordination Patterns Are Actually Necessary?

Date: 2026-05-21
Status: design to approve

This is a **general agentic-patterns experiment**, not a proof for any one
runtime or framework.

The core question:

> Are sophisticated agent coordination patterns actually useful, or is the
> community over-building around a problem where a dead-simple baseline performs
> just as well?

The primary result should be publishable as an experiment about frontier models
and coordination patterns.

---

## Prior Art And Novelty

The surrounding space already has several mature threads. This experiment should
not pretend that "multi-agent coordination" or "software factories" are new.
The open question is narrower: **when does decentralized choreography beat a
single agent or a developer-authored workflow graph on realistic software work,
and what infrastructure does it require to be legible rather than chaotic?**

### What Existing Work Already Covers

| Thread | Representative sources | What it contributes | Gap for this experiment |
| --- | --- | --- | --- |
| Background agents | [Background Agents](https://background-agents.com/) | Frames coding agents as cloud/background workers that need sandboxing, governance, triggers, audit trails, and fleet coordination rather than a developer's laptop. | Mostly an infrastructure and operating-model thesis; it does not isolate which coordination topology performs best. |
| Durable event backbones | [Inngest is the Nervous System](https://joelclaw.com/inngest-is-the-nervous-system) | Shows the value of durable event pipelines: independent retries, reboot survival, long-running pipelines, and an event bus as the system backbone. | Strong substrate precedent, but the coordination is still primarily function/workflow oriented rather than peer agent choreography. |
| Multi-agent conversation frameworks | [AutoGen](https://arxiv.org/abs/2308.08155) | Makes multi-agent conversation programmable, mixing LLMs, tools, human inputs, and custom interaction patterns. | Flexible conversation is not the same as proving decentralized production coordination under task pressure. |
| Software-company role systems | [ChatDev](https://arxiv.org/abs/2307.07924), [MetaGPT](https://arxiv.org/abs/2308.00352), [Agyn](https://arxiv.org/abs/2602.01465) | Demonstrate specialized agent roles, structured communication, SOPs, review loops, and team-like decomposition for software work. | Most examples encode an organization/process up front: roles, stages, manager-like coordination, or SOP pipelines. |
| Pattern catalogs | [Multi-Agent Systems: Design Patterns and Orchestration](https://tetrate.io/learn/ai/multi-agent-systems) | Names the familiar architectures: hierarchy, pipeline, hub-and-spoke, peer-to-peer, blackboard, orchestration, and choreography, including tradeoffs around bottlenecks and debugging. | Useful taxonomy, but not a software-factory experiment with measured baselines. |
| Dark software factory products | [Fabro](https://fabro.sh/), [Dark Factory](https://godarkfactory.com/) | Turn long-running coding work into graphs, issue pipelines, human gates, CI checks, dashboards, and merge/review loops. | These are largely orchestration/harness products. They prove structured factories are useful, not whether choreography can outperform or complement them. |

### What Looks Novel

The novelty is not "agents can collaborate." Existing work has already shown
role-based teams, chat-based collaboration, workflow graphs, and background
execution. The more novel claim to test is:

> A durable shared observation/action substrate may let agents coordinate by
> choreography: agents watch typed state, claims, events, and traces, then decide
> locally what to do next, without a developer-authored graph assigning every
> step.

That is closer to a blackboard or peer-to-peer system than to a DAG runner, but
with two constraints that most examples do not emphasize:

- every coordination artifact must be durable and replayable;
- the same task must be run against simpler baselines, so choreography earns
  its complexity rather than being assumed superior.

If choreography wins, the result should say where it won: recovery, parallelism,
review quality, interruption handling, or adaptation to new context. If it
loses, that is equally valuable: it identifies which primitives are missing,
where fixed topology is actually helpful, and where "agent swarm" rhetoric is
overbuilt for the task.

---

## Goals

1. Identify which coordination patterns are useful under real task pressure.
2. Compare sophisticated multi-agent coordination against simple baselines.
3. Run at least one choreography-style trial where agents discover each other
   indirectly rather than being centrally assigned.
4. Capture cost, failure modes, coordination patterns, and artifacts suitable
   for a technical blog or release writeup.
5. Produce a plan Henry can approve before implementation.

---

## Non-Goals

- Do not prove any one runtime or framework is good by construction.
- Do not assume choreography wins.
- Do not compare framework marketing claims.
- Do not use an LLM judge as the primary scorer.
- Do not hide coordination complexity in harness-only helpers.

---

## Primary Research Questions

### RQ1: Does sophistication help?

Given the same task and model budget, do multi-agent coordination patterns beat
a simple single-agent baseline?

### RQ2: Which coordination patterns help?

If multi-agent wins, which part mattered?

- decomposition;
- parallelism;
- specialization;
- critique/review;
- shared durable memory;
- indirect discovery;
- central scheduling;
- explicit handoff.

### RQ3: Where do patterns fail?

Where do more complex patterns get worse?

- setup overhead;
- brittle prompts;
- lost handoffs;
- duplicated work;
- coordination deadlocks;
- harder observability;
- higher cost without quality improvement.

### RQ4: Can choreography work without a fixed planner?

Can agents discover relevant work and each other through shared artifacts or
channels, rather than through a pre-authored graph assigning tasks?

---

## Candidate Task

The task should be realistic enough to require coordination but small enough to
run repeatedly.

Recommended first workload:

```txt
Given a small product/repo task packet:
  - understand requirements
  - inspect code/docs
  - produce an implementation or design patch
  - review or critique the result
  - incorporate feedback
  - produce final handoff artifacts
```

This maps naturally to software-factory work, but should be framed generically:
"agent coordination on a multi-step technical task."

The task packet should include:

- a repo or fixture with intentionally relevant and irrelevant files;
- a target outcome;
- hidden or deterministic scoring checks;
- at least one external event or review decision;
- enough parallelizable subtasks for multi-agent patterns to have a chance.

---

## Baselines And Arms

Run the same task across several coordination arms.

Each arm should be described by the same four questions:

- **Who sees the task?**
- **Who decides the next step?**
- **How do participants communicate?**
- **What counts as success?**

| Arm | Who Decides? | Communication Shape | What It Tests |
| --- | --- | --- | --- |
| A. Single agent | one frontier model | no handoff; one continuous context | whether anything more complex is justified |
| B. Developer-authored orchestration | experiment author | fixed topology, fixed task slices, fixed merge path | whether a LangGraph/Maestra-style graph helps |
| C. Choreography | each peer agent locally | agents publish/read shared artifacts and claims | whether decentralized coordination works |
| D. Independent attempts | no live coordination | several isolated attempts, final selection | whether sampling beats coordination |

Do not include a central manager-agent arm in the primary comparison. A manager
agent can itself behave like choreography, so it blurs the line between the
patterns this experiment is trying to separate.

The minimum viable first run is **A, B, and C only**. Arm D is a useful later
baseline, but it should not be included in the first run unless A/B/C already
produce a clean, comparable result.

### Arm A: Single Agent

The control arm.

- One agent receives the task packet, repo access, rubric, and budget.
- It plans, executes, reviews, and produces the final answer itself.
- No other participant sees intermediate work.
- Success means the final artifact passes the same checks as every other arm.

This is the baseline to beat. If it wins on quality, cost, and reliability,
the experiment should say so plainly.

### Arm B: Developer-Authored Orchestration

This is the LangGraph/Maestra-style baseline: a developer writes the topology,
the step order, and the handoff points.

- The experiment author predefines the split, for example: investigate,
  implement, review, summarize.
- Agents receive their fixed slice and return an artifact.
- The workflow combines the artifacts mechanically.
- No agent decides the decomposition, graph shape, or execution order.

This tests whether a hand-authored graph helps when the split is obvious.

### Arm C: Choreography

No central assignment.

- Peer agents share a durable workspace.
- Each peer can read open work, claims, findings, outputs, reviews, and traces.
- Each peer decides locally what to claim, what to publish, and when to stop.
- Handoffs happen through shared artifacts, not manager instructions.

This tests the core choreography question: can decentralized agents coordinate
by watching state rather than being routed by a central planner?

### Arm D: Independent Attempts

Parallelism without coordination.

- Several agents receive the full task independently.
- They do not see each other's intermediate work.
- A final selector picks or combines the best result.

This tests whether the value comes from live coordination, or simply from
sampling multiple independent attempts.

---

## Choreography Trial Requirement

At least one trial must avoid central assignment.

A choreography trial starts with a shared workspace, not a manager.

The workspace contains durable facts such as:

- open work;
- claims;
- findings;
- questions;
- review comments;
- tool results;
- terminal outputs;
- final artifacts.

Agents receive role prompts, not direct assignments:

> Watch the workspace. Claim useful work. Publish what you learn. React when
> other participants produce something relevant.

The trial should measure whether agents can:

- discover relevant work;
- avoid duplicate claims;
- hand off through shared artifacts;
- notice and respond to peer findings;
- converge without a central scheduler.

Failure is useful if it shows choreography needs stronger primitives, better
prompts, or different observability.

---

## Independent Variables

Start with a small matrix.

| Variable | Values |
| --- | --- |
| topology | single, developer-authored orchestration, choreography |
| coordination load | low, medium, high |
| external interruption | none, review event, crash/restart |
| context pressure | small fixture, large fixture |
| task coupling | independent subtasks, tightly coupled subtasks |

Do not run the full Cartesian product initially. Pick the cells most likely to
separate the arms:

1. low coordination / small context;
2. high coordination / larger context;
3. high coordination / external review or interruption.

---

## Metrics

Use deterministic scoring wherever possible.

| Metric | Meaning | Source |
| --- | --- | --- |
| task success | did it satisfy the target checks | tests, rubric, hidden fixtures |
| quality | completeness, correctness, maintainability | human rubric or deterministic review checklist |
| cost | total model calls/tokens/tool calls | traces/provider usage |
| latency | wall-clock to terminal result | run trace |
| coordination overhead | handoff count, duplicate work, idle time | trace + artifact board |
| recovery | completed after interruption? | trace + final state |
| observability | can a human understand what happened? | trace tree and artifact quality |
| reuse | did useful intermediate artifacts help later agents? | board/finding references |

Avoid making "number of agents" itself a virtue. More agents only matter if
they improve quality, latency, cost, or recovery.

---

## Evaluation

Keep the evaluation easy to read.

For each arm, report:

- final outcome: pass, partial, or fail;
- what changed: files, artifacts, or decisions produced;
- cost and time;
- where coordination helped;
- where coordination got in the way;
- representative trace excerpt.

A compact diff-style summary is better than a large JSON record:

```txt
A. single agent
  + simplest setup
  + lowest coordination overhead
  - missed second-order review issue

B. developer-authored orchestration
  + review happened reliably
  - graph forced an awkward handoff after new context appeared

C. choreography
  + peers picked up newly discovered work without changing the graph
  - duplicated one investigation before claim semantics were clear
```

---

## Hypotheses

These are hypotheses, not desired conclusions.

### H1: Simple Baselines Win Small Tasks

For small or tightly scoped tasks, a single large-context agent should match or
beat multi-agent setups on cost and reliability.

### H2: Developer-Authored Orchestration Helps When Decomposition Is Obvious

Fixed-topology orchestration should help when the work naturally decomposes and
the developer-authored graph captures the right sequence.

### H3: Fixed Topologies Struggle When Coordination Changes At Runtime

As external events, review feedback, and task discoveries increase, a static
graph should either need more pre-authored branches or route useful work through
awkward handoff points.

### H4: Choreography Helps When Work Is Parallel And Externally Driven

Choreography should shine when many items can progress independently and agents
can coordinate through durable artifacts rather than manager instructions.

### H5: Choreography Fails Without Strong Shared-State Semantics

If the shared board/channel model lacks clear claims, provenance, and terminal
state, choreographed agents may duplicate work or miss peer findings.

---

## V0 Execution Contract

The first implementation should be tractable and comparable rather than broad.
It should run only A/B/C, on the same task packet, with the same model family
and comparable budgets.

The point of the showcase is frontier models plus durable coordination tools.
The primary run should use real frontier-model participants. Fixture agents are
useful for CI and regression tests, but they cannot demonstrate whether model
capability actually uses durable temporal primitives.

The driver should be minimal:

- launch participants;
- give each participant the task, available tools, role constraints, and
  success criteria;
- wait for participant lifecycle completion;
- leave evidence collection to the experiment substrate's native trace,
  event, and artifact outputs.

The driver should not contain a parallel verdict system, score model, transcript
scraper, or hidden orchestration loop. Prompts should describe the task,
available tools, and success criteria. They should not provide exact payloads
whose echo becomes the evidence of success.

### Arm A: Single Agent

- One frontier-model participant receives the whole task packet.
- It decides how to investigate, design, review, and produce the final artifact.
- Success is judged from the final artifact and native run evidence after the
  run, not by the driver while the run is executing.

### Arm B: Developer-Authored Orchestration

- The experiment author fixes the topology, task slices, and handoff path.
- Participants run in that predefined order or graph.
- Participants may use the shared workspace, but they do not choose the graph
  shape or change the handoff path.
- This is not a manager-agent arm; the graph is authored by the experimenter.

### Arm C: Choreography

- Peer participants start from a shared workspace and role hints.
- Each peer decides locally what to claim, inspect, publish, review, or hand off.
- Communication happens through shared durable artifacts and claims.
- No driver-side partitioning assigns work to peers after launch.

The participant-facing contract is:

```txt
observe workspace
claim work when appropriate
publish findings and artifacts
request or record review
produce or react to final artifacts
```

Any helper required to make those actions ergonomic should be treated as a
product-surface gap, not hidden as experiment-only convenience code.

---

## Required Artifacts

The experiment should produce:

- prior-work summary;
- approved design;
- task fixture and scoring rubric;
- run matrix;
- per-arm trace artifacts;
- result table;
- failure-mode catalogue;
- final research finding;
- blog/release-ready figures or trace excerpts.

Suggested docs:

```txt
docs/research/agent-coordination-prior-work.md
docs/research/agent-coordination-experiment-design.md
docs/research/agent-coordination-experiment.FINDING.md
```

---

## Acceptance Criteria

Before implementation:

- [ ] Prior work is summarized.
- [ ] Independent variables are named.
- [ ] Control task is approved.
- [ ] Baselines include single large-context and orchestration.
- [ ] Choreography arm includes indirect discovery.
- [ ] Metrics and scoring are deterministic enough to compare runs.
- [ ] Henry approves the design.

After implementation:

- [ ] At least A, B, and C arms run.
- [ ] Runs capture cost, failure modes, and coordination patterns.
- [ ] Artifacts are suitable for technical blog/release material.
- [ ] Results report where simple wins, where orchestration wins, and where
      choreography wins or fails.
- [ ] Framework-specific conclusions are separated from generic agent-pattern
      conclusions.

---

## Open Questions

1. What exact task should be optimized: software implementation, research,
   triage, incident response, or factory-style PR workflow?
2. Who provides the human rubric, and how many runs need human review?
3. Should the first choreography arm use shared files, durable channels, issue
   comments, or a purpose-built board?
4. What model/provider set is in scope for the first run?
