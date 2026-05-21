# Experiment: Which Agent Coordination Patterns Are Actually Necessary?

Date: 2026-05-21
Status: design to approve

This is first a **general agentic-patterns experiment**, not a Firegrid proof.

The core question:

> Are sophisticated agent coordination patterns actually useful, or is the
> community over-building around a problem where a dead-simple baseline performs
> just as well?

Firegrid can be used as the implementation substrate and can produce an
additional appendix about durable coordination, but the primary result should be
publishable even if Firegrid is not mentioned.

---

## Prior Art And Novelty

The surrounding space already has several mature threads. This experiment should
not pretend that "multi-agent coordination" or "software factories" are new.
The open question is narrower: **when does decentralized choreography beat a
single agent or an explicit orchestrator on realistic software work, and what
infrastructure does it require to be legible rather than chaotic?**

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
> locally what to do next, without a central manager assigning every step.

That is closer to a blackboard or peer-to-peer system than to a DAG runner, but
with two constraints that most examples do not emphasize:

- every coordination artifact must be durable and replayable;
- the same task must be run against simpler baselines, so choreography earns
  its complexity rather than being assumed superior.

If choreography wins, the result should say where it won: recovery, parallelism,
review quality, interruption handling, or lower manager bottleneck. If it loses,
that is equally valuable: it identifies which primitives are missing, where
central control is actually helpful, and where "agent swarm" rhetoric is
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

- Do not prove Firegrid is good by construction.
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

### RQ4: Can choreography work without a central planner?

Can agents discover relevant work and each other through shared artifacts or
channels, rather than through a central orchestrator assigning tasks?

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

| Arm | Description | What It Tests |
| --- | --- | --- |
| A. Single large-context agent | one agent gets all context and does the task | dead-simple baseline |
| B. Simple scripted decomposition | harness splits task into fixed subtasks, agents execute, harness combines | whether decomposition alone helps |
| C. Central orchestrator | one manager agent delegates to workers and tracks state | classic manager/worker orchestration |
| D. Choreography / indirect discovery | peer agents observe shared work artifacts and decide what to do | whether decentralized coordination works |
| E. Standalone specialist swarm | several specialist agents work independently, no live coordination, final aggregation | whether parallel independent attempts beat coordination |

The minimum viable first run should include A, C, and D. Add B and E if the
task budget allows.

---

## Choreography Trial Requirement

At least one trial must avoid central assignment.

Choreography arm shape:

```txt
shared workspace / durable artifact board:
  work items
  claims
  findings
  questions
  review comments
  terminal outputs

agents receive role prompts, not task assignments:
  "Watch the board. Claim useful work. Publish findings. React to others."
```

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
| topology | single, central orchestration, choreography |
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

## Scoring

Use a mixed scoring model:

1. Deterministic checks first: tests pass, expected files changed, required
   artifacts exist, known failure cases avoided.
2. Human rubric second: clarity, correctness, maintainability, usefulness.
3. Trace metrics third: cost, latency, coordination overhead.

Recommended result row:

```ts
interface CoordinationExperimentResult {
  arm: "single" | "scripted" | "orchestrator" | "choreography" | "swarm"
  taskId: string
  seed: string
  success: boolean
  score: number
  wallClockMs: number
  modelCallCount: number
  tokenEstimate?: number
  toolCallCount: number
  duplicateWorkCount: number
  stuckOrIdleCount: number
  handoffCount: number
  recoveryPassed?: boolean
  notes: ReadonlyArray<string>
}
```

---

## Hypotheses

These are hypotheses, not desired conclusions.

### H1: Simple Baselines Win Small Tasks

For small or tightly scoped tasks, a single large-context agent should match or
beat multi-agent setups on cost and reliability.

### H2: Orchestration Helps When Decomposition Is Obvious

Central orchestration should help when the work naturally decomposes and the
manager can keep the whole plan in context.

### H3: Orchestration Bottlenecks Under High Coordination Load

As external events and worker reports increase, a central orchestrator should
show context growth, idle workers, and recovery fragility.

### H4: Choreography Helps When Work Is Parallel And Externally Driven

Choreography should shine when many items can progress independently and agents
can coordinate through durable artifacts rather than manager instructions.

### H5: Choreography Fails Without Strong Shared-State Semantics

If the shared board/channel model lacks clear claims, provenance, and terminal
state, choreographed agents may duplicate work or miss peer findings.

---

## Firegrid Add-On Track

After the generic design is approved, Firegrid can host the experiment.

This add-on answers:

> Can Firegrid serve as the durable substrate underneath all coordination
> paradigms without changing the user-facing coordination model?

Firegrid-specific success criteria:

- all arms can use the same client/session/channel surface;
- the participant code does not import DurableTable, workflow engine, kernel
  internals, stream URLs, or runtime command APIs;
- orchestration and choreography are both expressible as user-level patterns;
- trace/show/perf artifacts are rich enough for debugging and blog material;
- any helper needed to make the experiment usable becomes a product-surface gap.

Firegrid should be implementation evidence, not the primary claim. The public
writeup can include an appendix:

```txt
Appendix: Running the same coordination experiment on Firegrid's durable
substrate
```

---

## Firegrid Implementation Sketch

If implemented in tiny-firegrid, suggested location:

```txt
packages/tiny-firegrid/src/simulations/coordination-patterns/
  index.ts
  driver.ts
  host.ts
  task.ts
  board.ts
  channels.ts
  prompts.ts
  arms/
    single.ts
    scripted.ts
    orchestrator.ts
    choreography.ts
    swarm.ts
  score.ts
  artifacts.ts
```

The Firegrid implementation should still preserve the generic experiment arms.
Do not turn the generic experiment into a Firegrid architecture proof.

Participant launch should look like end-user client code:

```ts
import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

const launchParticipant = (externalKey: string, prompt: string) =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: { source: "coordination-patterns", id: externalKey },
      runtime: local.jsonl({
        argv: [process.execPath, "--version"],
        agentProtocol: "stdio-jsonl",
        runtimeContextMcp: { enabled: true },
      }),
      createdBy: "coordination-patterns-experiment",
    })

    yield* session.whenReady
    yield* session.prompt({ payload: prompt })
    yield* session.start()
    return session
  })
```

Start with deterministic fixture agents. Add live Codex/Claude/ACP canaries
only after deterministic runs work.

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

- [ ] At least A, C, and D arms run.
- [ ] Runs capture cost, failure modes, and coordination patterns.
- [ ] Artifacts are suitable for technical blog/release material.
- [ ] Results report where simple wins, where orchestration wins, and where
      choreography wins or fails.
- [ ] Firegrid-specific conclusions are separated from generic agent-pattern
      conclusions.

---

## Open Questions

1. What exact task should be optimized: software implementation, research,
   triage, incident response, or factory-style PR workflow?
2. Who provides the human rubric, and how many runs need human review?
3. Should the first choreography arm use shared files, durable channels, issue
   comments, or a purpose-built board?
4. Should Firegrid be the first implementation substrate, or should the generic
   experiment design be reviewed independently before implementation?
5. What model/provider set is in scope for the first run?
