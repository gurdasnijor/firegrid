# fluent-firegrid: Effect redesign + durability gaps — design handoff

A synthesis of the review covering the original two asks — the Effect-TS API
redesign and the team's durability issues table — plus the execution-model
decision that reframes both: fluent-firegrid runs agents **choreography-first,
handler-shaped, over the agent's own harness**. The reader is assumed to have the
`fluent-firegrid` source and the restate-sdk-gen source it was ported from.

Read the canon docs first:

- `docs/cannon/architecture/fluent/README.md` for the doc-set index and the
  two-model / one-core framing.
- `docs/cannon/architecture/fluent/execution-models.md` for the replay vs
  reconstruction contract.
- `docs/cannon/architecture/fluent/substrate-protocol.md` for the Durable
  Streams wire sequences.
- `docs/cannon/architecture/fluent/architecture.md` for package, process,
  stream, schema, invariant, and gap ownership.

This SDD is the execution-detail companion. It keeps the implementation sketches,
review rationale, and historical appendices. Where this document repeats system
shape or Durable Streams wire mechanics, the canon docs above are authoritative.

---

## TL;DR — four takeaways

1. **Execution model: choreography + handler + external-harness.** A session is a
   handler re-invoked per wake; it does *not* run the agent's reasoning loop. The
   agent keeps its own harness (Claude Code, codex, any ACP/MCP-capable loop) and
   reaches Firegrid as durable tools — "not the manager of your agents; the
   durable layer they coordinate through" (README). See *Execution model* below.

2. **The agent runtime is handler-only; the continuation + named-key *apparatus*
   is below the choreography line** (authored procedures: sagas, multi-step
   rollback, code-issued concurrent steps). The agent path needs only the
   deterministic *given-key principle* — key by the model's tool-call id /
   `(toolCallId, slotIndex)`, never a Firegrid-side counter (Appendix D.2). The
   full soundness apparatus (Appendix A) is reserved for below-line procedures.

3. **The non-invasive binding is two swappable halves.** A per-harness
   *normalizer (codec)* maps the agent's native event protocol → a common
   `NormalizedEvent` stream *in* (reference implementation:
   `durable-streams/coding-agents`); MCP-over-durable-streams exposes Firegrid's
   durable tools *out*. The property — Firegrid never wraps the loop — is the
   differentiator; both mechanisms are swappable.

4. **Durable Streams §7.2/§7.3 pull-wake *is* your wake/lease/fencing
   subsystem.** The only genuinely net-new infrastructure is a *scheduled-append
   timer source*, realized as the *wake-registry* — the single mechanism behind
   every wake source (timer, webhook/event match, child result, observed change).
   Everything else event-driven (work, cancel, webhook ingest, children) rides
   the subscription machinery you already have.

### Scope After Canon Realignment

The architecture now has two execution models over one coordination core:

- **Authored procedures** resume by replay: the Effect body re-runs and keyed
  journal hits carry it past already-recorded steps.
- **Managed sessions** resume by reconstruction: the host rebuilds native
  harness state and suppresses already-observed Layer 1 side effects.

This SDD's Effect-specific code sketches apply to the authored-procedure arm and
to the shared host loop. They are not permission to model a managed agent session
as a long-lived replayable workflow body. A durable tool implemented as an
authored procedure composes with a managed session as a child invocation on its
own stream; the session stream records only the Layer 1 tool call and Layer 2
child/tool result.

---

## System shape

```
wake source
  input append · child result · state change · timer · webhook · approval
      │
      ▼
fluent host: handleSession(wake)
  read Durable Streams session log
  materialise state, waits, terminal facts
  reconstruct native resume artifact through adapter
      │
      ▼
adapter / bridge ── native protocol ── external agent harness
      │                                  Claude Code / Codex / ACP
      │ append L1 harness events         owns the model loop
      ▼
Durable Streams session log
  L1 harness events: text, reasoning, tool_call, tool_result, file_change
  L2 coordination: input, run, wait, timer, child, approval, terminal
      ▲
      │ append L2
fluent host durable tools / ingress / timer workers / child workers
```

**Reading the diagram.** Package, process, stream, and schema ownership are
canonicalized in `docs/cannon/architecture/fluent/architecture.md`. This SDD
uses the compact execution view above: a wake re-enters the fluent host, the host
materializes the durable log, and the adapter drives the external harness without
making Firegrid own the model loop.

- **`handleSession(wake)`** is re-invoked per wake. It does *not* run the model
  loop — it materialises the committed stream, builds a resume context, and
  re-invokes the agent's *own* harness (`driveHarness`, never `agent.run`).
- The agent's loop is captured onto the stream as **Layer 1** — first-class
  `NormalizedEvent`s produced by a **per-harness codec/normalizer** that maps the
  harness's native protocol. **Layer 2** is the coordination events Firegrid
  authoritatively owns for replay, at-most-once, and forge-proofing.
- Firegrid's durable tools (`wait_for`/`spawn`/`execute`) are the agent's own tool
  calls, served over MCP; when one must wait it records intent and **ends the
  turn**, and the matching wake re-invokes `handleSession`.
- **External producers** are any actors outside the parked harness turn that append
  candidate wake facts: webhook ingress, approval UIs, tool callbacks, child
  completions, timers, or peer sessions. They append through the same fenced
  writer path as every other durable event.

Contrast with an *owned-loop* runtime (Electric `agents-runtime`): there the
runtime calls `agent.run` and the LLM loop is a subscriber to the runtime's
stream. Here the harness keeps the loop and the codec observes it — same
substrate, opposite loop-ownership. Scale-to-zero is shared: a parked session
holds no compute until a wake re-claims it.

---

## Execution model

### The three axes

Three independent axes describe a durable agent runtime. fluent-firegrid's
position on each:

| axis | the question | fluent-firegrid | the other end |
|---|---|---|---|
| **topology** | who owns the plan | **choreography** — the model decides; the plan emerges from what sessions publish | orchestration (authored DAG / step chain) |
| **coordination unit** | how the reacting unit resumes | **handler** — re-invoked per wake, state materialised from its stream | continuation (straight-line, replayed from a journal) |
| **loop ownership** | who drives the reasoning loop | **external-harness** — the agent keeps its own loop (Claude Code, codex, any ACP/MCP-capable harness) and reaches Firegrid as durable tools | owned-loop (the runtime calls `agent.run`; the LLM loop subscribes to the runtime's stream) |

The README fixes the third axis: "not the manager of your agents; the durable
layer they coordinate through." The surface is `wait_for`/`spawn`/`execute`
tools, not a wrapped runtime.

### Why the three line up: you cannot replay the model

An agent's control flow *is* the model's runtime choices — nondeterministic,
never re-invoked on replay. Two consequences:

- The only durable thing is the *outcome* of each choice; resuming reads outcomes
  back rather than re-deriving them — a handler, not a replayed continuation.
- Owning the reasoning loop buys nothing durable, since replaying it would mean
  re-issuing the model, which you must not — so the harness keeps the loop.

Firegrid owns the durable coordination *around* the loop — the tool calls the
model makes, their results, the waits, the children — not the loop. The durable
unit is the **committed tool-call-and-result**: resume hands the committed
session history + a resume prompt to a fresh harness invocation; the only
non-durable window is an in-flight tool call (executed, result not yet
committed), closed by an activity-claim (at-most-once).

### Keys: a given-key principle on the agent path, the soundness apparatus below the line

Every journaled step is keyed by a *given* identity, never a Firegrid-side
positional counter. On the agent path the keys are always given: a parallel tool
call by its turn-scoped `toolCallId`; `spawn_all`'s children by
`(toolCallId, slotIndex)` from the ordered input. Deterministic by construction —
this is Appendix D.2 extended to fan-out slots, and it is foundational/agent-path.

The harder argument — that *code-issued* positional keys survive
`Effect.all(concurrency: "unbounded")` — only arises when code, not the model,
issues concurrent journaled steps without natural ids: authored procedures, below
the choreography line. That apparatus (Appendix A) is not on the agent path.

### Races resolve to a child-lifecycle policy

A child-race (spawn several, take the first) leaves the losers as independent
child entities still doing real work; the policy is **cancel the losing child**
(save tokens) or **leave it running** and absorb its wake. A
`wait_for(…, { timeoutMs })` timer-loser is moot — a late timer is an absorbed
scheduled append. `raceCoverage` (Appendix C) gates the child-cancellation policy.

### Three differentiators

The substrate and the projection spine are shared with other Durable-Streams
runtimes; three things are fluent-firegrid's:

1. **Non-invasive binding — the agent keeps its own loop.** Two swappable
   mechanisms implement it: a per-harness **normalizer** captures the agent's
   native event stream *in*, and **MCP-over-durable-streams** exposes Firegrid's
   durable tools *out*. The normalizer half has a reference implementation —
   `durable-streams/coding-agents` (`normalize/{codex,claude}.ts`). Electric ships
   *both* shapes — an owned-loop runtime (`agents-runtime`) and this non-invasive
   normalizer package — so the choice is corroborated, not contrarian.
2. **Forge-proof verification (firelab).** A CEL coverage oracle computes a
   verdict over host-substrate spans — proof the production path ran, not just a
   trace.
3. **Deterministic-replay rigor** — the given-key principle, the child-race
   policy, Schema-typed errors.

### Reading the rest of this doc under this model

Parts 1–3 and Appendices A–D predate this execution-model framing and remain the
deep technical material; here is how each re-homes:

- **Part 1 / Appendix A (named keys)** split into the *principle* (deterministic
  given-keys — agent-path, Appendix D.2) and the *apparatus* (the
  concurrent-replay soundness proof — below-line, for authored procedures). Part
  1's DSL-collapse-onto-Effect is the mechanism for the durable tools and for
  below-line procedures.
- **Part 2 (three families)** stands; durable park/wake is realised as the
  handler + the wake-registry + the tool-level park.
- **Part 3 (Durable Streams §7.2/§7.3/§5.2.1 + timer source)** stands and is
  central; the timer source is the wake-registry.
- **Appendix C (coverage specs)** re-homes: coordination gates (`durableWait`,
  `crossSession`, `substrateSemantics`, `durableSleep`, `workerLoop`) are
  agent-path/shared; the full replay apparatus and in-process fiber-race are
  below-line; `raceCoverage` facet b is child-cancellation. The Layer-1 normalized
  events are the codec's, not gated as substrate spans.
- **Appendix D (agent surface)** is delivered by the codec (Layer 1) + the durable
  tools the harness calls; D.2's "named-key dividend" *is* the given-key principle.
- **Appendix E** is the handler (rewritten below); the earlier "live session is a
  workflow" coroutine shape is superseded.

---

## Background

`fluent-firegrid` is meant to be a Durable-Streams-backed reimplementation of
restate-sdk-gen with an Effect-based API — eventually the substrate the current
runtime sits on. The current code ports restate-sdk-gen's runtime almost line
for line: a generator-driving `Scheduler`, a ready-queue main loop, an
`Awaitable` abstraction, an `operationTag`/`Leaf` primitive layer, and a
module-global current-fiber slot (`current.ts`).

The governing observation: restate-sdk-gen built all of that **because they had
no effect system**. fluent-firegrid does. Most of that layer is a
reimplementation of machinery Effect already provides.

---

## Part 1 — Collapse the DSL onto Effect

> **Scope under the execution model.** Named journal keys split into the
> *given-key principle* (key by the model's tool-call id / slot — agent-path,
> Appendix D.2) and the *concurrent-replay apparatus* (the soundness argument
> below — reserved for *below-line authored procedures*). The DSL-collapse here is
> the mechanism for the durable tools the harness calls and for those below-line
> procedures; it is not a wrapper around the agent's loop.

### The core observation

- `Scheduler.drive` is a generator-driver running *inside* `Effect.gen` (itself
  a generator-driver) — two stepping loops where one suffices.
- `Future.effect` already **is** an `Effect`. The whole
  `makePrimitive` / `operationTag` / `Leaf` indirection exists only to bridge a
  non-Effect generator back to Effects.
- `current.ts` (the module-global slot + "called outside an active fiber"
  failure mode) reimplements fiber-scoped context, which Effect provides
  natively via the requirements channel.

There is exactly **one** load-bearing thing in that layer that isn't
just-use-Effect, and it is the hinge for the whole redesign.

### The pivotal decision: named vs positional journal keys

Everything follows from this one choice.

Today `run` derives `stepKey = ${nextStepIndex}:${name}`, and `nextStepIndex` is
incremented **synchronously at `Future` construction** inside
`DurableOperationProducers`. That synchronous mutation at construction time is
the *entire reason* `Future` must be eager — eagerness is what carries
deterministic, source-ordered step identity across replay.

Pure Effects are lazy; nothing runs at the call site. So a plain `Effect`
**cannot** grab an ordered key at construction without an impure runtime
counter — and a runtime counter read inside
`Effect.all(..., { concurrency: "unbounded" })` is consulted in *scheduling*
order, not *source* order, which is nondeterministic across replay. That's the
trap, and it's why you can't naively "just return an Effect" while keeping
positional keys.

The dichotomy is therefore clean:

| Choice | Consequence |
|---|---|
| **Positional keys** | Must keep an eager impure handle (`Future` stays, scheduler mostly stays). Automatic naming, but fragile to reordering, and you keep the entire bespoke DSL. |
| **Named keys** | `run` returns a plain `Effect`; `Future`, `Scheduler.drive`, `Awaitable`, `operation.ts` primitives, and `current.ts` all **delete**. Concurrency and spawn become free. Cost: the caller supplies unique, replay-stable names. |

### Recommendation: named keys

- The existing guide already nudges this way ("make sure the names are unique,"
  "don't put non-determinism in journal entry names").
- Positional keys break **silently** under refactor (insert a step, every
  downstream key shifts, replay diverges with no signal). Named keys break only
  under a **visible rename**.
- For a substrate the runtime sits on, name-addressed journal entries are far
  more debuggable than a hidden `nextStepIndex`.

This is the one change that lets the API collapse into Effect.

### Resulting surface

The journaling/replay core survives as an `Effect.Service`; everything else is
Effect's stdlib.

```ts
// The per-session journal-stream identity, as config-as-Tag — lets one Journal
// service be provided per session without a constructor parameter.
class SessionStream extends Context.Tag("firegrid/SessionStream")<SessionStream, StreamName>() {}

// Fenced append (§5.2.1) over this session's stream — producer-id/epoch/seq,
// idempotent. Built per session from SessionStream.
class FencedWriter extends Effect.Service<FencedWriter>()("firegrid/FencedWriter", {
  scoped: Effect.gen(function* () {
    return yield* openFencedWriter(yield* SessionStream)   // claims the epoch -> { collect, append }
  }),
}) {}

class Journal extends Effect.Service<Journal>()("firegrid/Journal", {
  dependencies: [FencedWriter.Default],
  scoped: Effect.gen(function* () {
    const writer = yield* FencedWriter
    const stream = yield* SessionStream
    const seen = new Map((yield* writer.collect).map((e) => [e.stepKey, e] as const))

    // `step` is the named-key unit (Appendix A). Effect.fn folds in the
    // `journal.step` span; the annotations ARE the Spec-1 decision span, and the
    // executed branch wraps the side effect in the `step.action` tripwire.
    // encode/decode are the step's Schema serde (Part 1: serde -> Schema); a
    // journaled domain error is a `Schema.TaggedError`, so its codec is free.
    // (In-process control errors — Suspended/ClaimHeld/Fenced — stay Data.TaggedError:
    //  they are caught in-process and never cross the journal, so need no schema.)
    const step = Effect.fn("journal.step")(function* <A, E>(key: string, action: Effect.Effect<A, E>) {
      const hit = seen.get(key)
      yield* Effect.annotateCurrentSpan({ "step.key": key, replayed: String(hit !== undefined) })
      if (hit?._tag === "StepSucceeded") {
        yield* Effect.annotateCurrentSpan("served", "journal")
        return hit.value as A
      }
      if (hit?._tag === "StepFailed") {
        yield* Effect.annotateCurrentSpan("served", "journal")
        return yield* Effect.fail(decode(hit) as E)
      }
      yield* Effect.annotateCurrentSpan("served", "executed")
      return yield* action.pipe(
        Effect.withSpan("step.action"),                                  // tripwire: must not fire on replay
        Effect.tap((value) => writer.append({ _tag: "StepSucceeded", stepKey: key, value })),
        Effect.tapError((error) => writer.append({ _tag: "StepFailed", stepKey: key, error: encode(error) })),
      )
    })

    // Replay lookup for the durable waits in Appendix B (sleep/wait read their own records).
    const find = (key: string, tag: string) =>
      Option.fromNullable(seen.get(key)).pipe(Option.filter((e) => e._tag === tag))

    return { step, find, append: writer.append, stream } as const
  }),
}) {}

// Per-session layer — one line. Composes the fenced writer + the stream identity.
// This is a layer FACTORY (the skills say prefer named constants) — justified here
// because the stream is a genuine runtime parameter. NB the inverse of the usual
// memoization rule: a fresh instance per session is REQUIRED, not accidental — each
// session builds its own replay/seen/writer at construction. Do NOT collapse this to
// a shared constant; that would share one stream's journal across all sessions.
const journalFor = (stream: StreamName) =>
  Journal.Default.pipe(Layer.provide(Layer.succeed(SessionStream, stream)))
```

Restate's free-function ergonomics survive — **without** the module-global slot
and its failure mode — because the service comes from Effect's fiber-scoped
context:

```ts
export const run = <A, E>(name: string, action: Effect.Effect<A, E>) =>
  Journal.pipe(Effect.flatMap((j) => j.step(name, action)))   // hand-rolled accessor: `accessors: true` can't infer step's <A, E>
```

```ts
const greet = (name: string) => Effect.gen(function* () {
  const a = yield* run("a", fetchA)
  const b = yield* run("b", fetchB)
  const [x, y] = yield* Effect.all(
    [run("x", fx), run("y", fy)],
    { concurrency: "unbounded" },          // safe now: keys explicit, order-independent
  )
  return `${a}-${b}-${x}-${y}`
})

// handler — provide the session's journal layer (resolves Journal + its deps):
greet("Ada").pipe(Effect.provide(journalFor(sessionStream)))
```

### Type mapping (concrete)

| fluent-firegrid today | Effect-native |
|---|---|
| `Operation<T>` | `Effect.Effect<T, E, R>` (a body written with `Effect.gen`). Lazy and re-runnable for free. |
| `Future<T>` (journal-backed) | an `Effect` (or `Effect.cached` if you want the by-hand memoization `Future.memo` does). |
| `Future<T>` (routine-backed) | a `Fiber<T>` from `Effect.fork`; `yield* Fiber.join(f)` **is** restate's eager-handle semantics. Effect unifies the two backings at the `yield*` boundary, so you likely don't need a single wrapper type at all. |
| `all` | `Effect.all` |
| `allSettled` | `Effect.all(effects, { mode: "either" })` |
| `any` | a small custom helper: concurrent first-success with error accumulation. **Not** `Effect.firstSuccessOf` (sequential fallback) and **not** `Effect.raceAll` (first to settle; a failure can win). |
| `select` | tagged wrapper over the chosen race helper; it inherits the same winner-record + loser-fate policy as `race`. |
| `spawn` | `Effect.fork` |
| `flushPendingState`, `raceIndexed`, `withCurrentScheduler` | **gone** |

### The one semantic landmine — flag it, don't silently inherit it

`Effect.race` **interrupts** the loser. restate (and the current `raceIndexed`)
**lets losers run and journal** — the combinators test asserts exactly this
("keeps race losers running and replays their journals"). Because losers
currently journal their `StepSucceeded`, a naive port to `Effect.race` would
interrupt them, they wouldn't journal, and **replay would diverge** if later
code references those entries.

So `race`/`select` need a deliberate, per-combinator choice:

- interrupt-and-don't-journal → `Effect.race`, or
- let-finish-and-journal → fork all, then race the `Fiber.await`s (interrupting
  the *await*, not the fiber).

Pick per combinator. Don't let the default decide.

### What becomes free

Four deferred tutorial tiers fall out of the redesign:

- **retry** → `Effect.retry` + `Schedule`
- **saga** → `Effect.acquireUseRelease` / `Effect.ensuring`
- **cancellation (in-process)** → Effect interruption + finalizers (see Part 2/3)
- **serdes** → you already have `Schema`

---

## Part 2 — The issues table reduces to three families

### Axis first: replay-durable vs wake-durable

The team's own "replay-durable vs wake-durable" distinction is the right axis.
**Part 1 lives entirely in the replay-durable world.** Switching to Effect
cleans up the API and all *in-process* concurrency/cancellation semantics; it
does **not** make anything wake-durable. Don't let the redesign imply otherwise.

### The three families

The 8 rows collapse into 3 primitive families — only one of which is genuinely
new infrastructure.

| Gap (their table) | Family | Effect-native shape / what's new |
|---|---|---|
| sleep (wake) | **durable park/wake** | `step(name, append TimerScheduled)`, then park on a `Deferred` completed by a timer-wake subscription — **not** `Effect.sleep`. Replay sees `TimerFired` → resolves immediately. |
| cancellation | **durable park/wake** + interruption | In-process: Effect interruption replaces the AbortSignal+fan-out machinery entirely; `Effect.ensuring` gives journaled cleanup; "not sticky" = a fresh attempt re-reads facts. New part: a `CancellationRequested` fact delivered via a wake stream → worker `Fiber.interrupt`s the in-flight drive. |
| managed-agent spawn | **durable park/wake** | Split it. `spawn` = `Effect.fork` (ephemeral, replay-local — fine as-is). Child *session* = append `ChildSpawned` with the child's own stream name; child runs its own `execute` driven by its own subscription. spawn-as-fiber and spawn-as-durable-invocation are **two primitives**, not one. |
| pull-wake / webhook | **durable park/wake (the runtime loop)** | The missing worker: claim → replay → drive → ack (see Part 3). In-process throttle is a weighted `Semaphore`/`Queue` over sessions per worker process. |
| journal idempotency | **fenced append** | A scoped `FencedWriter` (producer-id, epoch claimed at acquisition, 0-based seq); `append` idempotent on seq. Lives *below* the API in `effect-durable-streams`; `Journal.step` just threads it. read-before-execute is already the pattern. |
| state (CAS/shared) | **fenced append** | Same fencing, per object key. `DurableTable` keyed by id (the Shape-C events→DurableTable→keyed-subscribers pipeline); `set` = CAS append with expected seq; single-writer = exclusive handler holds the key. The in-memory fold + `flushPending` is fine for single-writer-per-invocation; the *concurrent/shared* case needs the keyed table as source of truth, not a `Map`. |
| replay / closure | **fenced append (terminal records)** | Distinguish "caught up to tail" (live) from "closed" (finite turn). Finite handlers append a terminal `Completed`/`Failed` **and** close the stream, so a reader tells done from idle. Today's read-to-current-tail can't. |
| sandbox activity | **Layer-provided activity** | *One-shot exec* is nearly free: `SandboxProvider` is a `Context.Tag`; the activity is `run("sandbox", SandboxProvider.exec(...))`; the `Layer` is composed at `execute`. A *long-lived* live resource (an agent process spanning many turns, emitting async output) is not a one-shot activity — but it is **not** a separate machine either: it is a resource a *session workflow* owns and re-establishes, with its output journaled inline by the body. See **Appendix E**. |

### Net-new vs substrate vs free

- **What you build above the server-provided wake machinery:** the coordination
  row taxonomy, wake-registry behavior, handler re-drive, and timer source.
  Pull-wake claim/ack/fencing is not reimplemented here; Durable Streams §7.2/
  §7.3 owns the distributed lease, delivery cursor, and generation fencing.
- **Substrate change in `effect-durable-streams`, not an API change:** fenced
  append (journal idempotency, state CAS, closure terminal records).
- **Falls out of Part 1 for free:** Layers (sandbox) and in-process interruption
  (in-process cancellation).

---

## Part 3 — Durable Streams §7.2/§7.3 already *is* the wake subsystem

Canonical Durable Streams operation sequences live in
`docs/cannon/architecture/fluent/substrate-protocol.md`. This part keeps the
implementation rationale and host-loop sketch: what Firegrid still writes inside
the claim→ack window, and why the timer gap is a scheduled-append source rather
than a second delivery path.

This is the most important correction to the Part 2 framing. On a DS server
version that implements pull-wake (§7.2) + generation fencing (§7.3), the
wake / lease / fencing / cursor subsystem is **the server's**. The distributed
exclusivity, fencing, and at-least-once delivery are not things you build, and
the in-process "weighted Semaphore" is *not* the analogy for the distributed
lease — it's only in-process fan-out throttling.

### What the server gives you (do not build)

- wake_stream consumption
- `claim` → lease + token + per-stream snapshot
  `{ acked_offset, tail_offset, has_pending }`
- `ack` / `done` cursor advancement
- ack-without-`done` heartbeat to extend the lease
- voluntary `release`
- generation / `wake_id` fencing (`409 FENCED`)
- lease expiry + reschedule
- glob/explicit linking with eager backfill-at-tail

This covers **work-wake, cancellation delivery, webhook ingest, and child
sessions** — because all four are *appends to a linked stream*. Cancellation in
particular collapses: a `CancellationRequested` fact is just an append on the
session's control stream; the worker wakes, claims, sees it,
interrupts/finalizes, acks. It is **not a separate mechanism — it's work-wake.**

### What you still write (inside the claim→ack window)

The subscription tells you "streams X,Y have pending past offsets N,M" — it does
**not** run your program. So:

1. claim the subscription (server-fenced),
2. run the Part-1 `execute`: read the journal, replay to current state, drive
   the Effect forward,
3. decide what to ack,
4. plus an **in-process throttle** (`Semaphore`/`Queue`) over how many sessions
   *one worker process* drives concurrently — that's legitimately yours; the
   per-subscription lease is the server's.

Conceptual shape (orchestration only; HTTP calls per §7.2):

```ts
// wake_stream → claim → replay+drive → ack ; timer source behind a Tag
const worker = Stream.merge(
  consumeWakeStream(wakeStreamUrl),    // §7.2 wake events
  Timer.fires,                         // the one net-new source — see below
).pipe(
  Stream.mapEffect(
    (wake) => Effect.scoped(
      claimSubscription(wake.subscription_id).pipe(   // 409 ALREADY_CLAIMED → skip
        Effect.flatMap((lease) =>
          driveSession(lease).pipe(                    // = Part-1 execute over the journal
            Effect.flatMap((acks) => ack(lease, acks, { done: true })),
          ),
        ),
      ),
    ),
    { concurrency: workerSessionLimit },   // <- your in-process Semaphore, NOT the lease
  ),
)
```

### The one thing §7.2 cannot do: durable `sleep`

The only wake trigger in the protocol is a **linked-stream append**
(§7: pending work = `tail_offset > acked_offset`). A wall-clock timer is "wake me
at T when *nothing* appends." There is no append at T, so the subscription has
no trigger. The obvious escape hatches don't work:

- lease expiry only reschedules **if pending work remains**, and it never
  *manufactures* pending work;
- holding a lease and heartbeating until T isn't durable — if the worker dies,
  reschedule finds no pending append and nobody wakes at T.

So a durable timer requires something to **materialize T as an append** — a
scheduler that writes `TimerFired` into a linked stream at T. The key
reframing: **the timer needs a new *source*, not a new *delivery path*.** Once
`TimerFired` lands, it flows through the exact subscription machinery you
already have.

- On Cloudflare, that source is naturally a **DO alarm**.
- Elsewhere, a **timer-wheel service**.

That scheduled-append component is the genuinely-unsolved piece, and it is the
whole of the `sleep` gap.

### Two fencing mechanisms — do not conflate

This tightens the Part-2 table. Both are server-provided; they fence different
things:

| Mechanism | Fences | Part-2 row it backs |
|---|---|---|
| §5.2.1 producer fencing (`Producer-Id` / epoch / seq) | **writers** to a stream | journal-idempotency / `FencedWriter` |
| §7.3 generation fencing (`generation` / `wake_id`) | **workers** claiming a subscription | the worker loop |

The "fenced append" family and the "worker loop" family both lean on the
server — just on different primitives.

### `acked_offset` is a delivery cursor, not a replay position

Easy to trip on. The subscription `acked_offset` means "don't re-wake me for
these" — it is **not** a replay position.

- Deterministic replay still reads the journal from start/snapshot **every
  claim**. Acking does **not** truncate the journal or mean "I won't re-read."
- The `(acked, tail]` delta is a **trigger** and an **ack target**, not the input
  to replay.
- `next_wake: true` on a `done`-ack is your **turn loop for free**: drain to
  tail, ack, and if a new message arrived mid-turn you're immediately re-woken.

---

## Coordination and ingress: one core, two moves

Every interaction — between agents and from outside — reduces to two moves
against the durable core: **write an event**, or **register a wake on one**. No
session references another session's code or invokes its loop; this is the
"sessions never call each other" invariant.

| tool | move | wakes the target on |
|---|---|---|
| `spawn(type/id, cfg)` | write (create + initial message) | registers `wake: "childStatus"` on *self* |
| `send("/type/id", payload)` | write (append to a peer's inbox) | the peer's own inbox wake |
| `observe(entity, { wake })` | register a wake | a peer's `state change` |
| `wait_for(predicate)` | register a wake | any event matching the predicate |

**Addressing is not calling.** `send` and `spawn` address an event to a specific
entity, but delivery is through the core and the recipient decides on its wake —
no function invocation, no return into a caller's stack. The invariant is "never
*call*," not "never *address*." This is stricter than Electric, which permits
direct agent→agent writes; "only through the core" keeps the plan a replayable
projection rather than a wired graph.

**Two coordination surfaces.** Declarative wakes (`spawn`/`observe { wake }`)
cover the internal, well-typed cases — child completion, observed state change.
CEL `wait_for` is kept for arbitrary external event shapes you cannot enumerate
ahead of time: `github.pr.merged && repo == "app"`, an approval id, a Slack event.

**Webhook ingress is just an external producer.** An external system POSTs to an
HTTP edge; the ingress handler appends a **fenced** event to the core (webhooks
redeliver, so delivery-id dedup lives here, under §5.2.1 producer fencing); the
wake-registry resolves which `wait_for` predicates match and wakes those entities,
each running `handleSession` with `wake._tag === "Event"`. Identical to how
approvals and tool-results land. The **wake-registry is the single mechanism
behind every wake source.**

---

## External control surface: addressing, fork, tag

Sessions and children are specified, but there is no external control plane — how
an operator, a UI, or a peer service addresses an entity from outside a handler.
Lift the entity-addressing surface (the shape, not the wire format):

```
/entities/:type/:id           spawn · get · head · delete
/entities/:type/:id/send       append to inbox
/entities/:type/:id/fork       branch a new entity from a point (fork_pointer)
/entities/:type/:id/tag        name a point in the stream
/entities/:type/:id/schedule   register a timed wake (→ wake-registry)
```

Two capabilities the product control plane should expose cleanly:

- **`tag`** — name a point (offset) in an entity's stream; an address for "this
  state," usable as a fork point or replay anchor.
- **`fork`** — branch a new entity whose initial stream is a prefix of an existing
  one, up to a tag/offset; it then diverges under its own handler. Durable
  Streams already has the substrate fork semantics; Firegrid still needs the
  product/control-plane spelling around it. Because the stream *is* the state,
  forking is copying a prefix. This gives "explore from this point," "retry a
  turn under a changed tool set," and "snapshot before a risky action" — none of
  which the continuation model offered.

**The read plane is the same projection, externalised.** An external observer
loads an entity's stream into a local DB with the *identical* schemas the handler
uses; the harness's own loop events appear via the normalized session stream (the
codec, Appendix E Layer 1), not a separate channel.

---

## Build order

Tiered around the handler-only runtime. The agent surface ships from the first
two tiers and the binding; it needs nothing from the below-line tier.

**Agent path** (deterministic given-keys; no soundness apparatus).

1. **Coordination event taxonomy (Spec 6)** — `runs`/`toolCalls`/`inbox`/
   `childStatus`/`wakes`/`tags`/`errors` as State-Protocol change-messages, keyed
   by given ids. The agent's own loop events are Layer 1 (the normalized stream,
   step 10), captured by the codec — not here.
2. **`handleSession` + `driveHarness`** — re-invoke the external harness with
   resume context. The harness-resumability dependency (re-drivable from the
   normalized stream; harness emits a normalizable native protocol) is the one
   piece of real engineering.
3. **`durable.wait` + the given-key principle** — `toolCallId` /
   `(toolCallId, slotIndex)`; the open park-interface decision (mechanism (b),
   Appendix E). Proves `durableWaitCoverage`.
4. **Declarative coordination** — `spawn`/`observe { wake }` + `send`; CEL kept
   for arbitrary events. Most of the old Appendix D.5 correlation becomes a wake
   registration.
5. **Cross-session** — `spawn`/`spawn_all` + child wake; `raceCoverage`
   (child-lifecycle policy). Proves `crossSessionCoverage`.
6. **Substrate semantics** — closure / cancel / child-lifecycle / sandbox
   activity. Proves `substrateSemanticsCoverage`.

**Shared substrate** (under the agent path and any below-line procedure).

7. **Worker loop** — claim → materialise → `handleSession(wake)` → ack, with the
   §7.3 generation lease (Appendix B). Makes every spec gradable host-side. Proves
   `workerLoopCoverage`.
8. **Wake registry / scheduled-append source** — the single mechanism behind
   every wake source. The net-new timer source (Part 3) is the "materialise T as
   an append" indirection. Reimplement on a DO alarm. Proves
   `durableSleepCoverage`.
9. **Fenced append (§5.2.1) + event ingress** — producer fencing for all external
   writers, including the webhook edge (delivery-id dedup). Closure rides the same
   fencing.

**Harness binding** (two halves).

10. **Normalizer (codec) + MCP-over-durable-streams** — (in) a per-harness
    normalizer maps the harness's native event protocol → the `NormalizedEvent`
    stream (Codex / Claude / ACP; reference: `durable-streams/coding-agents`);
    (out) durable tools exposed over MCP. Both swappable; Firegrid never wraps the
    loop.

**Below the choreography line** (optional; authored procedures only).

11. **The full continuation-concurrent-replay apparatus** — code-issued
    positional-key soundness under `Effect.all(concurrency: "unbounded")`, the
    combinators, in-process fiber-race semantics, the Appendix C *workflow* gates
    (Part 1 / Appendix A in full). For composite `execute` procedures with rollback
    and external orchestrators against the core. The agent runtime depends on none
    of it.

---

## Included as appendices

- **Appendix A** — the named-keys decision as a falsifiable finding in the
  spec-evidence idiom (decision span / tripwire / witness run / mutation harness).
  **Re-homed below the choreography line**: the concurrent-replay *apparatus* for
  authored procedures. The agent path needs only the given-key *principle*
  (Appendix D.2), not this proof.
- **Appendix B** — the Firegrid wake substrate: timer source + pull-wake
  re-driver. **Shared substrate**: what it claims→drives→acks is
  `handleSession` (Appendix E); on the agent path the park is the durable tool
  ending the harness turn, not a `Suspended` up a Firegrid stack.
- **Appendix C** — durability semantics as flamelab-style `CoverageSpec`s plus the
  host-substrate span vocabulary, reusing flamelab's oracle / lint / vacuity
  machinery verbatim. Gates re-home: coordination specs are agent-path/shared; the
  full replay apparatus and in-process fiber-race are below-line; `raceCoverage`
  facet b is child-cancellation. Layer-1 normalized events are the codec's, not
  gated as substrate spans.
- **Appendix D** — the README's agent surface (`wait_for` / `wait_until` / `sleep`
  / `spawn` / `spawn_all` / `execute`) as the durable tools the harness calls plus
  the codec (Layer 1): the per-tool table, the one new primitive (`durable.wait`),
  the cross-session join/route shape, and CEL `wait_for` predicates. The "named-key
  dividend" (D.2) *is* the given-key principle.
- **Appendix E** — a session as a **handler over the external harness**:
  `handleSession(wake)` re-invokes the agent's own loop, the two-layer stream
  (normalized codec events + coordination), the durable tools, and the open
  park-interface decision. Supersedes the earlier "live session is a workflow"
  coroutine shape.

## Still open

- Stand up the flamelab-style runner over fluent-firegrid — the driver + Control +
  infra seam, the analog of flamelab's `host.ts` / `lab.ts`. tiny-firegrid is the
  natural home: it already plays the architectural oracle for the *shape*; this
  makes it the oracle for the *semantics* too.
- **Decide the park interface** (Appendix E): how a parking durable tool ends the
  harness's turn — recommended mechanism **(b)**, transport-level end-of-turn over
  the binding. This is the load-bearing piece of the non-invasive binding and gates
  `durableWaitCoverage`.
- **Pick the child-race loser policy** (Appendix C, `raceCoverage` facet b): cancel
  the losing child vs leave it running and absorb its wake. The winner-record facet
  (a) is not a choice — gate it regardless.
- **Decide Claude's wire protocol: ACP vs native.** `coding-agents` *superseded its
  own ACP bridge* (2026-03-31 spec) with native per-agent protocols (2026-04-01
  spec — Claude `--sdk-url` WebSocket, Codex `app-server`) because ACP's
  `session/update` *"flattens agent-native behavior… approvals/streaming/resume less
  faithful"* (concrete: the per-request approval mapping in the adapter contract,
  Appendix E). Firegrid currently binds Claude via **claude-acp — the earlier,
  lower-fidelity shape.** The normalizer-per-protocol design supports either
  (`acpNormalize` / `claudeNormalize`); choose consciously per agent: ACP's
  agent-agnostic simplicity vs native's fidelity.
- **Confirm the reported Electric internals against source** before lifting the
  architecture: `agents-server`'s scheduler / wake-registry and the `/entities/...`
  RPC + fork/tag surface came from a second-hand source-reading (see *Sources &
  provenance*), not first-hand. The execution-model decision itself is
  first-hand-evidenced (the `coding-agents` normalizer, PR #317).

---

# Appendix A — Named keys as a falsifiable finding (spec-evidence idiom)

> **Scope.** Under the execution model, this proof governs *below-line authored
> procedures* — where code, not the model, issues concurrent journaled steps
> without natural ids. The **agent path** never hits the hard case: its keys are
> the model's tool-call id / `(toolCallId, slotIndex)`, given by construction
> (Appendix D.2). Read "load-bearing" below as load-bearing *for those procedures*.

The named-vs-positional decision (Part 1) is the load-bearing one — it's the sole
prerequisite for `run` returning a plain `Effect` and for deleting
`Future`/`Scheduler`/`Awaitable`/`current.ts`. So it should be *ratified*, not
asserted. Written as a TFIND-style finding:

### TFIND — named journal keys are sound under concurrent replay

**Claim (falsifiable).** With caller-supplied, replay-stable step names, re-driving
an operation against its journal serves **every** previously-journaled step from
the journal — including steps issued concurrently under `Effect.all` — and never
re-executes a journaled side effect. Equivalently: step identity is
*name-addressed*, not *execution-order-addressed*.

**Why it gates the whole redesign.** If false, eagerness plus an impure
construction-time counter are mandatory (a runtime counter read inside
`{ concurrency: "unbounded" }` is consulted in scheduling order, not source order),
and the bespoke DSL stays. If true, the DSL collapses onto Effect.

**Decision span (positive evidence).** `journal.step{ replayed, served }`. On the
replay epoch, `served == "journal"` *at the decision point* is the evidence. We do
**not** infer soundness from the absence of a side-effect span — that would be an
unsound absence claim.

**Tripwire (scoped absence).** `step.action` firing under a replayed step is the
breach. This is sound **only because the witness captures epoch 1**, where
`step.action` legitimately fires — a replay-only trace would make the tripwire
*vacuously green*, which the verdict oracle must reject (flamelab's vacuity check
already does this). State the scope explicitly: the tripwire is meaningful within a
trace that contains both epochs.

**Witness run.** Issue N steps under `Effect.all(effects, { concurrency: "unbounded" })`,
let the operation complete, then re-drive against the **same** journal in the
**same** process so both epochs land in one trace. Concurrency is the load — a
sequential witness cannot distinguish name-addressed from order-addressed keys and
would pass under both.

**Mutation harness (must flip red).** Replace the name-addressed key with a
construction-order positional key — i.e. the restate-port behavior
(`nextStepIndex` incremented at `Future` construction). Under concurrency the
epoch-2 key assignment diverges from epoch-1 → journal misses →
`served == "executed"` and `step.action` fires on a replayed step → **red**. A
mutation run that stays green means the test has no teeth.

**Verdict.** Green iff `replay.served_from_journal` holds **and** the mutation run
is red, with `replay.path_entered` non-vacuous. Ratify on tiny-firegrid before the
production cutover; the spec is Appendix C, Spec 1.

**Where the key comes from at the agent surface (forward ref to Appendix D).** The
"caller supplies a unique, replay-stable name" cost evaporates when the caller is
the model: the step key is the tool-call id. Two qualifiers, or the soundness
above does not transfer: the key must be **turn-scoped** (`turnSeq:callId` — raw
tool-call ids are unique per response, not across turns) and read from the
**journaled** turn output, **never** re-minted by re-invoking the model on replay
(a nondeterministic provider hands you fresh ids on replay → journal miss →
re-execution — the exact failure above). This is a claim for the *agent-layer*
oracle (`agent.turn` is not a substrate span): a replayed turn serves its recorded
tool calls.

---

# Appendix B — Firegrid wake substrate: timer source + pull-wake re-driver

> **Scope.** The canonical protocol contract is
> `docs/cannon/architecture/fluent/substrate-protocol.md`. This appendix is an
> Effect implementation sketch for the host loop. The worker loop is **shared
> substrate** (model-agnostic): it claims → materialises → drives
> `handleSession(wake)` (Appendix E) → acks, under the §7.3 lease. The
> `Suspended`-on-the-error-channel mechanic below is the *below-line / owned*
> shape of a park; on the **agent path** a park is the durable tool ending the
> harness's turn (Appendix E, mechanism (b)). The timer source is the
> wake-registry.

Orchestration and span emission only; the Durable Streams HTTP surface
(§7.2/§7.3) and the timer source sit behind Tags. The spans emitted here are
exactly the host-substrate spans Appendix C gates on — the sketch produces the
evidence the oracle reads.

Idioms, per the Effect-TS skills: `Effect.fn(name)` for traced functions (the
span name *is* the function, no trailing `.pipe(Effect.withSpan)`), services
resolved from context (no `ops` parameter, no threaded handle), the lease modeled
as an `Effect.acquireRelease` resource, and a `forkScoped` + `Schedule` heartbeat.

```ts
import { Clock, Context, Data, Duration, Effect, Option, Schedule, Stream } from "effect"

// ── The one net-new SOURCE. Materializes a future instant T as an append. ──
// Behind a Tag so the loop composes regardless of platform: a Cloudflare DO
// alarm, a timer-wheel service, or an in-process fake for the oracle's witness.
class Timer extends Context.Tag("firegrid/Timer")<Timer, {
  // Promise to append `TimerFired{ key }` onto `stream` at `at`. Durable: the
  // promise outlives the worker; if the worker dies the source still fires.
  readonly scheduleAt: (stream: StreamName, key: string, at: number) => Effect.Effect<void>
}>() {}

// ── The DS pull-wake surface (§7.2/§7.3) — claim / ack / release are SERVER- ──
// fenced; we consume the lease, never implement it. The 409s are typed errors.
class ClaimHeld extends Data.TaggedError("ClaimHeld")<{ readonly holder: string }> {}
class Fenced extends Data.TaggedError("Fenced")<{ readonly generation: number }> {}
class DurableStreams extends Context.Tag("firegrid/DurableStreams")<DurableStreams, {
  readonly consumeWakeStream: (sub: SubscriptionId) => Stream.Stream<Wake>
  readonly claim:   (sub: SubscriptionId, worker: string) => Effect.Effect<Lease, ClaimHeld>      // 409 ALREADY_CLAIMED
  readonly ack:     (lease: Lease, acks: ReadonlyArray<Ack>, opts: { done: boolean }) => Effect.Effect<{ next_wake: boolean }, Fenced> // 409 FENCED
  readonly release: (lease: Lease) => Effect.Effect<void>
}>() {}

// A turn ends one of two ways: it ran to completion, or it hit a durable wait it
// cannot satisfy now (a sleep with no TimerFired yet, an unfilled child join, …).
type DriveOutcome =
  | { readonly _tag: "Completed"; readonly acks: ReadonlyArray<Ack> }
  | { readonly _tag: "Suspended" }                 // leave pending to the relevant SOURCE
class Suspended extends Data.TaggedError("Suspended")<{ readonly reason: string }> {}

// ── Durable sleep: replay-skip, else append-intent-then-suspend. NOT Effect.sleep. ──
// Effect.fn folds in the `durable.sleep` span and gives a traced call site.
const sleep = Effect.fn("durable.sleep")(function* (name: string, durationMs: number) {
  const j = yield* Journal                          // resolved from context — no `ops`, no slot
  yield* Effect.annotateCurrentSpan("sleep.name", name)

  if (Option.isSome(j.find(name, "TimerFired"))) {  // replay: already woken — resume immediately
    yield* Effect.annotateCurrentSpan("woke_via", "replay")
    return
  }
  // First run: append the park INTENT before waiting (durable; survives crash),
  // then ask the SOURCE to materialize the wake. Those two appends are exactly
  // what the current Effect.sleep impl cannot produce — the forge-proof evidence.
  const at = (yield* Clock.currentTimeMillis) + durationMs
  yield* j.append({ _tag: "TimerScheduled", key: name, at })
    .pipe(Effect.withSpan("timer.schedule", { attributes: { "sleep.name": name, at } }))
  const timer = yield* Timer
  yield* timer.scheduleAt(j.stream, name, at)

  // Park == end the turn. No fiber blocks on wall-clock time; the worker is freed,
  // and a LATER claim re-drives this session and replays past the TimerFired.
  yield* Effect.annotateCurrentSpan("woke_via", "park")
  return yield* new Suspended({ reason: `sleep:${name}` })
})

// ── worker.ack as its own traced function: ack/done, or heartbeat (done:false). ──
const ack = Effect.fn("worker.ack")(function* (
  lease: Lease,
  acks: ReadonlyArray<Ack>,
  opts: { done: boolean },
) {
  const ds = yield* DurableStreams
  const { next_wake } = yield* ds.ack(lease, acks, opts)   // 409 FENCED -> fails -> cursor NOT advanced
  yield* Effect.annotateCurrentSpan({ done: String(opts.done), next_wake: String(next_wake) })
})

// The ack endpoint doubles as heartbeat (§7.2): ack-without-done extends the lease.
// Repeat at half the TTL; forkScoped (below) ties its life to the claim's scope.
const heartbeat = (lease: Lease) =>
  ack(lease, [], { done: false }).pipe(
    Effect.ignore,   // a fenced heartbeat means the lease was lost; a production loop interrupts the drive here
    Effect.repeat(Schedule.spaced(Duration.millis(lease.leaseTtlMs / 2))),
  )

// ── Drive a session under a held claim: replay + advance, classify the outcome. ──
const driveSession = Effect.fn("session.drive")(function* (lease: Lease) {
  yield* Effect.annotateCurrentSpan("generation", lease.generation)
  const op = yield* loadSession(lease)                     // reconstruct the session's program
  return yield* op.pipe(
    Effect.provide(journalFor(lease.stream)),              // run/sleep/durable.wait read Journal from here
    Effect.map((): DriveOutcome => ({ _tag: "Completed", acks: tailAcks(lease) })),
    Effect.catchTag("Suspended", () => Effect.succeed<DriveOutcome>({ _tag: "Suspended" })),
  )
})

// ── One wake: claim (skip if held), drive under the claim, ack/done or release. ──
const handleWake = Effect.fn("worker.claim")(function* (wake: Wake, worker: string) {
  yield* Effect.annotateCurrentSpan("subscription.id", wake.subscriptionId)
  yield* Effect.scoped(
    Effect.gen(function* () {
      const ds = yield* DurableStreams
      // The lease is a scoped resource: released on scope exit — covering interrupt
      // AND the Suspended path. (On the Completed path, ack-done releases server-side
      // first, so this finalizer is then a fenced no-op — hence Effect.ignore.)
      const lease = yield* Effect.acquireRelease(
        ds.claim(wake.subscriptionId, worker),
        (l) => ds.release(l).pipe(Effect.ignore),
      )
      yield* Effect.annotateCurrentSpan("outcome", "acquired")
      yield* Effect.forkScoped(heartbeat(lease))           // extend the lease until the scope closes
      const outcome = yield* driveSession(lease)           // span: session.drive (descendant of worker.claim)
      if (outcome._tag === "Completed") yield* ack(lease, outcome.acks, { done: true })
      // Suspended: do nothing — the finalizer releases; pending work is left to the SOURCE.
    }),
  ).pipe(
    // Lost the claim race — another worker owns the lease. Record it and move on.
    Effect.catchTag("ClaimHeld", () => Effect.annotateCurrentSpan("outcome", "already_claimed")),
  )
})

// ── The loop: consume wake_stream; the Semaphore bounds OUR concurrency — the ──
// per-subscription lease is the server's. These are different mechanisms.
const worker = (sub: SubscriptionId, id: string, limit: number) =>
  Effect.gen(function* () {
    const ds = yield* DurableStreams
    const sem = yield* Effect.makeSemaphore(limit)
    yield* ds.consumeWakeStream(sub).pipe(
      Stream.mapEffect((wake) => sem.withPermits(1)(handleWake(wake, id)), {
        concurrency: "unbounded",                     // really bounded by the Semaphore
      }),
      Stream.runDrain,
    )
  })
```

Two things to read off the sketch:

- **`sleep` never calls `Effect.sleep`.** Park == end-of-turn; the `Timer` source
  is the only thing that re-creates pending work at T. That is the whole `sleep`
  gap, isolated to one Tag.
- **Two concurrency controls, deliberately separate.** `Effect.makeSemaphore`
  bounds how many sessions *this process* drives; the `claim`/`ack` lease is the
  server's per-subscription exclusivity. Conflating them is the mistake the
  "weighted Semaphore" line in earlier discussion invited — this keeps them apart.
- **The lease is a resource, not manual bookkeeping.** `acquireRelease` guarantees
  release on completion, suspension, *and* interruption; on the Completed path the
  done-ack releases first, leaving the finalizer a fenced no-op. No leaked claim on
  a crashed drive — and the heartbeat fiber dies with the same scope.

---

# Appendix C — Durability semantics as flamelab-style coverage specs

> **Scope.** Gates re-home under the execution model: `durableWaitCoverage`,
> `crossSessionCoverage`, `substrateSemanticsCoverage`, `durableSleepCoverage`,
> `workerLoopCoverage` are **agent-path / shared**; the full replay apparatus and
> the in-process fiber-race are **below-line**; `raceCoverage` facet b gates
> *child cancellation*, not fiber interruption. The Layer-1 normalized session
> events (the codec's, Appendix E) are observation, **not** gated as host-substrate
> spans — the gates name only the coordination layer.

These are written in flamelab's exact `CoverageSpec` shape so the build team can
reuse `analyzeCoverage` / the AST lint / the vacuity check **verbatim** against a
fluent-firegrid trace. What's new is the runner (driver + Control + infra seam —
the analog of `host.ts` / `lab.ts`) and the span vocabulary below; tiny-firegrid
is the natural host.

The discipline is the same as flamelab's: each gate names only host-substrate
spans (lint-enforced), each spec has a **witness** that produces the spans and a
**mutation harness** (negative control) that must flip the verdict, and absence is
encoded as an **attribute on a span that fires** rather than as a bare
`size(...) == 0` (which the oracle flags as vacuous green).

```ts
// ── The host-substrate vocabulary fluent-firegrid must emit. A gate may name ──
// only these (the forge-proof lint). The substrate emits them server-side; a
// driver/Control harness cannot forge them.
export const HOST_SUBSTRATE: ReadonlySet<string> = new Set([
  "journal.step",      // one durable step — the named-key unit (Appendix A)
  "journal.append",    // a fenced append (§5.2.1 producer idempotency)
  "step.action",       // the user side-effect; a TRIPWIRE — must not fire on a replayed step
  "durable.sleep",     // a durable timer park
  "timer.schedule",    // TimerScheduled appended (the park intent)
  "timer.fire",        // the scheduled-append SOURCE woke us (external; unforgeable)
  "worker.claim",      // a subscription claim, lease acquired (§7.2)
  "worker.ack",        // ack / heartbeat (§7.2/§7.3)
  "session.drive",     // replay + advance of a session under a held claim
  "race.settle",       // a race/select resolution (carries the loser semantic)
  "child.spawn",       // a durable child session (ChildSpawned) — not Effect.fork
  "cancel.delivered",  // interruption delivered to an in-flight drive
  "state.cas",         // a CAS append to keyed object state
  "stream.close",      // terminal close of a finite stream (Completed/Failed)
  "sandbox.run",       // a Layer-provided sandbox activity (shared with core)
])

// ── Shared claims (so they don't drift across specs). ──
const stepsDidNotError: ClaimDef = {
  id: "steps.did_not_error",
  description: "no durable step ended in error",
  claim: `spans.filter(s, named(s, "journal.step")).all(s, !errored(s))`,
}

// ════════════════════════════════════════════════════════════════════════════
// Spec 1 — replay: named keys are sound under concurrent replay (Appendix A).
//   Witness: issue N steps under Effect.all(concurrency:"unbounded"), complete,
//   then re-drive against the SAME journal in one process (both epochs, one trace).
//   Mutation harness: positional construction-order keys -> on replay the
//   concurrent steps mis-key -> served=="executed" / step.action fires -> RED.
// ════════════════════════════════════════════════════════════════════════════
export const replayCoverage: CoverageSpec = {
  gates: [
    {
      id: "replay.path_entered",            // vacuity anchor — the replay epoch ran a journaled step
      description: "the replay epoch served at least one step from the journal",
      claim: `spans.exists(s, named(s, "journal.step") && attr(s, "replayed") == "true")`,
    },
    {
      id: "replay.served_from_journal",     // the soundness invariant (decision-span form)
      description: "every replayed step was served from the journal, none re-executed",
      claim: `spans.filter(s, named(s, "journal.step") && attr(s, "replayed") == "true").all(r, attr(r, "served") == "journal")`,
    },
    stepsDidNotError,
  ],
  corroborations: [
    {
      id: "replay.tripwire_clear",          // scoped absence — sound only because epoch 1 fired step.action
      description: "no side effect re-executed under a replayed step",
      claim: `spans.filter(s, named(s, "step.action")).all(a, attr(a, "replayed") == "false")`,
    },
  ],
}

// ════════════════════════════════════════════════════════════════════════════
// Spec 2 — durable-sleep: wake-durable, not just replay-durable.
//   Witness: schedule a sleep, crash the drive BEFORE TimerFired, restart, let
//   the Timer SOURCE fire. Mutation harness: revert sleep to Effect.sleep
//   (process-local) -> timer.schedule + timer.fire never fire -> RED.
// ════════════════════════════════════════════════════════════════════════════
export const durableSleepCoverage: CoverageSpec = {
  gates: [
    {
      id: "sleep.intent_durable",
      description: "the park intent (TimerScheduled) was appended before waiting",
      claim: `spans.exists(s, named(s, "timer.schedule"))`,
    },
    {
      id: "sleep.woken_by_source",          // unforgeable: a process-local timer cannot emit this
      description: "the wake came from the scheduled-append source, not a local timer",
      claim: `spans.exists(s, named(s, "timer.fire"))`,
    },
    {
      id: "sleep.resumed_via_wake",
      description: "a sleep resumed via the external wake (woke_via=wake), not replay or local sleep",
      claim: `spans.exists(s, named(s, "durable.sleep") && attr(s, "woke_via") == "wake")`,
    },
    {
      id: "sleep.intent_precedes_park",     // structural: parking sleeps appended their intent as a child
      description: "every parking sleep emitted its TimerScheduled before suspending",
      claim: `spans.filter(s, named(s, "durable.sleep") && attr(s, "woke_via") == "park").all(s, hasChild(s, "timer.schedule"))`,
    },
  ],
}

// ════════════════════════════════════════════════════════════════════════════
// Spec 3 — fenced-append: §5.2.1 producer idempotency (fences WRITERS).
//   Witness: drive a step, force a retry of the SAME (producerId,epoch,seq)
//   append (crash between append and ack). Mutation harness: drop the producer
//   headers (or a non-atomic store with no epoch bump) -> the retry double-writes
//   -> a second journal.append{retry:true, deduped:false} -> RED.
// ════════════════════════════════════════════════════════════════════════════
export const fencedAppendCoverage: CoverageSpec = {
  gates: [
    {
      id: "append.retry_path_entered",      // vacuity anchor
      description: "a retried append occurred",
      claim: `spans.exists(s, named(s, "journal.append") && attr(s, "retry") == "true")`,
    },
    {
      id: "append.retries_deduped",
      description: "every retried append was deduped server-side, never double-written",
      claim: `spans.filter(s, named(s, "journal.append") && attr(s, "retry") == "true").all(a, attr(a, "deduped") == "true")`,
    },
  ],
}

// ════════════════════════════════════════════════════════════════════════════
// Spec 4 — worker-loop: claim -> drive -> ack, plus §7.3 generation fencing
//   (fences WORKERS — distinct from Spec 3) and the next_wake turn loop.
//   Witness: two workers race a claim; the slow one acks late (stale generation);
//   a message arrives mid-turn. Mutation harness A: drive without claiming ->
//   no acquired claim -> claim.acquired fails -> RED. Mutation harness B: a stale
//   ack is NOT fenced -> cursor double-advances -> fencing gate fails -> RED.
// ════════════════════════════════════════════════════════════════════════════
export const workerLoopCoverage: CoverageSpec = {
  gates: [
    {
      id: "claim.acquired",                 // orphan-drive mutation flips this to false
      description: "a worker acquired the subscription lease",
      claim: `spans.exists(s, named(s, "worker.claim") && attr(s, "outcome") == "acquired")`,
    },
    {
      id: "drive.under_claim",              // every acquired claim drove a session (downward walk only)
      description: "every acquired claim drove a session — no drive outside a claim",
      claim: `spans.filter(s, named(s, "worker.claim") && attr(s, "outcome") == "acquired").all(c, hasDescendant(c, "session.drive"))`,
    },
    {
      id: "ack.completed",
      description: "a done-ack closed a turn",
      claim: `spans.exists(s, named(s, "worker.ack") && attr(s, "done") == "true")`,
    },
    {
      id: "fencing.stale_ack_rejected",     // §7.3 — witness must produce a stale ack (else vacuous)
      description: "every stale-generation ack was fenced, never advancing the cursor",
      claim: `spans.filter(s, named(s, "worker.ack") && attr(s, "generation_stale") == "true").all(a, attr(a, "fenced") == "true")`,
    },
    {
      id: "turn_loop.rewoke",               // next_wake=true on a mid-turn arrival — the free turn loop
      description: "a message arriving mid-turn triggered a follow-up wake",
      claim: `spans.exists(s, named(s, "worker.ack") && attr(s, "next_wake") == "true")`,
    },
  ],
  corroborations: [
    {
      id: "claim.contended",                // the losing worker saw ALREADY_CLAIMED (any span ok here)
      description: "a second worker observed the lease already held",
      claim: `spans.exists(s, named(s, "worker.claim") && attr(s, "outcome") == "already_claimed")`,
    },
  ],
}

// ════════════════════════════════════════════════════════════════════════════
// Spec 5 — race: TWO facets of the Part-1 landmine, not one.
//   (a) winner-record: is the WINNER journaled (restate appends RaceCompleted{
//       winnerIndex} and reads it on replay; Effect.raceAll does NOT). Without it,
//       replay re-runs the race and may pick a different winner — and the bounded-
//       wait_for safety in Appendix D.6 evaporates.
//   (b) loser-fate: do LOSERS keep running and journal (restate) vs get interrupted.
//   Written for "preserve restate semantics" on both. Witness: race fast vs slow,
//   complete, re-drive. Mutation A: Effect.raceAll (no winner record) -> winner_
//   journaled=="false" -> RED. Mutation B: Effect.race (interrupt) -> losers_
//   journaled=="false" -> RED.
//   INVERSE (loser-fate only): if the team chooses interruption, invert (b) to
//   attr(r,"losers_journaled") == "false" and make its mutation the let-finish path.
//   Facet (a) is NOT a choice — the winner must be journaled either way.
// ════════════════════════════════════════════════════════════════════════════
export const raceCoverage: CoverageSpec = {
  gates: [
    {
      id: "race.settled",                   // vacuity anchor
      description: "a race/select resolved",
      claim: `spans.exists(s, named(s, "race.settle"))`,
    },
    {
      id: "race.winner_journaled",          // facet (a) — not a choice; replay-determinism of the race
      description: "the race winner index was journaled, so replay resolves it deterministically",
      claim: `spans.filter(s, named(s, "race.settle")).all(r, attr(r, "winner_journaled") == "true")`,
    },
    {
      id: "race.losers_journaled",          // facet (b) — the chosen loser-fate semantic, mechanically enforced
      description: "race losers kept running and journaled their step (restate semantics)",
      claim: `spans.filter(s, named(s, "race.settle")).all(r, attr(r, "losers_journaled") == "true")`,
    },
  ],
}

// ════════════════════════════════════════════════════════════════════════════
// Spec 6 — further semantics: closure, cancellation, durable child, sandbox,
//   keyed-state CAS. Terser, but each gate has a one-line mutation harness.
//     closure       NC: read-to-tail without close  -> no stream.close       -> RED
//     cancellation  NC: in-process abort / swallow   -> no cancel.delivered   -> RED
//     child.spawn   NC: route through Effect.fork     -> no child.spawn        -> RED
//     sandbox.run   NC: neuter the provider Layer     -> no sandbox.run        -> RED
//     state.cas     NC: concurrent writers, no single-writer -> conflict==true -> RED
// ════════════════════════════════════════════════════════════════════════════
export const substrateSemanticsCoverage: CoverageSpec = {
  gates: [
    {
      id: "closure.terminal_record",
      description: "a finite turn closed its stream with a terminal record (reader tells done from idle)",
      claim: `spans.exists(s, named(s, "stream.close") && attr(s, "terminal") == "completed")`,
    },
    {
      id: "cancel.interruption_delivered",
      description: "a CancellationRequested fact interrupted an in-flight drive (not the in-process abort path)",
      claim: `spans.exists(s, named(s, "cancel.delivered"))`,
    },
    {
      id: "spawn.durable_child",
      description: "a durable child session was forked with its own stream (not an ephemeral Effect.fork)",
      claim: `spans.exists(s, named(s, "child.spawn"))`,
    },
    {
      id: "sandbox.layer_provided",
      description: "the Layer-provided sandbox activity ran as a journaled step",
      claim: `spans.exists(s, named(s, "sandbox.run"))`,
    },
    {
      id: "state.cas_serialized",
      // keyed state rides the Durable Streams State Protocol: a `set` is an
      // insert/update change message; CAS uses `old_value` for conflict detection;
      // `clearAll` is the `reset` control. The fold IS materialization (§6 there).
      description: "every CAS append to keyed state was accepted in sequence (single-writer per key)",
      claim: `spans.filter(s, named(s, "state.cas")).all(c, attr(c, "conflict") == "false")`,
    },
  ],
}
```

## How a build-team member uses this

Same loop as flamelab's README: pick the behavior you want to prove, write (or
take from above) a gate that names the host-substrate span carrying it, run the
witness. If the span isn't emitted yet, the gap backlog (`flamelab gaps`-equivalent)
points at the `file:line` to add the `withSpan`. Then write the mutation harness
and confirm it flips the verdict red — a gate whose mutation stays green is a gate
with no teeth, exactly the failure the spec-evidence discipline exists to catch.

The mapping from this doc's three families back to the specs, for traceability:

| Family (Part 2) | Specs | Fencing primitive |
|---|---|---|
| replay-durable (Part 1) | Spec 1, Spec 5 | — |
| fenced append | Spec 3, Spec 6 (`state.cas`) | §5.2.1 (writers) |
| durable park/wake | Spec 2, Spec 4, Spec 6 (cancel/child) | §7.3 (workers) |
| Layer-provided activity | Spec 6 (`sandbox.run`) | — |

---

# Appendix D — The README's agent surface over the substrate

> **Scope.** Under the execution model, the surface is delivered by the **codec**
> (the agent's own loop → Layer-1 `NormalizedEvent`s) plus the **durable tools the
> harness calls** (`wait_for`/`spawn`/`execute` over MCP) — not a wrapped loop.
> D.2's "named-key dividend" *is* the agent-path given-key principle; `durable.wait`
> is the parking tool whose turn-ending mechanism is the open interface (Appendix
> E, mechanism (b)).

The README's design rule is *"every feature = one primitive + one combinator; if
it can't be, it's a product object above the substrate, not core."* This appendix
checks the six durable tools against that rule and against Appendix C.

**The claim, stated precisely.** Passing the Appendix C specs is **necessary** for
the surface and **sufficient at the substrate layer once two things are added**:
one new primitive — `durable.wait`, the event-park twin of `durable.sleep` — and
one new spec *shape* — cross-session join/route. Everything left over is surface
glue the README itself files above the substrate.

## D.1 Per-tool reduction

| Surface tool | Primitive + combinator | Spec(s) |
|---|---|---|
| `execute(target, input)` | `run(name, eff)`; sandbox via injected Layer | 1; 6 (`sandbox.run`) |
| `sleep(duration)` | `durable.sleep` (alias of `wait_until("+d")`) | 2 |
| `wait_until(time, prompt?)` | `durable.sleep` (+ turn-loop when `prompt`) | 2 (+ 4) |
| `wait_for(event, prompt?)` | **`durable.wait`** (event-park) + §7.2 wake | **D.3** + 4 (+ 5 if `timeoutMs`) |
| `spawn(agent, prompt)` | `child.spawn` + `wait_for(child-result)` | 6 (child) + **D.3** + **D.5** |
| `spawn_all(tasks)` | N×`child.spawn` + `Effect.all` | 6 + 1 + **D.3** + **D.5** |
| `session_cancel` + `session_prompt` | `cancel.delivered` (cross-session) + new turn | 6 + **D.5** + 4 |

**The 1:1 that makes it clean.** The README's *"one family, two axes — `for` =
event, `until` = time"* **is** the substrate's *"one park/wake mechanism, two
sources."* The `until`/time leg needs the `Timer` source you build (Part 3, Spec 2);
the `for`/event leg rides the §7.2 subscription directly — the world's appends
(webhook, approval, CI, a child's published result) are the wake, no net-new
source. The surface's two axes are the substrate's two sources, and the only one
you author is the timer. The whole handoff, one level up.

## D.2 The named-key dividend (with the two qualifiers)

Appendix A's cost — caller supplies a replay-stable name per step — evaporates
here: the key is the model's tool-call id. As stated in Appendix A's verdict, it
must be **turn-scoped** (`turnSeq:callId`) and read from the **journaled** turn
output, not re-minted on replay. So the decision flagged as load-bearing for the
*whole* redesign is *free precisely where it is used* — conditional on those two
qualifiers. Tell the build team plainly: surface keys come from tool-call ids;
do not reintroduce a positional counter.

## D.3 `durable.wait` — the event-park twin (the one new primitive)

Load-bearing, not polish: it unlocks `wait_for`, `spawn`, `spawn_all`, and the
approval gate (which is just `wait_for(approval-event)`). In this model the parent
**cannot** inline-join a child fiber — sessions coordinate only through the core
(README: *"sessions never call each other"*) — so `spawn`'s "durably await" **is** a
`wait_for` on the child's result event.

Shape mirrors `durable.sleep`: append `WaitRegistered{predicate}` **before**
suspending; wake on a §7.2 append; evaluate the match **in the drive** (DS globs
stream *paths* only, so a non-matching wake re-suspends).

```ts
// HOST_SUBSTRATE additions: "durable.wait", "wait.register", "child.result".
//
// Witness: register a wait, deliver a NON-matching event (must re-suspend), then a
// matching one (must resolve). The non-matching delivery is mandatory — without it
// `wait.nonmatch_resuspends` is vacuous green (the same discipline as Spec 4's
// stale-ack). Mutation: make the wait process-local (block a fiber, no
// WaitRegistered) -> dies on restart -> RED (the exact analog of Spec 2's
// Effect.sleep mutation).
export const durableWaitCoverage: CoverageSpec = {
  gates: [
    {
      id: "wait.intent_durable",
      description: "the wait registered its intent before suspending",
      claim: `spans.exists(s, named(s, "durable.wait") && hasChild(s, "wait.register"))`,
    },
    {
      id: "wait.woken_by_append",
      description: "a parked wait resumed via an external append (woke_via=wake)",
      claim: `spans.exists(s, named(s, "durable.wait") && attr(s, "woke_via") == "wake")`,
    },
    {
      id: "wait.nonmatch_resuspends",       // witness MUST deliver a non-match, else vacuous
      description: "a wake whose event did not match the predicate re-suspended, it did not resolve",
      claim: `spans.filter(s, named(s, "durable.wait") && attr(s, "matched") == "false").all(s, attr(s, "outcome") == "resuspended")`,
    },
  ],
}
```

**`durable.sleep` and `durable.wait` are one family, two sources.** Build them as
one park/wake mechanism: append-intent-then-suspend; resume on a §7.2 wake; resolve
from the journal on replay. The only difference is *what creates the waking append*
— the `Timer` source (D.2/Spec 2) for time, the world for events. Same `woke_via`
attribute, same replay path, same mutation (process-local → dies on restart → RED).

## D.4 `wait_for` predicates in CEL (Inngest parity)

`wait_for`'s `event` can be a CEL predicate over the candidate event, not just a
name — the model expresses *which* event it's waiting for, the way Inngest's
`step.waitForEvent` takes an `if` expression (or a `match` data-path shorthand).

**Two CEL surfaces — do not conflate them.** They share a language, not an
environment:

| | Coverage CEL (Appendix C) | Wait-predicate CEL (this section) |
|---|---|---|
| evaluated | statically, by the oracle | at runtime, in the drive |
| binds | `spans` (the trace) | `event` (the candidate change message) + `self` (the waiting session's correlation data) |
| purpose | the verdict | does this wake match |

**Bindings.** The candidate `event` is a Durable Streams *State Protocol* change
message — `{ type, key, value, old_value?, headers: { operation, … } }` — so a
predicate reads the same shape the state row (Spec 6) writes:

```ts
// "PR merged":
wait_for(`event.type == "github.pr" && event.value.state == "merged"`)
// correlate to this session (Inngest's `event`/`async` split; here event/self):
wait_for(`event.type == "review.posted" && event.value.issueId == self.issueId`)
// a `match` shorthand desugars to an equality `if`:
wait_for({ match: "value.issueId" })   // ≡ event.value.issueId == self.value.issueId
```

**Evaluation locus = the `matched` decision.** DS wakes the session on *any* append
to a globbed path; the drive evaluates the predicate against each new event.
Predicate-false **is** `durable.wait{matched:"false"}` → re-suspend — already gated
by `wait.nonmatch_resuspends`. So the CEL feature needs no new mechanism, only one
extra gate that a *predicated* wait resolved on a real match:

```ts
// add to durableWaitCoverage.gates:
{
  id: "wait.predicate_matched",
  description: "a CEL-predicated wait resolved on an event that satisfied the predicate",
  claim: `spans.exists(s, named(s, "durable.wait") && attr(s, "matched") == "true" && attr(s, "predicate") != "")`,
}
```

**Determinism — the one rule that keeps this Appendix-A-sound.** Journal the
predicate string with `WaitRegistered`, and record the **matched event** on wake.
Replay resolves the wait **from the journal** (the recorded match) — it does **not**
re-evaluate the predicate against a moving world. Re-evaluating live would make the
wait's outcome depend on state outside the journal, breaking replay determinism.
This is the wait-predicate analog of "don't re-mint tool-call ids on replay" (D.2).

## D.5 Cross-session join / route (the one new spec *shape*)

`spawn`-join, `wait_for` on another session's result, and `session_cancel(other)`
all need a claim Appendix C doesn't reach, because A–C are single-session: a span in
session B causally keyed to an event from session A. This is exactly flamelab's
`woz` / `linear` shape — correlate two spans through a shared, deterministic id (woz
gates `attr(t,"msg.id") == "wizard-ts-1"`). It is the only genuinely new spec shape
the surface introduces, so it's written out rather than left as prose.

```ts
// HOST_SUBSTRATE addition: "child.result" (a child publishing its terminal result
// as an event the parent waits on).
//
// Witness: parent spawns a child with a DETERMINISTIC result id ("child-1"); child
// runs and publishes its terminal result; the parent's durable.wait resolves on it.
// Mutation A (join): child does not publish (or parent waits on the wrong event) ->
// parent.woke_on_child fails -> RED. Mutation B (cancel): a cancel targeted at
// session B is delivered to the requester instead -> cancel.cross_session fails.
export const crossSessionCoverage: CoverageSpec = {
  gates: [
    {
      id: "child.published_result",         // anchor: the child reached terminal and published
      description: "the child session published its terminal result as an event",
      claim: `spans.exists(s, named(s, "child.result") && attr(s, "result.id") == "child-1")`,
    },
    {
      id: "parent.woke_on_child",           // the causal link — parent wait keyed to the child's result
      description: "the parent's wait resolved on the child's published result (the spawn-join)",
      claim: `spans.exists(s, named(s, "durable.wait") && attr(s, "matched.event") == "child-1")`,
    },
  ],
  corroborations: [
    {
      id: "cancel.cross_session",           // session_cancel(other): delivered to a session ≠ requester
      description: "a cancel was delivered to a session other than the one that requested it",
      claim: `spans.exists(s, named(s, "cancel.delivered") && attr(s, "target") != attr(s, "requester"))`,
    },
  ],
}
```

Note the correlation technique is the same one flamelab already trusts: a
deterministic id minted by the witness, asserted on both ends. The lint is happy —
`child.result`, `durable.wait`, and `cancel.delivered` are all host-substrate; the
ids are attribute *values*, never names.

## D.6 The race landmine is *defused* at this surface (the positive)

`wait_for(event, { timeoutMs })` is `race(durable.wait(event), durable.sleep(timeout))`.
If the event wins and the timer fires late anyway, the timer-wake re-drives, replays
past the already-resolved `race.settle` (winner = event, **journaled**), and the
timer branch is a dead path — absorbed, no spurious turn. So the bounded wait is
safe *because* of journaling — but only if the **winner is journaled**, which is
exactly facet (a) of the split Spec 5. Whichever **loser-fate** (facet b) you pick,
the bounded wait is correct. Good to know before agonizing over Spec 5 on the
bounded-wait's account: the part that matters here is the non-negotiable facet.

## D.7 What stays surface glue (the README's own carve-out)

The not-gated remainder is exactly what the README files *above* the substrate —
not gaps in the substrate:

- **Time parsing** (`"+2d"`, `"tomorrow 9am"` → an absolute instant). Pure surface;
  feeds `durable.sleep`'s `at`.
- **The `prompt?` fork.** Earlier I wrongly tied this to a `worker.ack{done}` choice
  — it isn't. Both the no-prompt and with-prompt paths are durable and both
  re-wake; the only difference is what *seeds* the resumed drive: no-prompt continues
  the existing continuation inline, with-prompt **appends a synthetic prompt input**
  that starts a fresh turn. At the substrate that's just "append-a-prompt-input-on-
  resume, or don't." It's observable only at the **agent** oracle as an extra
  `agent.turn` (not a substrate span), so it is gated one layer up, not in Appendix C.
- **Predicate location & selectivity.** A `wait_for` on a hot stream re-parks per
  spurious wake (claim → drive → re-suspend each time, per `wait.nonmatch_resuspends`).
  Functionally correct; the predicate's selectivity is a **cost-model** concern worth
  watching under load, not a correctness gate.

If any of these *did* need new substrate machinery, that would be the design smell
the README warns about. They don't — which is the result we wanted: the substrate
the specs describe **is** the README's substrate (same coordination model, same
wake-durable waits, the `⏸ suspended 4h` spans are literally `durable.sleep` /
`durable.wait` parks with the claim released), and the surface is a thin,
model-driven `primitive + combinator` facade over it plus one twin primitive and
one cross-session spec shape.

---

# Appendix E — A session is a handler over an external harness

A session is one **handler**, re-invoked per wake. It does not run the reasoning
loop; it materialises the committed session stream, builds a resume context, and
re-invokes the agent's **own** harness. It owns only the durable coordination
around that loop. (This supersedes the earlier "live session is a workflow"
coroutine shape: choreography is the handler model, and the agent's loop is the
one thing that cannot be journaled or owned.)

### The session entrypoint

```ts
const handleSession = Effect.fn("session.handle")(function* (wake: Wake) {
  const ctx = yield* SessionContext // coordination collections, materialised

  if (wake._tag === "Cancel") {
    yield* ctx.interrupt(wake.reason) // terminal row → `runs`; signal the harness to release
    return
  }

  // Inbox message, child result, resolved approval, observed change, or timer:
  // build the resume context from the committed session stream and re-invoke the
  // agent's own harness. The harness drives its own model loop; when it calls a
  // firegrid durable tool that must wait, that tool ends the turn (below).
  const resume = yield* ctx.resumeContextFor(wake)
  yield* ctx.driveHarness(resume) // returns when the harness's turn ends
})
```

### The two layers on the stream

The agent's session is one stream with two layers.

**Layer 1 — normalized session events.** The agent's own loop, captured by a
per-harness **normalizer (codec)** that maps the harness's native protocol to a
common `NormalizedEvent` taxonomy. The normalizer *observes* the harness's
output; it does not drive the loop, and there is one per harness protocol —
Codex, Claude Code, ACP. The reference implementation is
`durable-streams/coding-agents`: `normalize/codex.ts` and `normalize/claude.ts`
map Codex `item/completed` notifications and Claude Code stream events to
`tool_call` / `tool_result` / `text` / `reasoning`.

```ts
// Captured by the codec from the harness's native protocol — first-class durable
// events. Reference: durable-streams/coding-agents normalize/{codex,claude}.ts.
type NormalizedEvent =
  | { type: "tool_call";   toolCallId: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; output: string; isError?: boolean } // given-key (D.2)
  | { type: "text";        delta: string }
  | { type: "reasoning";   delta: string }
  | { type: "file_change"; path: string; status: string }
// One normalizer per harness protocol: codexNormalize / claudeNormalize /
// acpNormalize → NormalizedEvent[]. The agent keeps its loop; the codec captures it.
```

**Layer 2 — coordination events.** Appended by Firegrid's durable tools and the
wake-registry; the surface Firegrid authoritatively owns for replay,
at-most-once, and forge-proofing (the firelab oracle reads these).

```ts
interface CoordinationDb {
  runs:        Collection<RunRow>        // one per turn; terminal state, cancel
  toolCalls:   Collection<ToolCallRow>   // firegrid-served tool request + result; D.2 dedup
  inbox:       Collection<InboxRow>      // pending input
  childStatus: Collection<ChildRow>      // spawn/spawn_all lifecycle + result
  wakes:       Collection<WakeRow>       // registered wait-intents
  tags:        Collection<TagRow>        // named stream points (fork anchors)
  errors:      Collection<ErrorRow>
}
```

The layers are not walled off: Firegrid's `wait_for`/`spawn` are a subset of the
agent's tool calls (firegrid-served over MCP), so they appear in Layer 1 *and*
drive Layer 2. The resume context handed to a re-driven harness is the Layer-1
stream up to the commit point; what Firegrid gates is Layer 2 plus
firegrid-served tool results.

### The per-harness adapter contract

The normalizer above is the *in* half of a fuller per-harness **adapter** — the
contract `driveHarness` resolves per agent (first-hand:
`coding-agents/src/adapters/types.ts` + `{claude,codex}.ts`, vendored at
`repos/durable-streams/`):

```ts
interface AgentAdapter {
  readonly agentType: AgentType
  spawn: (o: SpawnOptions) => Promise<AgentConnection>            // start the agent's NATIVE harness
  parseDirection: (raw: object) => MessageClassification          // request | response | notification (+ id)
  isTurnComplete: (raw: object) => boolean                        // Claude `result` / Codex `turn/completed`
  translateClientIntent: (i: ClientIntent, user?: User) => object // durable intent → native message
  prepareResume: (history: StreamEnvelope[], o: ResumeOptions) => Promise<PreparedResume> // see Resume (E.5)
}
interface AgentConnection {
  onMessage: (h: (raw: object) => void) => void   // OBSERVE raw output → normalize → Layer 1 (the codec)
  send: (raw: object) => void                     // forward a translated intent to the agent
  kill: () => void; on: (e: "exit", h: (code: number | null) => void) => void
}
```

`translateClientIntent` is where native fidelity is cashed: `codex.ts` maps an
approval `control_response` to the **exact native shape per request method** —
`item/commandExecution/requestApproval` → `{decision}`, `…/fileChange` →
`{decision}`, `…/permissions` → `{permissions, scope}`, `…/tool/requestUserInput` →
`{answers}`. An ACP bridge flattens all of these into one generic permission
response — the concrete reason `coding-agents` superseded its own ACP bridge with
native protocols (see *Still open*).

**Bridge mediation rules over `send` (lift verbatim):** one prompt in flight at a
time; duplicate responses for the same pending request id are dropped
(at-most-once / D.2); **`interrupt` synthesizes cancellation responses for all
pending requests before sending the native interrupt** (= "terminal signal
recorded before cleanup"). The stream stores *intent*; the bridge is the authority
on what reaches the agent.

### The durable tools the harness calls

```ts
// wait_for — the canonical parking tool. Firegrid is not in the harness's call
// stack, so the park cannot propagate up a firegrid stack; it must end the
// harness's turn from outside the loop (see the park interface below).
const waitForTool = Effect.fn("durable.wait")(function* (event: string, prompt?: string) {
  const j = yield* Journal
  const resolved = j.find(event, "WaitResolved") // served from the journal, keyed by given id
  if (Option.isSome(resolved)) {
    yield* Effect.annotateCurrentSpan({ woke_via: "replay" })
    return ToolResult.value(resolved.value)
  }
  yield* j.append({ _tag: "WaitRegistered", key: event, predicate: event, resumePrompt: prompt })
    .pipe(Effect.withSpan("wait.register")) // firelab durableWaitCoverage.wait.intent_durable
  yield* Wake.register({ on: linkedStream(event) })
  yield* Effect.annotateCurrentSpan({ woke_via: "park" })
  return ToolResult.endTurn(`wait_for:${event}`) // wake re-drives a NEW turn with `prompt`
})

// spawn_all — N children keyed (toolCallId, slotIndex) from the ordered input;
// deterministic given-keys, so the soundness apparatus never arises here.
const spawnAllTool = Effect.fn("spawn_all")(function* (tasks: ReadonlyArray<Task>) {
  const callId = yield* (yield* SessionContext).currentToolCallId
  yield* Effect.forEach(tasks, (task, slot) =>
    Wake.spawnChild(Child("/worker", `${callId}:${slot}`), { initialMessage: task.prompt, wake: "childStatus" }),
    { discard: true })
  yield* Wake.register({ on: { collection: "childStatus", where: { parent: callId, status: "done" }, count: tasks.length } })
  return ToolResult.endTurn(`spawn_all:${callId}`)
  // race variant: wake on FIRST done + child-lifecycle policy for losers (raceCoverage)
})
```

(Illustrative firegrid idiom; not compile-ready. `ToolResult.endTurn` /
`currentToolCallId` are shapes, not committed APIs — they hinge on the park
interface below.)

### The open interface: how a parking tool ends the harness's turn

A durable wait must suspend the turn without the runtime owning the reasoning
loop. Two mechanisms:

- **(a) pending-result** — return a *pending* result and rely on the model to
  conclude the turn. No harness change, but model-behaviour-dependent (the model
  may keep calling tools); the park is not a guarantee.
- **(b) transport end-of-turn** — the binding signals a run-terminating result for
  a parking tool call; the harness treats such a call as ending its run. A small
  cooperation, still not owning the loop, and the park is a substrate guarantee.

**Recommendation: (b).** This is where the non-invasive model is cashed or lost —
a durable wait must reliably suspend a turn without the runtime owning the loop.

### E.5 — the live process

The harness's reasoning loop cannot be journaled. A crash mid-turn loses
in-process model state; recovery re-invokes `handleSession`, which re-drives the
harness from the committed stream — by reconstructing the harness's **native
resume artifact** (Resume, below), not by replaying a synthetic prompt. The
dependency: the harness must (1) emit a structured native event stream a
normalizer can map (Codex / Claude / ACP all do) and (2) be re-drivable from a
resume artifact reconstructed from that stream. That is the cost of "the agent
keeps its own loop"; it is the bet, so pay it.

### Resume — reconstruct the native artifact from the stream, then resume natively

(First-hand: `coding-agents/src/adapters/{claude,codex}.ts` `prepareResume`,
vendored at `repos/durable-streams/`.) The reference does **not** replay history as
a synthetic prompt, and does **not** use ACP `session/load` (which reads local
JSONL that dies with the sandbox). It **reconstructs each agent's native resume
state from the durable stream, then resumes natively** — portable *and*
full-fidelity:

- **Claude** — scan the stream for the agent `system` event → `session_id` + `cwd`;
  **rebuild the transcript JSONL** at `~/.claude/projects/<cwd>/<id>.jsonl` from the
  stream (rewriting session-ids + paths), then `claude --resume <id>`. Cross-cwd
  fallback: Claude rejects a synthetic resume id in a *new real* cwd → **seed a real
  session** (spawn, prompt "OK", await turn, write a Stop signal) and write the
  rewritten transcript into the seeded session's path (`forceSeedWorkspace`).
- **Codex** — scan the stream (reversed) for the agent **thread id** → native
  `thread/resume { threadId }`. No reconstruction needed.

`prepareResume(history, { cwd, rewritePaths }) → { resumeId, forceSeedWorkspace?,
resumeTranscriptSourcePath? }` is the per-harness contract (see the adapter
contract above); **path-rewriting** for cross-sandbox mounts is part of it.
Firegrid sandboxes agents, so this *reconstruct-from-stream → native-resume*
pattern is the one to lift — over both prompt-replay and `session/load`.

### E.6 gates (un-specced)

`observation.durable` (every coordination row lands before ack);
`attach.not_replayed` (re-driving the harness is ensure-live, not a journaled
step). `session.*` spans stay un-gated.

---

# Sources & provenance

External and internal references, marked by how the claims were verified — since
the execution-model pivot rests on what other Durable-Streams runtimes do, the
distinction between first-hand and reported matters.

### First-hand (fetched / read directly)

- **Durable Streams protocol + repo** — `github.com/durable-streams/durable-streams`
  ("the data primitive for the agent loop"); `PROTOCOL.md` (multi-writer
  `Stream-Seq` fencing, offset resumability, exactly-once delivery). The §x.y.z
  section references in Part 3 / Appendix C are to this protocol.
- **`coding-agents` non-invasive normalizer** — PR #317 "[Draft]: Stream agent",
  `packages/coding-agents/src/normalize/{codex,claude}.ts`, `protocol/codex.ts`,
  `normalize/types.ts` (`NormalizedEvent`, `ToolResultEvent = { type, toolCallId,
  output, isError? }`). This is the reference implementation for the codec / Layer
  1 and the concrete evidence for the external-harness model.
- **`coding-agents` adapter contract + resume + design specs** — vendored at
  `repos/durable-streams/packages/coding-agents/` and read line-by-line:
  `src/adapters/{types,claude,codex}.ts` (the `AgentAdapter` contract, the
  per-request approval-fidelity mapping, and `prepareResume` —
  Claude transcript-reconstruction + `--resume` + seed-fallback, Codex
  `thread/resume`); `src/{bridge,types,agent-db-schema}.ts` (3-envelope stream,
  forwarding rules, `@durable-streams/state` collections); and the design specs
  `docs/superpowers/specs/2026-03-31-durable-streams-acp-bridge-design.md` +
  `2026-04-01-coding-agents-design.md` (the ACP→native supersession). Built on
  `@durable-streams/state` — the same package `effect-durable-operators` consumes
  (`.dependency-cruiser.cjs` `effect-durable-operators-state-only`), so the codec /
  projection layer is a substrate *lift*, not a reimplementation.
- **Electric Agents overview** (the *owned-loop* model, for contrast) —
  `electric.ax/docs/agents`: entities wake on message/child/state/time, the runtime
  runs `handler(ctx, wake)`, `ctx.useAgent()` → `ctx.agent.run()`, built-in
  collections (runs/steps/texts/tool calls/errors/inbox), `spawn`/`send`/`observe`.

### Reported (second-hand source-reading; confirm before lifting)

From a companion note that read `repos/electric` source; **not** independently
verified here (GitHub's pinned trees block automated fetch):

- `agents-runtime/entity-schema.ts` (the full built-in collection taxonomy),
  `runtime-server-client.ts` `registerWake`, `agents-client.ts` `observe`.
- `agents-server/scheduler.ts` + `wake-registry.ts` (the scheduler / wake-registry
  split — the timer-source architecture in build step 8), cron, `/schedules/:id`.
- `agents-server/routing/entities-router.ts` — the `/_electric/entities/...` RPC
  surface, `POST /fork` (`fork_pointer`), `/tags/:key` (build steps for the
  external control surface).
- `agents-runtime/tool-providers.ts` — MCP tool loading (a declarative `mcp.json`
  loader was *not* located; treat as unconfirmed).

These are *architecture references* for the shared substrate and the control
surface, not load-bearing for the model decision. Confirm against source before
building on them (see *Still open*).

### Internal (your repos)

- The SDD (build order owner), `fluent-coverage-specs.ts` (the acceptance gates),
  `tf-n3qc-substrate-verification.md` (verified substrate properties), the Firegrid
  README (the product surface and the choreography invariant), the Durable Streams
  State Protocol RFC (Spec 6 / `state.cas`).

### Reference idioms

- Effect-TS skills — `github.com/Effect-TS/skills` (`Effect.fn`, `Effect.Service`,
  `acquireRelease`/`scoped`, `catchTag`, Schema/`Schema.TaggedError`). The Effect
  sketches were checked against these.
