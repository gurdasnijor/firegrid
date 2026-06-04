# Firegrid

**Durable substrate for choreography-first AI agents.**

Firegrid lets the *model* own the control flow. Instead of authoring a workflow
— step A, then B, route to C — you hand agents a few durable tools and let them
decide sequence, branching, parallelism, and recovery at runtime. Firegrid makes
every one of those decisions durable, replayable, and observable.

Hand-authoring an agent's control flow is the agent-era Bitter Lesson mistake: a
DAG, a `step.run` chain, or a YAML workflow freezes assumptions about ordering,
timeouts, and parallelism that the model is better placed to make at runtime.
Firegrid gives the model durable primitives instead, and turns the dynamic
schedule it chooses into a replayable stream.

**Status:** private beta. Local and internal use are active; public APIs may
still change.

---

## The short version

Real agent work does not happen in one clean function call. A useful agent waits
for a webhook, pauses for a human approval, restarts after a host dies, inspects
what a previous attempt already did, and picks up after CI, GitHub, or Slack
change state.

Firegrid makes those waits, spawns, calls, and approvals **durable**. If an agent
is waiting on something, that wait does not depend on one process staying alive.

---

## The model

Firegrid is not the manager of your agents. It is the durable layer they
coordinate through.

```text
                       outside signals
         webhooks   ·   human approvals   ·   tool results
                               │
                               │   ingress: write durable events
                               ▼
   ┌──────────────────────────────────────────────────────────┐
   │                    Firegrid durable core                   │
   │             events · claims · outputs · traces             │
   └──────────────────────────────────────────────────────────┘
            │                                          ▲
            ▼   wake a session waiting on an event     │   publish a result —
                                                        │   itself a new event
                                                        │   others can wait on
   ┌──────────────────────────────────────────────────────────┐
   │                       agent sessions                       │
   │              each one:  wait  →  act  →  publish            │
   │                 (sessions never call each other)           │
   └──────────────────────────────────────────────────────────┘
```

Two directions of flow, one shared core:

- **Ingress (down):** webhooks, approvals, and tool results land as durable
  events in the core.
- **Read (down):** a session wakes when an event it is waiting on appears.
- **Write (up):** a session publishes a result — which is just another durable
  event the next session can wait on.

Notice what is *not* here: no session points at another session. They coordinate
only through the core, so the plan emerges from what they publish instead of
being wired up in advance.

---

## The agent surface

The model drives everything through a small set of durable tools. Each one
appends a durable record *before* it suspends, fans out, or acts — so a crash or
restart resumes exactly where it left off, never replaying a side effect.

```ts
wait_for(event, prompt?)    // suspend until an event matches; optional self-prompt on resume
wait_until(time, prompt?)   // suspend until a time (absolute, or "+2d"); optional self-prompt
sleep(duration)             // thin alias for wait_until("+duration")
spawn(agent, prompt)        // run a child agent; durably await its result
spawn_all(tasks)            // fan out child agents; durably await all
execute(target, input)      // run a tool/sandbox call, durably recorded
```

The `prompt?` on a wait is what makes it **proactive**: with no prompt the model
blocks and the result returns inline; with a prompt the session suspends durably
and wakes with that prompt as a *new turn*. So `wait_until("tomorrow 9am", "…")`
is a scheduled self-nudge and `wait_for("pr.merged", "…")` is an event-triggered
one — one family, two axes (`for` = event, `until` = time). The client-sdk
projects them as a chainable `firegrid.wait.for(...)` / `firegrid.wait.until(...)`.

These are coordination primitives, not a workflow DSL — no `graph.addNode()`, no
router, no central planner. The model calls them in whatever order the goal
needs; Firegrid supplies the durability, claims, projection, and recovery. (Not
every tool is wired end to end yet — the simulations below show what runs today.)

---

## Everything else is a combinator

Approval gates, middleware, dashboards, the ACP adapter — none of it is new
machinery. Each is one primitive plus one combinator over the durable log:

| Feature | = primitive + combinator |
| --- | --- |
| Approval gate | **suspend** a tool call + append a permission event; wake on resolution |
| Audit trace | **append** each effect and result to the session log |
| Budget / policy block | **filter** the effect; reject when it exceeds policy |
| Context injection | **mapEffect** to rewrite the prompt before it runs |
| Parallel tool calls | **fanout** the calls, merge the results |
| Child / peer dispatch | **substitute** the effect + durable wake events |
| Prompt-state view | **fold** (materialize) the session event log |

If a feature cannot be written as a primitive plus a combinator, that is a design
smell — it is a product object *above* the substrate, not a new piece of the core.

---

## Patterns

Each is one durable tool doing real work — the high-value behaviors fall out of
the surface, not a framework.

### Delegate and fan out
> Delegation is just `spawn` — the foreground agent runs child agents for heavy
> work and durably awaits them; `spawn_all` fans them out in parallel.

- **Right model for the job:** hand coding to a coder, research to a researcher.
- **Durable:** child work is claimed before launch and awaited from its record.
- **Parallel:** `spawn_all` resolves once every child reaches a terminal state.

```ts
const [findings, draft] = yield* spawn_all([
  { agent: "researcher", prompt: "Find recent OAuth issues touching ENG-123." },
  { agent: "writer",     prompt: "Draft release notes for the fix." },
])
```

### Proactive self-prompts
> Proactivity is just a wait with a prompt — `wait_until(time, prompt)` queues a
> future self-nudge; `wait_for(event, prompt)` wakes on the world changing. When
> it resolves, the session wakes with that prompt as a new turn. The "coworker
> that pings you" is one tool call.

- **Time-aware:** it acts when the moment arrives, not only when prompted.
- **Durable:** the suspended prompt survives restarts; the timer is crash-safe.
- **Gated:** it re-prompts only if the session is still live and allowed.

```ts
yield* wait_until("tomorrow 9am", "Check if the candidate replied; nudge if cold.")
yield* wait_for("github.pr.merged", "Run the release checklist for the merged PR.")
```

### Human-in-the-loop
> An approval is just a durable wait — the agent suspends, costs nothing while
> waiting, and resumes the moment you decide.

- **No idle process:** the wait does not pin a running process.
- **Survives restarts:** resumes when the approval arrives, even after a redeploy.
- **On the edge, not in the loop:** the human handles only the consequential call.

```ts
const decision = yield* wait_for("approval:send-reply", { timeoutMs: 86_400_000 })
if (decision.approved) yield* execute("email", { to: customer, body })
```

`wait_for` also wakes on external events — a webhook, a CI result, a Slack
message — once the matching ingress source is connected.

### Interrupt and regenerate
> Steering is just a durable cancel — a new instruction interrupts in-flight work,
> cleanup runs, the session continues fresh, with no races or lost state.

- **First-class signal:** cancel propagates through the session's work.
- **Clean teardown:** the agent releases its process before restarting.
- **Ordered:** the terminal signal is recorded before cleanup runs.

```ts
yield* session_cancel(s, { reason: "user changed direction" })
yield* session_prompt(s, "Drop that — handle the staging incident first.")
```

---

## It composes

The model chooses the order at runtime; every step is durable. A foreground agent
might fan out work, gate on a human, act, then schedule its own follow-up — no
authored graph, just tool calls:

```ts
const [findings] = yield* spawn_all([
  { agent: "researcher", prompt: "Investigate the api-p99 regression." },
])
const decision = yield* wait_for("approval:ship", { timeoutMs: 86_400_000 })
if (decision.approved) yield* execute("github", { action: "create_pr", issueId: "ENG-123" })
yield* wait_until("in 2 days", "Confirm the PR landed; nudge review if not.")
```

You can still drive a conforming substrate from Temporal, a cron, or a queue —
but Firegrid never *requires* a workflow engine for an agent to make progress.

---

## What a run looks like

Every wait, spawn, and timer is durable, so the trace *is* the schedule the model
chose — including the hours it spent suspended with no process alive.

**Waiting on an external event:**

```text
agent run · ops-agent                                4h 18m  ·  16 spans
├─ llm · plan next step                                 3.2s
├─ wait_for · github.pr.merged        ⏸ suspended      4h 11m   ← no process running
│   └─ woke · repo=app  pr=1242
├─ spawn · reviewer                                    38.4s
│   └─ llm · review the diff                           31.0s
└─ execute · slack.post "reviewed ✓"                    0.4s
```

**Scheduling itself, then following up:**

```text
agent run · recruiter-agent                         18h 02m  ·   9 spans
├─ wait_until · "tomorrow 9am"        ⏸ durable timer  17h 54m   ← wakes itself
│   └─ woke · self-prompt fires
├─ wait_for · candidate.replied  (timeout 4h)  timed out  4h 00m
└─ execute · slack.dm "still interested? following up"  0.3s
```

**Fan out, gate on a human, schedule the next check:**

```text
agent run · release-agent                            2h 06m  ·  23 spans
├─ spawn_all                                           44.1s
│   ├─ researcher                                      44.1s
│   └─ writer                                          22.7s
├─ wait_for · approval:ship           ⏸ suspended      2h 01m   ← waiting on a person
│   └─ woke · approved by @gurdas
├─ execute · github.create_pr #1242                     1.1s
└─ wait_until · "+2 days: confirm landed"            → next run
```

The `⏸ suspended` spans are the point: long wall-clock waits where nothing is
running, stitched into one trace across restarts.

---

## How it compares

| If you want... | Look at... |
| --- | --- |
| A graph of LLM steps authored up front | LangGraph, CrewAI, AutoGen-style orchestration |
| Durable workflows for service code | Temporal, Restate, Inngest |
| A durable coordination layer agents use through tools and channels | **Firegrid** |

Firegrid is closer to durable workflow infrastructure than to an agent SDK — but
the surface is built for agents to call: wait, spawn, schedule, execute, and
sleep, with the model choosing the order.

---

## Run it

```bash
pnpm install
```

See a full run end to end — a real agent spawned through the real codec and
sandbox, with a captured trace — via the local simulations (no credentials
needed for the default scenario):

```bash
pnpm --filter firelab simulate:list
pnpm --filter firelab simulate:run unified-kernel-validation
pnpm --filter firelab simulate:show   # inspect the captured trace
```

Run a host that binds to a durable-streams backend and stays alive for clients:

```bash
DURABLE_STREAMS_BASE_URL=... FIREGRID_RUNTIME_NAMESPACE=... pnpm firegrid host
```

The simulations in `packages/firelab` are the best way to inspect real
traces while the public client API is still settling.

---

## Repo layout

| Package | Purpose |
| --- | --- |
| `@firegrid/protocol` | Shared schemas and channel contracts |
| `@firegrid/runtime` | Durable runtime internals and workflow engine integration |
| `@firegrid/host-sdk` | Host composition and channel bindings |
| `@firegrid/client-sdk` | App/client surface over Firegrid sessions and channels |
| `firelab` | Local simulations and trace artifacts |

Most users start with the client/session surface. Contributors should read the
architecture docs before changing package boundaries.

---

## Development

This repository uses pnpm workspaces.

```bash
pnpm install
pnpm preflight      # full gate set: lint, typecheck, test, trace gates
```

Useful local scripts:

```bash
pnpm typecheck
pnpm test
pnpm lint
```

---

## Docs

- [Factory vision](docs/vision/factory-vision.md)
- [Canon docs](docs/cannon/README.md)
- [firelab guide](packages/firelab/README.md)
- [Client SDK README](packages/client-sdk/README.md)

---

## License

This project is not yet published as a stable public package. License and public
distribution terms will be clarified before a broader release.
