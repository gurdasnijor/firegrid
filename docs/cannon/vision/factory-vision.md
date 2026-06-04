# firelab Strategy: The Software Factory as North Star

## §1 — What we're building toward

A software factory is a process that converts an intent — "fix this bug,"
"add this feature," "investigate this issue" — into a reviewed, merged
change. The intent enters from somewhere (a ticket, a chat message, a
webhook). The change exits as a pull request that meets some bar (tests
pass, reviewers approve, CI is green). Between those two endpoints, work
happens: someone reads the ticket, decides what to do, writes code, gets
feedback, revises, ships.

The work in the middle isn't a fixed sequence. Some tickets need a quick
patch and a single reviewer; others need investigation, a design
discussion, multiple rounds of review, and a careful staged rollout. The
decision about *what to do next* — at every step — is judgment, not a
recipe. It depends on what the ticket actually says, what the codebase
looks like, what came back from the last review, whether CI passed,
whether a human said "wait, not yet."

This is true whether the work is done by humans, by agents, or by a team
mixing both. A senior engineer triaging a ticket doesn't follow a
flowchart; they read the situation and decide. A reviewer doesn't run a
script; they look at the diff and respond. The factory's job is to make
that judgment-driven work *durable* — survivable across interruptions,
observable across time, resumable across days — without taking the
judgment away from whoever (or whatever) is doing the work.

## §2 — Choreography, not orchestration

The wrong way to build a software factory is to write down the workflow.
To say: *first triage runs, then implementation, then a council of three
reviewers, then a QA pass, then deploy*. To encode that sequence in
TypeScript as a state machine, dispatch each phase as a step, wire up
timeouts and retries, and ship it.

That approach fails for two reasons. The smaller reason is that real
factories don't have a fixed shape — sometimes you skip review for a
typo fix, sometimes you need three rounds of revision, sometimes the
right next step is "ask the person who filed the ticket what they
actually meant." A coded workflow either can't express that variability
or accumulates branches until it becomes unreadable.

The larger reason is that encoding the workflow in code locks the work
into the workflow author's imagination. If the workflow says "after
implementation, run three reviewers," then three reviewers run — even
when the change is trivial, even when one reviewer would catch
everything, even when no reviewer is needed because the change is
mechanical. The workflow becomes a ceiling on the work. Better judgment
can't rise above it without re-editing the workflow.

The right way is the opposite: *don't write the workflow*. Give whoever
is doing the work — the planner, the implementer, the reviewer — a
small set of durable primitives, and let them decide what to do next
based on what they actually see.

The primitives are simple:

- **Wait for something to happen.** A human decision, a CI result, a
  webhook arrival, another participant's output. Pause durably until the
  thing arrives.
- **Delegate work to someone else.** Spin up a new participant — another
  agent, another session, another team member — with a clear scope.
  Wait for their result, or check in on them later.
- **Schedule yourself for later.** Come back in an hour, or tomorrow, or
  when a specific condition is met.
- **Take an action in the world.** Open a PR, post a comment, run a
  command, call a tool. Record the result durably.
- **Read your own history.** What have I already tried? What did the
  reviewer say last time? What was the last error? Decide based on what
  actually happened, not on what was specified.

With those primitives, the workflow doesn't need to be written down. The
planner — human, agent, whoever — looks at the ticket, looks at the
prior history, looks at the current state of the codebase, and decides.
They might delegate implementation immediately. They might ask a
clarifying question first. They might investigate the codebase
themselves before deciding anyone else needs to be involved. They
choose, and the choice is durable because the primitives are durable.

This is choreography. Each participant has a small set of moves; the
shape of the dance emerges from how they use those moves in response to
what they see. Nobody choreographed it in advance.

## §3 — What this requires of the substrate

Choreography only works if three properties hold.

**The primitives have to be real.** "Wait for something" has to actually
pause the participant durably — survive host restarts, survive a day of
no activity, survive a thousand other participants doing the same thing.
"Delegate work" has to actually create a durable identity for the
delegate that can be tracked, resumed, and observed. These aren't
conveniences; they're load-bearing. If "wait" is just `setTimeout`, the
factory falls over the first time the process restarts. If "delegate" is
just spawning a function, the factory loses track of in-flight work the
moment something interrupts it.

**The history has to be observable.** A participant deciding what to do
next needs to see what has already happened — not a summary, the actual
events. Every wait that resolved, every delegation that completed, every
action that succeeded or failed, every decision that was made. The
history isn't logging; it's the input to the next decision. Without it,
the participant is choosing in the dark.

**The decisions have to be legible from the outside.** When the factory
does something — delegates, waits, takes an action — a human watching
needs to see *what* it's doing and *why* it's the right move given what
came before. Not because the human needs to approve every step, but
because the human is one of the participants. They might be the one
deciding what to do next on a hard call. They might be the one who
notices something has gone wrong. They might be the one who realizes the
participant chose poorly and intervenes. Choreography without
observability is just chaos.

## §4 — What Firegrid is

Firegrid is the substrate that makes those three properties hold.

Durable primitives, exposed as tools an agent can call (and, in the same
shape, a human can call through a thin wrapper):

- `wait_for` — pause durably until a matching fact appears
- `session_new`, `session_prompt` — create and continue durable
  conversational identities for delegated participants
- `schedule_me` — durably schedule a future self-prompt
- `execute` — invoke a bounded, advertised capability and record the
  result
- `sleep` — pause for a duration

Durable history, in the form of an event stream that materializes into
queryable rows. Every wait, every delegation, every tool call, every
decision is a row. Participants can read their own history through the
same query interface that operators use to inspect what the factory is
doing.

Live observation, because the event stream materializes into reactive
collections. Operators see the factory's state in real time. So can the
participants themselves — an agent can check what it's already tried
before deciding what to try next.

Crucially, Firegrid does *not* ship a factory workflow. There is no
`createFactory()` API, no `factoryWorkflow.step('implement')` builder,
no YAML DAG. Firegrid ships the primitives and the substrate; the
workflow shape is whatever the participants decide moment-to-moment
based on what they see.

## §5 — What "factory-ready" means

The factory is the production proof that this shape works. When a
factory — ticket in, reviewed PR out, choreographed by a planner that
uses Firegrid tools — runs end-to-end through Firegrid's public surface
without reaching into private internals, the substrate has earned its
claim.

"Without reaching into private internals" is the criterion that matters
and the one that requires precision. A real factory app will import
from several Firegrid packages: client SDK, protocol schemas,
durable-table operators. That is expected and normal. A *reach-past* is
the opposite — pulling in a piece of runtime composition, an internal
projection helper, or a low-level table type that should have been
wrapped behind a consumer-facing accessor but wasn't. Reach-pasts are
findings, not failures: each one names a place the substrate isn't yet
expressible from the outside, and each one retires when the substrate
grows the accessor that removes the need. Some apparent reach-pasts are
intended public surface that just hasn't been documented as such; the
toy's discipline is what adjudicates the difference.

That's the criterion `firelab` is converging toward. The toy's
configurations exist to validate, one capability at a time, that the
surface the factory needs is real and expressible. When a configuration
that wires the factory's minimal slice — a trigger, a parent context, a
planner with the choreography tools, a permission gate, a delegated
child, a durable observation surface — passes through the public client
SDK without reach-pasts, the platform is factory-ready.

The factory itself is one application of this substrate. There will be
others. A research factory, an analyst factory, a customer-support
factory — anywhere durable judgment-driven work happens, the same
primitives apply. The dark factory is the first production proof.
Tiny-firegrid is the proving ground.

## §6 — The factory in concrete shape

It helps to make this less abstract. Here is what actually happens when
the factory runs — told as the planner's decisions in response to what
it sees, not as a sequence of phases.

A ticket arrives. The planner reads it. Sometimes the description is
enough; sometimes the planner needs to look at the repository, or ask
the filer a clarifying question, or wait for a teammate to clarify a
design point. The planner decides which. If a clarifying question is
needed, the planner asks and waits durably for the answer. The wait
might resolve in seconds or in days; the planner doesn't care, because
the substrate holds the state.

When the ticket is actionable, the planner produces a plan — an outline
of what the change would look like. The plan goes back to a human for
approval. Maybe the human approves it; maybe they push back; maybe they
want it changed. The planner waits durably for the response. On
revision, the planner produces a new plan and waits again. On rejection,
the planner closes the run cleanly. On approval, the planner moves
forward.

The planner delegates the implementation. A separate durable participant
— a child session, with the plan and the relevant context as its prompt
— takes over the actual work. The planner doesn't write the code; it
spawned someone to do that, and waits durably for them to come back with
a PR. The implementer is itself running on the same substrate, with the
same primitives, so it can wait for clarifications, run commands, read
files, and report progress in exactly the same way.

When the PR exists, review happens. The planner decides what kind of
review the change needs. A typo fix gets one reviewer. An architectural
change gets three reviewers with different perspectives — maybe even
with different model backends, to maximize coverage. The planner spawns
the reviewers and waits for verdicts. If a reviewer wants changes, the
planner sends the feedback to the implementer (using the same primitives
it used to spawn them) and waits for a revision. If reviewers approve,
the planner asks the human for final merge sign-off.

On merge approval, the planner watches CI durably until it's green, then
merges. If CI fails, the planner sends the failure to the implementer
and waits for a fix. If the run was rejected at any gate, the planner
unwinds cleanly — abandoning child work, recording the outcome, leaving
the durable history intact for inspection.

At no point is any of this in a workflow file. Each decision — *what
next, given what I've seen* — is the planner's. The factory is the
consequence of the planner's choices made against durable primitives,
not the consequence of a state machine.

The shape this produces is observable, durable, and adaptive. It's
observable because every decision and every wait writes to the history.
It's durable because every wait survives interruptions. It's adaptive
because the planner can choose differently tomorrow — for a different
ticket, for a different reviewer pool, for a different organizational
policy — without anyone re-editing a workflow.

This shape is what the dark factory implements concretely against
Linear, GitHub, and Slack. The pattern is substrate-agnostic — replace
Linear with a different ticket system, replace GitHub with a different
code host, and the planner's decisions and primitives are unchanged.
That's the test of choreography: the same shape works across
substitutions, because the shape lives in the planner, not in the code
around it.

## §6.5 — What we already know works

The strategy in the preceding sections isn't entirely aspirational. The
substrate is partly built and the application of it is partly working.
Two artifacts inside this repository ground the document in evidence
rather than intent.

**`packages/runtime/src/verified-webhook-ingest`** is a runtime-owned
adapter that turns an already-routed external webhook request into a
durable verified fact. Its README is explicit about the boundary it
draws: the product owns the HTTP route, the secret lookup, the response
status mapping, and the provider-specific quirks. Firegrid owns the
durable fact table, the HMAC verification, the deterministic
`[source, externalEventKey]` keying, the idempotent insert-or-get, and
the conflict rejection when the same key arrives with a different
payload hash. The durable boundary starts at the fact row, not at the
HTTP edge. This is the first capability in §7 — external events as
durable verified facts — expressed as working code today.

**`apps/factory`** is an in-flight implementation of the dark factory
app. Several of the capabilities §7 enumerates are exercised in it
through public-shaped boundaries: it composes its own `DarkFactoryTable`
with `facts` and `runs` collections using the same `DurableTable`
primitive the runtime itself uses; it maps an external trigger to a
single durable planner participant through
`firegrid.sessions.createOrLoad` keyed by external source and entity;
it waits on its own app-owned fact collection through Effect `Stream`
operations over `table.facts.rows()`; and it observes runtime state
through `session.snapshot()` and `session.wait.forPermissionRequest`.
The factory app is a real consumer of the substrate, not a test fixture.
When it works cleanly, that is evidence the public surface expresses
the capability. When it has to import lower-level pieces to get
something done, that is a candidate finding — a question the toy's
discipline can adjudicate.

The factory app's own README is candid about places it currently
composes layers directly rather than going through the intended public
entrypoint, and names a follow-up to route more of the smoke through a
single composition surface. That kind of self-aware reach-past is
exactly what the toy's discipline is meant to surface systematically:
some such imports are gaps; some are intended public surface that
simply isn't documented as such; only investigation can tell which is
which.

The relationship between these artifacts and `firelab` is
complementary. The factory app validates *practicability* — can a real
consumer build the factory today, and where does it have to reach below
the public surface to do so. The toy validates *expressibility* — can
each capability be wired through the public surface in isolation,
without any factory-specific scaffolding. Both produce findings. The
toy is the systematic version; the factory app is the production target
the toy is converging toward.

## §7 — What the substrate needs to make this work

The factory described in §6 needs the substrate to do seven specific
things. These are the capabilities the rest of this document refers to.

1. **Accept external events as durable, verified facts.** When an
   external system — a ticket system, a code host, a webhook source —
   emits an event, the substrate turns the event into a durable fact at
   a clean boundary. The substrate owns the verification, the
   deterministic keying, the idempotent insert, and conflict rejection
   when the same key arrives with a different payload. It does not own
   the HTTP route, the secret rotation, or the provider taxonomy —
   those stay with the product. The fact is what everything downstream
   waits on, references, and resumes against.

2. **Hold a participant's identity durably across time.** When the
   planner pauses to wait for human approval, the planner doesn't die —
   it becomes a row in a table that can be resumed when the trigger
   arrives. Same for every implementer, reviewer, and child participant.
   The identity is the unit of durability.

3. **Map one external intent to one participant.** When the same ticket
   arrives twice — redelivery, retry, an operator manually replaying —
   there's still one planner working on it. The substrate has to make
   "find or create the participant for this intent" a single,
   idempotent operation.

4. **Let participants delegate to other participants.** The planner
   spawning an implementer or a reviewer is the core choreography move.
   The substrate has to make new participants creatable with parent
   correlation, with a clear handoff prompt, observable from the
   outside, resumable from the inside.

5. **Let participants wait for things.** Not just other participants —
   also human decisions, external system events, time-based triggers.
   The wait has to match against durable facts that arrive from
   anywhere. The participant resumes when a fact matches; until then, it
   consumes no compute.

6. **Let participants take actions in the world and remember what they
   did.** Posting a PR comment, calling a deploy script, sending a Slack
   message — these have to be invokable through the substrate in a way
   that records evidence durably. The next decision the participant
   makes might depend on whether the action succeeded.

7. **Let everyone see what's happening.** Operators inspecting the
   factory, agents introspecting their own history, dashboards
   aggregating health metrics — all read the same event stream. There
   is no "internal log" separate from the durable substrate; the
   substrate is the log.

These are the seven capabilities. The rest of this document is about how
Firegrid exposes them and how `firelab` proves they're really
exposed.

## §8 — How firelab converges

`firelab` is a small package inside the Firegrid monorepo whose
only job is to prove the capabilities in §7 are real and accessible
through Firegrid's public surface. It does this by writing
configurations — small TypeScript files that wire a specific capability
through public boundaries and assert externally visible behavior.

The shape of a configuration is: take a real production Firegrid host,
drive it through the public client SDK as a real consumer would, and
check that the resulting behavior matches what the factory needs. A
configuration is *buildable* when the public surface can express the
capability cleanly. A configuration is *failing* when expressing the
capability requires reaching past the public surface into private
internals — that failure is information, recorded as a finding, and
points to where the substrate is incomplete.

The toy is therefore an executable specification of the substrate's
surface. When every capability in §7 has at least one configuration
that exercises it through public APIs without reach-pasts, the
substrate is provably factory-ready. The toy retires at that point; its
job is done.

This is not a test suite. The toy isn't validating Firegrid's
correctness — Firegrid has its own tests for that. The toy is validating
Firegrid's *expressibility*. The question it answers is "can a real
consumer build the factory using only the public surface," not "does
the substrate work internally."

The toy's investigation runs in parallel with the factory app's. Both
surface findings; both point at the same target. The toy's findings
tend to be capability-shaped and architecturally clean — "this primitive
can't be expressed this way through the public surface." The factory
app's findings tend to be ergonomic and integration-shaped — "this
capability is expressible but the consumer has to write more glue than
they should, or has to reach below the intended surface to wire it up."
Both kinds matter. Both feed the same `FINDINGS.md`.

## §9 — The operational hook

The toy's findings and configurations are tracked in two operational
documents alongside this one: `FINDINGS.md` (the authoritative ledger
of every gap or capability claim) and `CONFIGS.md` (the index of
configurations, their status, and what they prove).

Each entry in those documents carries a factory-relevance tag:
**gates** (the factory cannot be expressed until this is resolved),
**supports** (the factory benefits but isn't blocked), or **off-path**
(valid platform work, but not on the factory critical path). The tag is
assigned during triage and updated as evidence accrues. It is the
operational signal that connects per-finding work to the North Star.

That signal is the only operational obligation this document creates.
Everything else — dispatch order, framing reviews, signoff bundles —
lives in the existing protocols and is not re-specified here.

## §10 — References

For the architectural contracts the factory and the toy depend on:

- `docs/sdds/_archive/SDD_FIREGRID_DARK_FACTORY_APP.md` — the factory's product
  contract
- `docs/sdds/_archive/SDD_FIREGRID_FACTORY_ALIGNED_AGENT_TOOL_WORKSTREAM.md` —
  the tool surface the factory needs
- `vault/canon/concepts/choreography-vs-orchestration.md` — the
  philosophical grounding

For the artifacts grounding §6.5:

- `packages/runtime/src/verified-webhook-ingest/` — runtime-owned
  webhook fact ingest adapter (see its `README.md` for the
  product-vs-substrate boundary)
- `apps/factory/` — in-flight dark factory app (see its `README.md` and
  the hosted-smoke runbook it references)

For operational state:

- `packages/firelab/FINDINGS.md` — the findings ledger
- `packages/firelab/CONFIGS.md` — the configurations index

For current operational state — active threads, in-flight findings,
configuration progress — see `FINDINGS.md` and `CONFIGS.md`. This
document is the strategic frame; those are the operational ledgers.

---

## §A — Where we are right now

*Snapshot as of 2026-05-18. For current state, see `FINDINGS.md` and
`CONFIGS.md`.*

**Substrate prerequisites.** #332 client/host boundary is merged. #326
type-precision keystone is in flight; its co-gates (TFIND-044 Option B,
TFIND-045 enumeration) are merged. On #326 flip, the cascade unblocks
TFIND-007-step2 and TFIND-029 / #328.

**Capability evidence — substrate side.** Parent context identity
substrate is ready (TFIND-010, TFIND-011 buildable; multi-context
configuration in flight to confirm). Tool execution path is realized
via #343. Permission cycle is framing-active (TFIND-015 ready;
TFIND-048 drafting). Observation projection substrate is ready
post-keystone (TFIND-044 resolved; TFIND-046, TFIND-047 are ergonomic
gaps, not blockers). Adapter-driven launch is production-deferred
(TFIND-049 / Slice 4) and off the factory critical path.

**Capability evidence — real consumer side.** `apps/factory` exercises
several capabilities cleanly through public-shaped boundaries: external
trigger to durable run identity through `firegrid.sessions.createOrLoad`
keyed by external source and entity; app-owned durable facts and runs
through the public `DurableTable` primitive; waiting on app-owned facts
through Effect `Stream` operations over `table.facts.rows()`; runtime
observation through `session.snapshot()` and
`session.wait.forPermissionRequest`. The factory app's `host.ts` also
imports several runtime/protocol/host-sdk helpers — host composition
helpers, a permission-observation projection helper, a runtime ingress
append helper — and the app's README is candid that the hosted smoke
currently composes layers directly rather than routing through a single
public entrypoint. Each of those imports is a candidate finding: some
will turn out to be reach-pasts the substrate should close with a
consumer-facing accessor, and some will turn out to be intended public
surface that just hasn't been documented as such. The toy's discipline
is what tells the difference.

**Active threads.** #326 keystone rebase/flip. TFIND-048 framing draft.
Permission-flow framing complete and bundle-ready. Multi-context
substrate validation in flight.

**Distance to factory-ready.** Substrate prerequisites + two framing
signoffs + configurations covering the seven capabilities + a capstone
integration configuration validating the minimal slice. The factory
app's existing implementation is partial evidence the slice is close;
the toy's job is to convert "close" into "expressible without
reach-pasts."