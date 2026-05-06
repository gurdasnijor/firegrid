# Firegrid Effect-TS Data-Types Review — 2026-05-05

Review scope: idiomatic use of Effect's data-type primitives — `Option`,
`Either`, `Cause`/`Exit`, `Data`/`TaggedEnum`/`TaggedError`, `Chunk`,
`Duration`/`DateTime`, `HashMap`/`HashSet`, `Redacted`, `Brand` — across
`packages/{substrate,runtime,client}`. Tests, scripts, docs, lab `.tsx`,
and previously-cited code-style findings (Schema.TaggedError migration)
are out of scope.

The substrate is in good shape on the error-management half of "data
types" — every domain error extends `Data.TaggedError`, and
`Cause`/`Exit` introspection is used in the right places. The thinnest
spot is **Data.TaggedEnum**: at least six public unions are hand-rolled
`{ kind: "x" } | { kind: "y" }` literals matched with `if (x.kind ===
"y")` chains or ternary selects. The detector reports 61 hits clustered
under `discriminated-unions/rule-001`. Next-highest-leverage: consolidate
the four `Cause.isInterruptedOnly` log gates and tighten `Either`
plumbing in `operator.ts`. Branded IDs and `Duration` use are fine;
`Redacted` is unused but the only secret-shaped surface
(`streamUrl`) belongs to the configuration review.

---

## Findings by concept

### Option

Idiomatic, with one structural smell. No nested `Option.match`
pyramids exist anywhere.

`subscribers.ts:128-136` defines `buildOrSkip` mapping a tagged-error
builder to `Option`; `Option.isNone` is checked at every call site
(`:208, :378, :406`). The "build → test isNone → return none → append on
some" sequence repeats three times — code-style, not an Option misuse,
because both branches do real work.

`subscribers.ts:187` (`outcomes.flatMap(Option.toArray)`) and
`event-stream-materializer.ts:170` (`Option.fromNullable` inside
`Stream.filterMap`) and `event-client.ts:160-162` (`Option.none/some` in
`Stream.filterMapEffect`) are all correct.

`projection-service.ts:75` falls back to a raw `_tag === "Some"` test
inside `Effect.flatMap` after `Stream.runHead`:

```ts
opt._tag === "Some"
  ? Effect.succeed(opt.value)
  : Effect.fail(input.timeout(query.label, Duration.zero))
```

The literal `_tag` discriminator on `Option` is the only one of its
kind in the substrate. Replace with `Option.match(opt, { onNone: () =>
Effect.fail(...), onSome: Effect.succeed })`.

### Either

`operator.ts:148-205` is the only non-trivial Either site. The handler
result is captured with `Effect.either`, then a second `Effect.either`
wraps the state-machine builder; `Either.isRight(handlerResult)` is
re-tested four times across the 50-line gen block (`:148, :168, :172,
:192`). Two idiomatic improvements:

1. `:167-171` is `Either.match(handlerResult, { onLeft: failRun, onRight:
   completeRun })` — the `as` ladder disappears.
2. The whole section is a textbook `Effect.matchEffect` target. Rather
   than `Effect.either(handler)` + case analysis, a single
   `handler(item).pipe(Effect.matchEffect({ onSuccess, onFailure }))`
   keeps the typed error in the failure channel and removes one Either
   round trip. The current shape was required when builders were
   synchronous; `completeRunEffect`/`failRunEffect` per
   `operation-handler.ts:6-7` mean the round trip is no longer
   load-bearing.

`retained-records.ts:48-63` (`decodeUnknownEither` + `Either.isLeft`
inside a for-loop) is the right call — hot fold, structural Either,
clean lift to Effect via `Effect.fail`. Leave it.

`state-machine.ts:39-45` — `runUnsafe` using `Either.isLeft` to throw is
flagged in the code-style review.

### Cause / Exit

Four sites check `Cause.isInterruptedOnly`:
`runner.ts:181`, `operation-handler.ts:159, :210`,
`event-stream-materializer.ts:184`, `choreography/tools.ts:177`. The
three runtime sites share the same `tapErrorCause(cause => isInterruptedOnly
? void : logError(label, cause))` shape — textbook "die loudly except on
shutdown". A single shared `tapErrorCauseUnlessInterrupted(label)`
helper concentrates the observability seam (span status, error metric)
when it lands.

`operation-handler.ts:134, :161` are the only places that inspect
`Exit` / `Option` `_tag` literals:

```ts
if (exit._tag === "Success") { ... }
const errorPayload = failure._tag === "Some" ? failure.value : cause
```

These are `Exit.match` and `Option.getOrElse(failure, () => cause)`.
Both replacements are syntactic, but this is the runtime's most-touched
dispatch loop, so the consistency win is real.

`choreography/tools.ts:169-199` correctly uses `Effect.matchCauseEffect`
on the suspending call.

### Data / TaggedEnum / TaggedError

**Highest-leverage finding.** Every public discriminated union in the
kernel is hand-rolled with a `kind` literal, and consumers branch with
`if`/ternary chains. Each is a textbook `Data.TaggedEnum` candidate:

- `operator.ts:29-63` — `ClaimOutcome<A,E>` (5 variants). Constructed
  at `:124, :140, :159, :180, :194, :201`; consumers in `runtime/`
  inspect `.kind`.
- `subscribers.ts:61-63` — `ProjectionMatchEvaluation`
  (`match`/`no-match`). Consumed at `:397`.
- `subscribers.ts:142-145` — `DueTimeDecision`
  (`data-error`/`skip`/`resolve`). Built at `:217-228, :233-246`,
  consumed via `if` chain at `:198-204`.
- `subscribers.ts:300-302` — `ProjectionMatchOutcome`. Consumed via
  ternary `flatMap` at `:334-335` (detector flagged exactly these as
  `conditionals/rule-010`).
- `facade/work.ts:38-44` — `ClaimAttemptOutcome` (`won`/`lost`).
  Consumed at `:109`.
- `choreography/triggers.ts:33-35` — `TriggerMatchEvaluation`.

Migrating to `Data.TaggedEnum` does three things at once: removes every
`as const` at construction, unblocks `Match.tag`/`Match.tags` (owned by
the pattern-matching review), and gives every variant `Equal`/`Hash`.
The convention is `_tag` rather than `kind` — a deliberate, mechanical
rename across construction and consumer sites; worth doing in one
sweep.

**`ChoreographyTrigger`** at `choreography/triggers.ts:25` is already a
`Schema.Union` of `Schema.TaggedStruct` — Schema-flavoured Data.TaggedEnum
and fine. `dispatchTrigger` at `:81-89` is a hand-written switch over
`_tag`; `Match.tag` removes the "TS will require the new case" comment
in favour of compile-time exhaustiveness.

**`Data.TaggedError`** is uniform across the repo (15 classes). The
Schema.TaggedError migration is owned by the code-style review; one
consistency note — runtime/client packages use slash-prefixed
`"firegrid/..."` tags (`event-stream-materializer.ts:48,54`,
`operation-client.ts:66,73,81,88`) while substrate kernel uses plain
names (`SubscriberStreamError`, `ClaimStreamError`, `AcquireDbError`).
Worth a single naming pass alongside that migration.

### Chunk

Not used anywhere outside Effect's own internals. The repo's stream
work is `Stream`-flavoured (`Stream.async`, `Stream.mapEffect`,
`Stream.runDrain`) and the Stream API hides Chunk behind transformer
shapes — that is correct and there is no Chunk-shaped opportunity here.

### Duration / DateTime

`Duration` use is consistent and idiomatic.
`choreography/service.ts:251, 284` uses `Duration.toMillis(Duration.decode(input))`
for the kernel-millis bridge; `runner.ts:154` uses `Duration.millis`
for `Effect.sleep`; `projection-service.ts:81` uses `Duration.decode`
for the timeout option; `facade/projection.ts:35`,
`event-plane/projection.ts:29`, and `choreography/errors.ts` carry a
`Duration.Duration` field on tagged errors (which is the correct
type — `DurationInput` belongs to API surfaces, `Duration` to data).

`DateTime` has zero usage. The kernel intentionally stores wall-clock
timestamps as `number` milliseconds (per
`durable-records-and-projections.RECORDS.4` and `waits.ts:175, :198`)
because the durable rows must JSON-serialize. That is the right call
and `DateTime` would not improve it.

`Date.now()` direct usage: **one site** at
`client/src/firegrid/event-client.ts:104`:

```ts
const nextEventId = (): string =>
  `${Date.now()}:${Math.random().toString(36).slice(2)}`
```

This is both `Date.now()` and `Math.random()` outside an Effect, in a
service used inside Effect code. It runs at append time so it is
non-deterministic in tests. Replacement: `Effect.gen` over
`Clock.currentTimeMillis` and `Random.nextIntBetween` (or wrap the
existing closure in `Effect.sync` so test layers can override). The
review brief explicitly asked for this site to be flagged.

### HashMap / HashSet

Not used. `subscribers.ts`, `runner.ts`, and the projection facades all
work over `ReadonlyMap` because the underlying `@durable-streams/state`
collection iterators emit native `Map`/`Set`. Adopting `HashMap` would
require a copy-in/copy-out step at every snapshot boundary — it is the
wrong tradeoff for hot-path snapshot reads. Leave as-is.

### Redacted

Zero usage. The configuration review flagged that `streamUrl` may
carry credentials in production deployments
(`firegrid/operation-client.ts:200`,
`firegrid/event-client.ts:108`); that is the only Redacted candidate
in the repo. Cross-reference that review; not duplicated as a finding
here.

### Branded

`choreography/branded.ts:14-21` defines `WorkId`, `CompletionId`,
`OwnerId` as `Brand.nominal<...>()` — cheapest, most idiomatic shape.
`descriptors/operation.ts:57-59` does the same for
`OperationHandleId`. All four are correct.

The R9 framing on kernel `runId`/`claimId` strings
(`schema/rows.ts:36-43, 88-94`) is still right. Authority rows are
JSON-shaped Schemas; `runId: Schema.String` is also the wire-decode
surface. Adding `pipe(Schema.brand("RunId"))` would shift the decoded
type across every consumer. The choreography facade adopts brands at
the call boundary, which is exactly where nominal typing is valuable.
Keep R9: brands at the choreography boundary, plain strings at the
durable-row boundary.

---

## Out of scope (already covered by other reviews)

- **Schema.TaggedError vs Data.TaggedError migration** — owned by the
  code-style review (#1 carry-forward).
- **`Match.tag` adoption** for the `_tag` and `kind` discriminator
  switches — owned by the pattern-matching review.
- **`Redacted` for `streamUrl`** — owned by the configuration review.
- **`Clock.currentTimeMillis` + raw `number` math** in `subscribers.ts`
  / `runner.ts` / `waits.ts` — acknowledged as intentional per the
  brief; durable rows store wall-clock millis.
- **Lab `.tsx` `useState`** — explicitly carved out.

---

## Top 5 highest-leverage idiomatic improvements (ranked)

1. **Convert hand-rolled `kind`-discriminated unions to `Data.TaggedEnum`.**
   Highest-leverage by far. Six sites:
   - `substrate/src/operator.ts:29-63` (`ClaimOutcome`)
   - `substrate/src/subscribers.ts:61-63, :142-145, :300-302`
   - `substrate/src/facade/work.ts:38-44` (`ClaimAttemptOutcome`)
   - `substrate/src/choreography/triggers.ts:33-35` (`TriggerMatchEvaluation`)
   Removes `as const` clutter, gives every variant `Equal`/`Hash`,
   and unblocks the pattern-matching review's `Match.tag` migration.

2. **Replace the `Either.isRight`/`Either.isLeft` ladder in
   `operator.ts:148-205` with `Effect.matchEffect` over the handler
   call**, and `Either.match` over the build step. Eliminates two
   `Effect.either` round trips and removes the four-times-repeated
   handler-result discriminator branch.

3. **Extract a shared `tapErrorCauseUnlessInterrupted(label)` helper**
   for the four near-identical "log loud unless this is an interrupt"
   sites: `runner.ts:181`, `operation-handler.ts:159, 210`,
   `event-stream-materializer.ts:184`. One-line bodies, but the
   consistency wins when observability lands (span status, error
   metric).

4. **Replace `Date.now()` + `Math.random()` in
   `event-client.ts:103-104` with `Clock.currentTimeMillis` +
   `Random.nextIntBetween` inside an `Effect.gen`** (or wrap the existing
   closure in `Effect.sync` so test layers can override). The only
   non-deterministic-time site outside the explicitly-acknowledged
   substrate kernel callers.

5. **Replace `_tag === "Some"` / `_tag === "Success"` literal probes
   in `operation-handler.ts:134, :161` and `projection-service.ts:75`
   with `Exit.match` / `Option.getOrElse`.** Three sites, all
   purely syntactic, but they are the only places in the repo that
   inspect Effect's data-type discriminators by their literal `_tag`
   string — a clear inconsistency against the rest of the codebase.

---

## What strict-baseline already enforces vs gaps

**Enforced (R0-R-STRICT-BASELINE detectors):**

- `discriminated-unions/rule-001` flags every hand-rolled `_tag` /
  `kind` literal union — 61 hits in the cached detector run, mostly
  the same six places listed above.
- `conditionals/rule-010` flags ternary discriminators — already
  visible in the detector's `subscribers.ts:334, :335, :365, :371`
  hits.
- `conditionals/rule-006` flags nullable handling that should use
  `Option.match` or `Option.fromNullable` —
  `subscribers.ts:91, :99, :219, :238, :354, :366`. These are kernel
  decode paths and the R-STRICT-BASELINE chose to defer them; the
  data-types lens flags them as Option-shaped but agrees they are
  defensible against the wire-decode boundary.

**Not enforced — gaps:**

- No detector for "Cause.isInterruptedOnly used without a shared
  helper" (finding #3 above). Plain pattern-matching would catch the
  duplication, but the data-types axis is the wrong place to add a
  detector.
- No detector for `Date.now()` / `Math.random()` direct usage
  (finding #4). The configuration review noted `Clock` adoption is
  policy-uniform in the substrate but not in the client; a small
  detector could close this.
- No detector for `Either.isLeft` / `Either.isRight` ladder vs
  `Either.match` / `Effect.matchEffect`. The current operator.ts
  shape passes every existing rule but the pattern-matching review's
  `Match.value` rule would catch the build-step branch at
  `operator.ts:167-171` if extended to Either.
- `Data.TaggedError` namespace consistency
  (`firegrid/...` vs plain) is not a detector concern, but is worth
  a one-line lint at the next review pass.

The repo's data-types posture is fundamentally healthy: errors are
tagged, IDs are branded where they cross facades, `Duration` is used
for time spans, and `Option` / `Either` /`Cause` / `Exit` are present
in roughly the right places. The remaining work is consolidation, not
correction — five mechanical edits land an unambiguously more
idiomatic v1.
