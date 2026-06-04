# Experiment: Which Agent Coordination Patterns Are Actually Necessary?

Date: 2026-05-21
Status: design to approve

This is first a **general agentic-patterns experiment**, not a Firegrid proof.
Firegrid is the experiment workbench: a durable session, channel, and trace
substrate for running the same task under different coordination patterns.

The research question is general:

> Are sophisticated agent coordination patterns actually useful, or is the
> community over-building around a problem where a dead-simple baseline performs
> just as well?

That distinction matters. The result should say something about agent
coordination patterns, not only about one framework. Firegrid's role is to make
the experiment observable and repeatable: agents can spawn sessions, exchange
messages, watch typed channels, publish durable artifacts, and leave trace
evidence without the experiment hiding coordination in bespoke harness code.

---

## Firegrid As Experiment Workbench

For readers new to Firegrid, the relevant idea is simple: Firegrid provides a
durable host plane where agents interact through sessions and typed channels
rather than through a one-off experiment harness.

The experiment should use these workbench capabilities directly:

- a parent agent can create child sessions;
- any session can be prompted after creation;
- session output is a durable, waitable stream;
- agents can wait on opaque host-declared channel names;
- agents can race multiple channel waits;
- agents can publish rows to egress-capable channels;
- agents can call request/response channels;
- tool metadata can describe the available channels;
- trace artifacts record channel dispatch, tool calls, permission flow, and
  session output;
- deterministic firelab simulations can replay the same shapes for
  regression coverage.

The implementation test is therefore not "can we write a custom coordinator?"
It is: can coordination arms be expressed using the same durable session and
channel tools available to normal agents?

---

## Prior Art And Novelty

The surrounding space already has several mature threads. This experiment should
not pretend that "multi-agent coordination" or "software factories" are new.
The narrower question is:

> When does decentralized choreography beat a single agent or explicit
> orchestration on realistic software work, and what durable infrastructure does
> it require to stay legible rather than chaotic?

| Thread | Representative sources | What it contributes | Gap for this experiment |
| --- | --- | --- | --- |
| Background agents | [Background Agents](https://background-agents.com/) | Frames coding agents as cloud/background workers needing sandboxing, governance, triggers, audit trails, and fleet coordination. | Mostly an infrastructure and operating-model thesis; it does not isolate which coordination topology performs best. |
| Durable event backbones | [Inngest is the Nervous System](https://joelclaw.com/inngest-is-the-nervous-system) | Shows the value of durable event pipelines, independent retries, reboot survival, and an event bus as the system backbone. | Strong substrate precedent, but coordination is primarily function/workflow oriented rather than peer agent choreography. |
| Multi-agent conversation frameworks | [AutoGen](https://arxiv.org/abs/2308.08155) | Makes multi-agent conversation programmable with agents, tools, humans, and interaction patterns. | Flexible conversation is not the same as proving decentralized production coordination under task pressure. |
| Software-company role systems | [ChatDev](https://arxiv.org/abs/2307.07924), [MetaGPT](https://arxiv.org/abs/2308.00352), [Agyn](https://arxiv.org/abs/2602.01465) | Demonstrate specialized roles, structured communication, SOPs, review loops, and team-like decomposition. | Most examples encode an organization up front: roles, stages, manager-like control, or SOP pipelines. |
| Pattern catalogs | [Multi-Agent Systems: Design Patterns and Orchestration](https://tetrate.io/learn/ai/multi-agent-systems) | Name hierarchy, pipeline, hub-and-spoke, peer-to-peer, blackboard, orchestration, and choreography patterns. | Useful taxonomy, but not a measured software-factory experiment. |
| Dark software factory products | [Fabro](https://fabro.sh/), [Dark Factory](https://godarkfactory.com/) | Turn long-running coding work into graphs, issue pipelines, human gates, CI, dashboards, and merge/review loops. | These mostly prove structured factories are useful, not whether choreography can outperform or complement them. |

The novel claim to test is:

> A durable shared observation/action substrate may let agents coordinate by
> choreography: agents watch typed state, claims, events, and traces, then decide
> locally what to do next, without a central manager assigning every step.

The experiment should prove or falsify that claim against simpler baselines.
If choreography wins, the result should say where it won: recovery,
parallelism, review quality, interruption handling, or lower manager bottleneck.
If it loses, that is equally useful.

---

## Goals

1. Identify which coordination patterns are useful under real task pressure.
2. Compare sophisticated multi-agent coordination against simple baselines.
3. Run at least one choreography-style trial where agents discover work through
   durable channels rather than central assignment.
4. Capture cost, failure modes, coordination patterns, and artifacts suitable
   for a technical blog or release writeup.
5. Produce an implementation plan before running the experiment.

---

## Non-Goals

- Do not assume choreography wins.
- Do not compare framework marketing claims.
- Do not use an LLM judge as the primary scorer.
- Do not hide coordination complexity in harness-only helpers.
- Do not invent a private experiment board when a Firegrid channel can express
  the same interaction.
- Do not treat fixture agents as the headline experiment. Fixtures are for CI
  and regression coverage.

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

Can agents discover relevant work and each other through shared durable
artifacts and channels, rather than through a central orchestrator assigning
tasks?

---

## Candidate Task

The task should be realistic enough to require coordination but small enough to
run repeatedly.

Recommended first workload:

```text
Given a small product/repo task packet:
  - understand requirements
  - inspect code/docs
  - produce an implementation or design patch
  - review or critique the result
  - incorporate feedback
  - produce final handoff artifacts
```

The task packet should include:

- a repo or fixture with intentionally relevant and irrelevant files;
- a target outcome;
- hidden or deterministic scoring checks;
- at least one external event or review decision;
- enough parallelizable subtasks for multi-agent patterns to have a chance.

The first task should be shaped so all arms can complete it through the same
Firegrid public surfaces. The experiment is not allowed to give one arm a
private helper unavailable to the other arms.

---

## Baselines And Arms

Run the same task across several coordination arms.

| Arm | Description | What It Tests |
| --- | --- | --- |
| A. Single large-context agent | One agent gets all context and owns the whole task. | Dead-simple baseline. |
| B. Scripted decomposition | The driver splits fixed subtasks and combines results. | Whether decomposition alone helps. |
| C. Central orchestrator | One manager agent uses `session_new`, `session_prompt`, and `wait_for session.agent_output` to delegate and observe workers. | Classic manager/worker orchestration. |
| D. Choreography / indirect discovery | Peer agents observe shared board channels, claim work, publish findings, and react locally. | Whether decentralized coordination works. |
| E. Independent specialist attempts | Several agents work independently; a selector combines or chooses outputs. | Whether parallel independent attempts beat coordination. |

The minimum viable first run should include A, C, and D. Add B and E if budget
allows.

---

## Firegrid-Native Coordination Board

The "shared workspace / durable artifact board" should be a typed set of
Firegrid channels. These channels are product-owned experiment channels,
registered in the host for the experiment run.

Suggested board channels:

| Channel | Direction | Purpose |
| --- | --- | --- |
| `coordination.work` | ingress + egress | Work items agents can observe and publish. |
| `coordination.claims` | ingress + egress | Claim attempts for work items. |
| `coordination.findings` | ingress + egress | Durable findings, facts, and investigation notes. |
| `coordination.questions` | ingress + egress | Questions or help requests. |
| `coordination.reviews` | ingress + egress | Review comments and decisions. |
| `coordination.final` | ingress + egress | Final artifact declarations. |
| `coordination.control` | call | Optional bounded control operations, such as approving a human gate. |

Agents should interact with these through the agent-visible tools:

- use `wait_for` to observe one channel;
- use `wait_for_any` to watch several board channels at once;
- use `send` to publish work, claims, findings, questions, reviews, and final
  artifact declarations;
- use `call` only for explicit request/response operations.

The board schema should be simple and scalar-matchable so `wait_for` predicates
remain ergonomic.

Example work row:

```json
{
  "runId": "run-001",
  "arm": "choreography",
  "workId": "inspect-docs",
  "kind": "investigation",
  "status": "open",
  "title": "Inspect relevant architecture docs",
  "body": "Find the constraints that apply to the task.",
  "createdBy": "driver",
  "createdAt": "2026-05-24T00:00:00.000Z"
}
```

Example claim row:

```json
{
  "runId": "run-001",
  "arm": "choreography",
  "workId": "inspect-docs",
  "claimId": "claim-peer-planner-001",
  "claimantSessionId": "ctx_...",
  "observedCursor": 12,
  "status": "attempted",
  "createdAt": "2026-05-24T00:00:02.000Z"
}
```

The winning claim is derived by durable append order: first valid claim wins.
The scorer can then measure duplicate claims, claim-lost work, and whether
agents respected prior claims.

---

## Choreography Trial Requirement

At least one trial must avoid central assignment.

Choreography arm shape:

```text
driver:
  - seeds the board with the task packet and initial work rows
  - starts peer agents
  - observes native Firegrid artifacts
  - scores after termination

agents:
  - receive role prompts, not task assignments
  - watch board channels with wait_for_any
  - claim useful work by sending claim rows
  - publish findings, questions, reviews, and final artifacts
  - observe peer work through board rows and session.agent_output when needed
```

The trial should measure whether agents can:

- discover relevant work;
- avoid duplicate claims;
- hand off through durable artifacts;
- notice and respond to peer findings;
- converge without a central scheduler.

Failure is useful if it shows choreography needs stronger channel schemas,
better prompts, different claim semantics, or better observability.

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

Do not run the full Cartesian product initially. Pick cells most likely to
separate the arms:

1. low coordination / small context;
2. high coordination / larger context;
3. high coordination / external review or interruption.

---

## Metrics

Use deterministic scoring wherever possible.

| Metric | Meaning | Source |
| --- | --- | --- |
| task success | Did the result satisfy target checks? | Tests, deterministic rubric, hidden fixtures. |
| quality | Was the result complete, correct, and maintainable? | Human rubric plus deterministic checklist. |
| cost | How much model/tool budget was spent? | Provider usage, trace spans, tool-call counts. |
| latency | Wall-clock time to terminal result. | Run trace. |
| coordination overhead | Handoffs, duplicate claims, idle waits, repeated work. | Board rows plus trace. |
| recovery | Did the arm complete after interruption? | Trace plus final board state. |
| observability | Can a human understand what happened? | Trace tree, board rows, final artifacts. |
| reuse | Did intermediate artifacts help later agents? | Finding/review references and board links. |

Do not make "number of agents" itself a virtue. More agents only matter if they
improve quality, latency, cost, recovery, or observability.

---

## Native Artifact Scoring

The scorer should read Firegrid-native artifacts rather than private harness
state.

Required inputs:

- OTel JSONL trace for the arm;
- `session.agent_output` observations for every participant;
- coordination board rows;
- tool-call spans;
- permission spans;
- final artifact rows;
- deterministic task checks.

Suggested derived metrics:

- `sessionsStarted`
- `childSessionsStarted`
- `toolCallsByName`
- `waitForCalls`
- `waitForAnyCalls`
- `boardRowsByChannel`
- `claimAttempts`
- `winningClaims`
- `duplicateClaims`
- `unclaimedCompletedWork`
- `findingsReferencedByLaterRows`
- `finalArtifactDeclared`
- `finalArtifactPassesChecks`
- `totalWallClockMs`
- `agentSilentErrors`
- `unknownChannelErrors`

The placeholder `scoreArm(...)` in any implementation should be a thin wrapper
around these artifact readers, not a hidden source of truth.

---

## Evaluation

For each arm, report:

- final outcome: pass, partial, or fail;
- what changed: files, artifacts, or decisions produced;
- cost and time;
- coordination overhead;
- where coordination helped;
- where coordination got in the way;
- representative trace excerpt;
- representative board excerpt.

Compact summary format:

```text
A. single agent
  + simplest setup
  + lowest coordination overhead
  - missed second-order review issue

C. central orchestration
  + child sessions completed targeted subtasks
  + parent observed child output through session.agent_output
  - manager bottleneck delayed reviewer activation

D. choreography
  + peers picked up newly discovered work through coordination.work
  + reviewer reacted to coordination.findings without manager prompt
  - duplicated one investigation before claim semantics were clear
```

---

## Hypotheses

These are hypotheses, not desired conclusions.

### H1: Simple Baselines Win Small Tasks

For small or tightly scoped tasks, a single large-context agent should match or
beat multi-agent setups on cost and reliability.

### H2: Developer-Authored Orchestration Helps When Decomposition Is Obvious

Fixed-topology orchestration should help when work naturally decomposes and the
developer-authored graph captures the right sequence.

### H3: Fixed Topologies Struggle When Coordination Changes At Runtime

As external events, review feedback, and task discoveries increase, a static
graph should either need more pre-authored branches or route useful work through
awkward handoff points.

### H4: Choreography Helps When Work Is Parallel And Externally Driven

Choreography should shine when many items can progress independently and agents
can coordinate through durable artifacts rather than manager instructions.

### H5: Choreography Fails Without Strong Shared-State Semantics

If the board lacks clear claims, provenance, and terminal state, choreographed
agents may duplicate work or miss peer findings.

---

## Implementation Requirements

The showcase run should use real frontier-model participants. A fixture agent
is useful for CI and regression tests, but it cannot demonstrate whether model
capability actually uses durable temporal primitives.

The arm code should make the coordination pattern obvious and use the public
client and agent-tool surfaces directly.

Canonical runtime:

```ts
import { Firegrid, local } from "@firegrid/client-sdk"

export const claudeAcpRuntime = local.jsonl({
  argv: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.36.1"],
  agent: "claude-acp",
  agentProtocol: "acp",
  envBindings: [{ name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" }],
  runtimeContextMcp: { enabled: true },
})
```

### A. Single Agent

The driver creates one session, prompts it with the full task packet, starts it,
waits for terminal output, then scores artifacts.

### B. Scripted Decomposition

The driver creates fixed role sessions, prompts each with a predetermined
subtask, gathers outputs, and combines them. The graph is fixed by the driver.

### C. Central Orchestrator

The driver starts one manager session. The manager must use agent tools to
delegate:

- `session_new` to create child sessions;
- `session_prompt` to send child tasks;
- `wait_for` on `session.agent_output` to observe child replies.

The driver should not create worker sessions on the manager's behalf. That
would hide the orchestration behavior being tested.

### D. Choreography

The driver starts peer sessions and seeds board channels. Peers receive role
prompts and the board contract, not individual assignments. Peers must discover
work by waiting on board channels and publish progress by sending board rows.

### E. Independent Attempts

The driver starts several independent sessions with the same task packet, waits
for outputs, and starts a selector session to choose or combine results.

---

## firelab Implementation Shape

Implement the repeatable evidence path under:

```text
packages/firelab/src/simulations/agent-coordination-patterns/
  board.ts
  driver.ts
  fixture-agent.ts
  host.ts
  scorer.ts
  index.ts
  FINDING.md
```

Recommended split:

- `board.ts`: channel schemas and registration helpers.
- `host.ts`: Firegrid host composition for the experiment channels.
- `fixture-agent.ts`: deterministic agents for CI and regression.
- `driver.ts`: arm runners using `Firegrid` public surfaces.
- `scorer.ts`: artifact readers and deterministic metrics.
- `FINDING.md`: run result, caveats, and next steps.

Modes:

| Mode | Purpose | Agent runtime |
| --- | --- | --- |
| fixture | CI/regression, deterministic failures, channel contract checks | local deterministic JSONL agents |
| live | headline experiment, real model behavior | `claude-acp` or another frontier ACP agent |

The fixture and live modes should share the same board schema, arm runners, and
scorer. Only the runtime factory and task packet should differ.

---

## Implementation Spec

Before implementation, write a short feature spec for the experiment harness:

```text
features/firegrid/agent-coordination-patterns-experiment.feature.yaml
```

Minimum requirements to encode as stable acceptance criteria:

- each arm runs the same task packet;
- central orchestration uses `session_new`, `session_prompt`, and
  `session.agent_output`;
- choreography discovers work through durable board channels;
- agents publish claims, findings, reviews, and final artifacts through
  registered channel tools;
- the scorer reads native Firegrid artifacts rather than hidden harness state;
- fixture and live modes share driver logic;
- final results separate generic coordination conclusions from Firegrid-specific
  implementation findings.

Implementation comments and tests should reference those stable criteria so the
experiment remains auditable as the harness evolves.

---

## Required Artifacts

The experiment should produce:

- prior-work summary;
- approved design;
- feature spec with stable acceptance criteria;
- task fixture and scoring rubric;
- run matrix;
- per-arm trace artifacts;
- per-arm board artifacts;
- result table;
- failure-mode catalogue;
- final research finding;
- blog/release-ready figures or trace excerpts.

Suggested docs:

```text
docs/research/agent-coordination-prior-work.md
docs/research/agent-coordination-experiment-design.md
docs/research/agent-coordination-experiment.FINDING.md
```

---

## Acceptance Criteria

Before implementation:

- Prior work is summarized.
- Independent variables are named.
- Control task is approved.
- Feature spec exists and names the implementation requirements.
- Baselines include single large-context and central orchestration.
- Choreography arm includes indirect discovery through board channels.
- Metrics and scoring are deterministic enough to compare runs.
- The design is approved before implementation.

After implementation:

- At least A, C, and D arms run.
- Central orchestration proves manager -> child -> manager observation using
  `session_new`, `session_prompt`, and `session.agent_output`.
- Choreography proves peer discovery through durable board channels.
- Runs capture cost, failure modes, coordination patterns, board rows, and
  trace artifacts.
- Artifacts are suitable for technical blog/release material.
- Results report where simple wins, where orchestration wins, and where
  choreography wins or fails.
- Framework-specific conclusions are separated from generic agent-pattern
  conclusions.

---

## Open Questions

1. What exact task should be optimized first: software implementation,
   research, triage, incident response, or factory-style PR workflow?
2. Who provides the human rubric, and how many runs need human review?
3. Which board channels are required for the first run, and which can wait?
4. What model/provider set is in scope for the first run?
5. Should the first public writeup present Firegrid as the implementation
   substrate only, or explicitly as part of the research finding?
