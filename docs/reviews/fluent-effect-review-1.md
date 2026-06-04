# fluent-firegrid: Effect redesign + durability gaps — design handoff

A synthesis of a review covering two asks (API redesign on Effect; the team's
issues table) plus a clarification on what the Durable Streams pull-wake
protocol already provides. The reader is assumed to have the `fluent-firegrid`
source and the restate-sdk-gen source it was ported from.

---

## TL;DR — three takeaways

1. **Switch to named journal keys.** That single change deletes the bespoke
   `Operation` / `Future` / `Scheduler` / `Awaitable` / current-fiber-slot layer.
   `run` becomes a plain `Effect` over a `Journal` service; combinators become
   `Effect.all` / `Effect.fork` / `raceAll`. This is the entire API win, and it
   makes four deferred tutorial tiers nearly free.

2. **The 8-row issues table is 3 primitive families:** durable park/wake,
   fenced append, and Layer-provided activity. Most of park/wake and *all* of
   fenced-append are server-provided, not things you build.

3. **Durable Streams §7.2/§7.3 pull-wake *is* your wake/lease/fencing
   subsystem.** The only genuinely net-new infrastructure is a *scheduled-append
   timer source* for durable `sleep`. Everything else event-driven (work, cancel,
   webhook ingest, child sessions) rides the subscription machinery you already
   have.

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
| `any` | `Effect.firstSuccessOf` / `Effect.raceAll` |
| `select` | thin tag wrapper over `Effect.raceAll` |
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

- **Genuinely new subsystem you build:** the durable park/wake protocol + the
  worker loop (rows: sleep, pull-wake/webhook, cancellation-delivery, the
  durable half of child-session). All of these are the same shape — "append a
  fact, park on a `Deferred`/subscription, get woken by the leased worker." Build
  it **once**. *(But see Part 3 — most of this is the server's, not yours.)*
- **Substrate change in `effect-durable-streams`, not an API change:** fenced
  append (journal idempotency, state CAS, closure terminal records).
- **Falls out of Part 1 for free:** Layers (sandbox) and in-process interruption
  (in-process cancellation).

---

## Part 3 — Durable Streams §7.2/§7.3 already *is* the wake subsystem

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

## Build order

1. **Named-key `step` primitive as an `Effect.Service`** (Part 1). The
   foundation; everything hangs off it. Deletes the DSL layer.
2. **`FencedWriter` in `effect-durable-streams`** (§5.2.1). Substrate change
   below the API; `Journal.step` threads it.
3. **Terminal records + close for finite handlers** (closure semantics) so
   readers distinguish done from idle.
4. **Worker loop**: `Stream` over the wake_stream → claim → replay → drive →
   ack. §7.3 fencing is the server's; the in-process `Semaphore` throttle is
   yours. Put the timer source behind a `Timer` Tag so it composes.
5. **Scheduled-append timer source** — the one net-new infra (DO alarm on
   Cloudflare; timer-wheel elsewhere).
6. **Layers for providers** (sandbox) — falls out of Part 1.

Decide the `race`/`select` loser semantics (Part 1 landmine) before wiring the
combinators, since it changes whether losers journal.

---

## Included as appendices

- **Appendix A** — the named-keys decision written as a falsifiable finding in
  the spec-evidence idiom (decision span / tripwire / witness run / mutation
  harness). The one claim to ratify on tiny-firegrid before the cutover.
- **Appendix B** — the durable-`sleep` + worker-loop pair as a full-Effect sketch
  (the `Timer` source behind a Tag; claim → replay → drive → ack). The spans it
  emits are exactly the ones Appendix C gates on.
- **Appendix C** — the durability semantics as flamelab-style `CoverageSpec`s: the
  host-substrate span vocabulary the substrate must emit, plus the gates (each with
  its mutation harness) that lock the semantics. Reuses flamelab's
  oracle / lint / vacuity machinery verbatim against a fluent-firegrid trace.
- **Appendix D** — the README's agent surface (`wait_for` / `wait_until` / `sleep` /
  `spawn` / `spawn_all` / `execute`) reduced to `primitive + combinator` over the
  substrate: the per-tool table, the one new primitive (`durable.wait`), the one new
  spec *shape* (cross-session join/route), CEL predicates for `wait_for` (Inngest
  parity), and where the surface vindicates vs. taxes the earlier findings.
- **Appendix E** — a live agent session expressed as a *workflow*: the
  `gen`/`select`/`spawn`/`run` body that owns its live process for the span it is
  actively running, journals its output inline, and fans out tool/permission
  reactions as children. The live process is the one non-journalable thing;
  everything else is just the substrate primitives — no adapter, no registry, no
  side daemon.

## Still open

- Stand up the flamelab-style runner over fluent-firegrid — the driver + Control +
  infra seam, the analog of flamelab's `host.ts` / `lab.ts`. tiny-firegrid is the
  natural home: it already plays the architectural oracle for the *shape*; this
  makes it the oracle for the *semantics* too.
- Pick the `race`/`select` **loser-fate** semantic (Appendix C, Spec 5, facet b)
  before wiring the combinators; the spec is written for "losers journal" and notes
  the inverse. The **winner-record** facet (a) is not a choice — gate it regardless.
- Add `durable.wait` (Appendix D.3) — it is load-bearing, not polish: four of the
  six surface tools bottom out in it.
- Write the session-workflow body (Appendix E) on the substrate primitives — the
  live process is a resource the workflow owns and re-establishes on resume; output
  is journaled inline by the body. No separate adapter or registry layer.

---

# Appendix A — Named keys as a falsifiable finding (spec-evidence idiom)

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

# Appendix B — Durable `sleep` + worker loop: full-Effect sketch

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

# Appendix E — A live session is a workflow, not an adapter

A live agent session is **itself a durable workflow** — the same shape as the
saga / fan-out / timeout patterns, written as a `gen` body over the substrate
primitives. The live process is the one thing that cannot be journaled; everything
else — sending, observing output, reacting, waiting — is `run` / `select` / `spawn` /
`durable.wait`. There is no adapter, no registry, and no side drain.

```ts
const session = (id: string): Operation<Outcome> =>
  gen(function* () {
    // The live agent is a resource this workflow OWNS for the span it runs. It is
    // not journalable, so on a resume the body simply re-establishes it — there is
    // no registry to consult. This is the only non-journaled operation in the body.
    const agent = yield* useAgent(id)

    while (true) {
      // The ONLY durable suspension is between turns: park for the next input or a
      // cancel. (The `select` timeout/cancel shape from the patterns.)
      const ev = yield* select({
        input:  durable.wait(inputs(id)),       // wake on an append to the input stream
        cancel: durable.wait(cancel(id)),
      })
      if (ev.tag === "cancel") return { _tag: "Cancelled" }

      // Named-key step (Appendix A): a replayed send is served from the journal,
      // never re-issued to the live process — so re-driving a turn never double-prompts.
      yield* run(`send:${ev.input.id}`, agent.send(ev.input))

      // Drain THIS turn inline, as ordinary control flow. Reading each output is a
      // journaled step, so the observation is durable the instant it is read — the
      // journal IS the drain. Tool calls / permission gates fan out as supervised
      // children, the literal `spawn(worker)` shape.
      let seq = 0
      while (true) {
        const out = yield* run(`out:${ev.input.id}:${seq++}`, agent.nextOutput())
        if (out.kind === "turn_end") break
        if (out.kind === "tool_call")  yield* spawn(runTool(id, out))
        if (out.kind === "permission") yield* spawn(gate(id, out))
      }
      // turn done — loop back to the durable park
    }
  })
```

Why this is enough, and why it is light:

- **Within a turn the body is *running*, not suspended** — so the live process only
  has to survive the span the body is actively driving it, which it trivially does.
  Cross-suspension resource survival was the only thing that forced a host-scoped
  registry, and it is not a correctness requirement. The process's needed lifetime
  is exactly the body's active span.
- **The only durable suspension is between turns** — `select` over `durable.wait`.
  There the process can simply be dropped; `useAgent` re-establishes it on the next
  input. A worker that keeps its lease across turns keeps it warm as an
  *optimization*, never a requirement.
- **Output observation is the workflow.** Each `run("out:…", agent.nextOutput())`
  journals the output as it is read; a replay serves the journaled outputs in order
  to the same `turn_end`. No forked daemon, no separate output table to reconcile.
- **Reactions fan out with `spawn`** — a tool call or permission gate is a child the
  body supervises, exactly the fan-out pattern, not a sibling workflow some observer
  has to trigger.
- **Long waits are just `durable.wait` / `durable.sleep` in the body** — an approval
  hours away suspends the session the same way a between-turns park does; the process
  drops and re-establishes on wake. The README's `wait_for` / `sleep` (Appendix D)
  are these calls.

The one physics cost, stated plainly: a process is not journalable, so a turn
interrupted by a crash re-drives from its journaled input — the body re-runs the
turn — and a *stateful* agent re-established cold has lost its in-process
conversation memory; re-establishing it means replaying the journaled prompt history
into the fresh process, or a resume the agent itself supports. That is a property of
the agent, not the substrate, and a warm cross-turn process never pays it. None of it
needs an adapter or a registry — re-establishment is just `useAgent` running again
inside the body.

Coverage: the body emits the same `journal.step` / `durable.wait` host-substrate
spans Appendix C already gates, so the replay and wake specs cover a session
unchanged. The one span worth adding is `useAgent` — it must carry
`served != "journal"` (a live resource is re-established, never replay-served); I can
write that gate into Appendix C on request.