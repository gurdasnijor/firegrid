# Fluent Firegrid

Fluent Firegrid is the architecture for durable, observable, multi-agent
choreography across external agent harnesses.

The ambition is simple: a Claude ACP session, a Codex ACP session, a cloud
agent, a native Claude Code process, an Effect AI `LanguageModel` workflow, and a
future harness should all participate in the same durable coordination model.
Each harness keeps its native model loop. Firegrid supplies the durable tools,
session stream, wake handling, projection surface, and recovery contract around
that loop.

## System Overview

Every long-lived session is represented by a Durable Streams session log. The log
contains two kinds of facts:

- **Layer 1 observations**: what the harness did or said: text, tool calls,
  permission requests, file changes, status, turn completion.
- **Layer 2 coordination**: what Firegrid committed: waits, timers, child
  lifecycle, approvals, durable tool results, terminal records.

The raw agent process never writes to Durable Streams directly. Firegrid-owned
harness I/O roles observe protocol traffic and write through
`packages/fluent-runtime`.

```text
client / provider / peer input
  prompt · approval · webhook · timer · child result
      │
      ▼
packages/fluent-runtime
  session authority
  materialize stream · evaluate waits · commit L2 facts · ack wakes
      │
      ├───────────────────────────────┐
      │ append/read                    │ drive/resume
      ▼                                ▼
Durable Streams session log       Harness I/O role
  L1 observations + L2 facts        ACP client · ACP conductor
  consumer wake substrate           native/cloud adapter · LanguageModel edge
      ▲                                │
      │ read/project                   │ native protocol
      ▼                                ▼
projections / UI / Firelab         external harness
                                   owns model loop; no DS writes
```

The result is a single durable surface for humans, agents, workers, acceptance
tests, and future UIs. Reads are projections from the stream. Coordination is
written as stream facts. Wake delivery, cursors, leases, and claim/ack/release
come from Durable Streams.

## How It Works

The fluent architecture has four layers.

| Layer | Package or system | Owns |
|---|---|---|
| Authoring | `packages/fluent-firegrid` | `Operation`, `Future`, `gen`, `run`, `sleep`, combinators, descriptors, typed clients |
| Session authority | `packages/fluent-runtime` | Durable session facts, wait/timer/child/tool semantics, wake redrive, HTTP/MCP/control surfaces |
| Durable substrate | Durable Streams | Append/read/close/fork, producer fencing, named consumers, pull-wake, webhook wake |
| Harness I/O | ACP client/conductor, native adapters, LanguageModel edge | Protocol fidelity, Layer 1 recording, native resume, replay suppression |

The important rule is ownership:

```text
Durable Streams owns transport durability:
  stream storage · producer fencing · consumer cursor · lease · retry · wake

fluent-runtime owns product semantics:
  decode facts · evaluate CEL · record L2 outcome · drive/resume harness

harness I/O owns protocol fidelity:
  ACP/native/cloud protocol · resume artifact · side-effect suppression

raw harness owns the model loop:
  Claude · Codex · cloud agent · model provider
```

If a concern already exists in Durable Streams, fluent-runtime must not rebuild
it under a Firegrid name. If the current dependency does not expose the needed
Durable Streams primitive, the feature is blocked on substrate adoption; it is
not permission to create a parallel lease table, cursor store, retry loop, or
webhook wake system.

## Core Concepts

### Sessions

A session is the durable addressable unit of work. It is not a long-running
generator body and it is not the model loop. It is a stream of facts plus the
host logic that reacts to wakes.

```text
/support/ticket-42
  L1: user prompt, assistant text, tool call, file edit, turn complete
  L2: wait intent, wait matched, child spawned, tool result, terminal record
```

### Authored Procedures Below The Session Line

`@firegrid/fluent-firegrid` durable Effect authoring is a reusable primitive
below and alongside managed sessions. It owns named `run` replay, schema decode
at the journal boundary, retry and compensation inside ordinary Effect
composition, deterministic Clock/Random services, and local fiber
concurrency/cancellation.

Those semantics do not turn a managed agent session into a resident workflow
body. Managed sessions remain host-driven around an external harness model loop:
the harness emits protocol observations, fluent-runtime records Layer 1 and Layer
2 facts, and wakes re-enter through the relevant harness I/O role.

The spawn vocabulary follows the same split. `Effect.fork` and scoped fibers are
local authoring tools inside an authored procedure. Durable child/session spawn
is a fluent-runtime coordination fact that creates or addresses another session
stream and wakes on that session's terminal fact.

### Harnesses

A harness is any system that owns an agent loop: Claude ACP, Codex ACP, native
Claude Code, a cloud-hosted agent, an HTTP/stdio process, or an Effect AI
`LanguageModel` fronted workflow.

Harnesses keep their native behavior. Firegrid adapts them into the same stream
and tool contract.

### Harness I/O Roles

Firegrid has different roles at different protocol edges:

| Edge | Firegrid role | External role |
|---|---|---|
| Claude/Codex ACP subprocess | ACP client | ACP agent |
| Zed or editor-launched ACP session | ACP agent/conductor | ACP client |
| Future native Claude/Codex | Native protocol host | Native harness |
| Future cloud agent | Cloud API adapter | Cloud service |
| Effect AI model workflow | Model/tool facade | Model provider |

The detailed diagrams are in [`harness-io.md`](harness-io.md).

### Durable Tools

Harnesses participate by calling a small set of durable tools:

- `wait_for`: park until a matching state-change fact arrives.
- `sleep` / `schedule_me`: park until a durable timer or scheduled source fires.
- `spawn` / `spawn_all`: create child sessions and wake on child terminal facts.
- `execute`: run a committed external activity and record the result.
- session-plane reads/sends: observe, send, tag, fork, schedule.

Tool calls are observed in Layer 1. Firegrid commits their durable meaning in
Layer 2. The harness receives only the committed result, or the turn parks.

### Wakes

Anything can wake a session: user input, provider webhooks, approvals, state
changes, timers, child completion, or peer messages. Durable Streams owns the
wake transport and claim mechanics. Firegrid owns what happens after a wake is
claimed.

```text
Durable Streams grants wake claim
  -> fluent-runtime reads provided offsets
  -> materializes session facts
  -> evaluates CEL wait predicates
  -> appends L2 outcome
  -> drives/resumes harness I/O
  -> ack/done only after durable outcome is recorded
```

### Projections

Projections are read models over Layer 1 and Layer 2 facts. They power UIs,
debuggers, acceptance tests, audit views, and client APIs. Projection schemas do
not own coordination semantics; they are derived from the durable stream.

## What This Enables

Fluent is designed to support choreography, not a fixed workflow DAG. A session
can decide at runtime to wait for a webhook, spawn a different harness, run a
sandboxed activity, observe another session, and continue later after a wake.

Target-state example:

```text
client prompt
  -> Claude ACP session receives the prompt
  -> Claude calls wait_for("github.pr.merged && repo == self.repo")
  -> Firegrid records wait intent and parks the turn
  -> GitHub webhook arrives and becomes a queryable state-change fact
  -> Firegrid records wait_matched and redrives the session
  -> Claude spawns a Codex child session to verify the merge
  -> Codex calls execute("sandbox", "pnpm test")
  -> Firegrid records the child terminal fact
  -> parent wakes and continues
```

No authored DAG coordinates that sequence. The harness chooses the next tool
call; Firegrid makes every coordination step durable, observable, and
recoverable.

## What This Is Not

Fluent is intentionally not:

- a rebuild of `packages/runtime` with renamed folders;
- a runtime that owns the agent's reasoning loop;
- a second authoritative journal beside the session stream;
- a UI projection schema buried inside runtime coordination state;
- a fake harness/test recorder presented as product proof;
- an MCP host that hides durable semantics inside tool handlers.

Generators and `fluent-firegrid` operations still matter, but they are for
authored coordination workflows and reusable primitives. A managed agent session
is host-driven harness coordination around an external loop.

## Safety Rules

These are the invariants reviewers should keep in mind:

1. Raw harness processes do not write Durable Streams facts.
2. Parking tools record intent before the harness turn ends.
3. A wake has one Layer 2 decision-writer, fenced by the substrate claim.
4. Redrive serves recorded matches/results; it does not re-evaluate a moving
   world.
5. The host acks/dones a wake only after the durable result is appended.
6. Resume must not re-execute already-observed Layer 1 side effects.
7. External facts that wake a wait are queryable stream facts.
8. Durable waits, timers, and promises do not use a second authoritative journal.

## Current Build Priorities

The architecture becomes real only when these are proven with product-observable
tests:

1. Adopt the Durable Streams consumer substrate path.
2. Prove post-claim redrive: claim -> materialize -> append L2 -> ack.
3. Implement DS-native `wait_for` with CEL predicates and recorded matches.
4. Implement DS-native durable sleep/scheduled wake.
5. Stand up the thin control-plane host.
6. Bind real ACP/native harnesses and prove no duplicate side effects on resume.
7. Expose Firegrid durable tools through a thin Effect `Tool` / `Toolkit` /
   `McpServer` edge.
8. Prove cross-harness spawn: parent harness A spawns child harness B and wakes
   on child terminal state.

## Read Next

- [`../fluent-architecture.md`](../fluent-architecture.md): canonical ownership
  tables, substrate mapping, invariants, implementation gaps, and runtime
  differences.
- [`harness-io.md`](harness-io.md): detailed ACP client/conductor/native/cloud
  I/O diagrams and read/write responsibilities.
- [`../../../sdds/fluent-firegrid-sdd.md`](../../../sdds/fluent-firegrid-sdd.md):
  execution-focused design details.
- [`../../../sdds/SDD_FLUENT_HARNESS_ADAPTER_CONTRACT.md`](../../../sdds/SDD_FLUENT_HARNESS_ADAPTER_CONTRACT.md):
  ACP adapter/conductor acceptance contract.
