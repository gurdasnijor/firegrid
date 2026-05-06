# Effect-TS Core Idioms Review — Firegrid

Date: 2026-05-05
Scope: production source under `packages/*/src` and `apps/*/src` post R0-R-STRICT-BASELINE
Reference skill: `claude-skill-effect-ts/skills/effect-core` (and neighbors `code-style`,
`data-types`, `error-management`)
Scope exclusions: anything covered in `docs/REVIEW_EFFECT_CODE_STYLE_2026-05-05.md`
(general formatting, Schema-first, Match-first, do-notation idioms). This review
focuses on the *fundamental composition idioms* of the Effect type itself.

## Summary

The Firegrid codebase shows a mature, conservative use of Effect's core
composition surface. `Effect.gen` is the dominant idiom for sequential code
(53 occurrences across production), `pipe` is reserved for short transformer
chains following a generator block (71 `.pipe(` occurrences, of which the
overwhelming majority are tail-position `.pipe(Effect.mapError(...))` or
`.pipe(Effect.provide(...))` shapes), and the run-boundary discipline is
honored: only three production `Effect.run*` sites exist, all in
`apps/lab/src/lab/LabEventStreamPanel.tsx` (the React boundary), with
`Effect.runSync` confined to the `state-machine.ts` compat shim
(`packages/substrate/src/state-machine.ts:39-45`). The boundary is documented
correctly per the R0 baseline.

The most striking finding is what is *absent* rather than what is wrong:
zero uses of `Effect.andThen`, zero uses of `Effect.all`, and zero uses of
`Effect.match`/`Effect.matchEffect`. The codebase chooses `Effect.flatMap` +
`Effect.gen` exclusively for sequencing and uses `if/return-yield* fail` in
generators rather than match-style branches. The lone exception is the
`Effect.matchCauseEffect` in `packages/substrate/src/choreography/tools.ts:169`,
used correctly to discriminate suspension-by-interrupt from defects.

A handful of localized concerns are documented below; none are blockers.

## Findings

### 1. Effect.gen vs pipe — ratio is healthy; one flatten candidate remains

Counts in production (excluding tests, including barrel files):
53 `Effect.gen(...)`, 71 `.pipe(` invocations.

Single-yield `Effect.gen` candidates were enumerated programmatically;
seven blocks contain exactly one `yield*`. Six are correctly shaped (they
hold a non-trivial body around the yield):

- `packages/runtime/src/runtime/internal/operation-handler.ts:198` — the
  one yield sits inside a `for (run of snapshot.runs.values())` loop, so
  it dispatches once per matching run; flatten would lose the loop.
- `packages/substrate/src/choreography/tools.ts:184` — yield happens
  inside `Effect.matchCauseEffect.onFailure`'s gen, with bookkeeping
  before/after.
- `packages/substrate/src/waits.ts:136` — `findExisting` does a
  `tryPromise` yield then a `.completions.get(...)` lookup; the gen
  exists to thread the typed `WaitsStreamError` channel.
- `packages/substrate/src/waits.ts:223` (scheduleWork) — single yield is
  on append; randomUUID + struct construction live around it.
- `packages/substrate/src/subscribers.ts:319` —
  `runProjectionMatchSubscriberFromSnapshot` returns a derived shape from
  a single scan call; flatten possible (see point below).
- `apps/lab/src/lab/LabEventStreamClient.ts:45` — the gen yields
  `EventStreamClient` and immediately returns the stream; flatten target.

One genuine flatten candidate that was missed:
`packages/client/src/firegrid/operation-client.ts:283-292` —
`observe` wraps `Stream.unwrapScoped(Effect.gen(...))` where the gen
yields `SubstrateClient` and returns a stream literal. This collapses to
`Effect.map(SubstrateClient, (client) => ...)` and the outer
`Stream.unwrapScoped` becomes `Stream.unwrap` (the only scoped resource
— the client — is provided by the surrounding `Stream.provideLayer`).

`apps/lab/src/lab/LabEventStreamClient.ts:36-39` and
`packages/substrate/src/subscribers.ts:319-337` are similar shape: a
service Tag yield then a derived shape return. They are slightly more
load-bearing (the latter does flatMap-then-shape) but
`Effect.map(Tag, fn)` is the canonical post-R0B form.

No `Effect.gen(this, function* () { ... })` form is used anywhere in
production code. Class-method generators (e.g. inside Layer effects)
consistently use the bare `Effect.gen(function* () { ... })`. Good.

Deep-nested pipe chains converted to gen: the only deep pipe chains
that remain are tail `.pipe(Effect.X, Effect.Y, Effect.Z)` shapes
attached to a preceding gen block (e.g. `runner.ts:160-165`,
`runner.ts:169-185`, `stream-resolver.ts:75-77`). These are idiomatic —
they read top-to-bottom and the linear shape matches the call graph.

### 2. Effect.succeed / fail / sync / try / tryPromise / promise — correct boundary placement

`Effect.tryPromise` is used at every external Promise boundary
(`@durable-streams/client`, `DurableStreamTestServer`, `rebuildProjection`).
Each call site correctly maps the catch into a tagged error class.
13 sites, all idiomatic.

`Effect.promise` (the *defect-on-rejection* counterpart) appears twice:
- `packages/runtime/src/runtime/internal/event-stream-materializer.ts:113`
  (`response.cancel()` finalizer)
- `packages/runtime/src/runtime/internal/stream-resolver.ts:75`
  (`s.stop()` finalizer for the test server)

Both are *finalizer* invocations inside `Effect.acquireRelease`, where
the outer effect cannot meaningfully recover from a cancel/stop failure
and surfacing them as defects is appropriate. Correct.

`Effect.try` appears once
(`packages/substrate/src/choreography/service.ts:207`). This wraps the
*compat-shim* `blockRun` from `packages/substrate/src/state-machine.ts`,
which is the documented `Effect.runSync(Effect.either(...))` shim that
throws on illegal transitions. Wrapping a throw-style API with
`Effect.try` is correct — the surrounding choreography facade does not
want the typed `IllegalRunTransition` to leak as a typed error in this
path.

`Effect.fail` and `Effect.succeed` are used inside generators
(via `yield* Effect.fail(...)`) or short pipe tails — never as
top-level constants the caller would need to `yield*`. Good.

### 3. andThen vs flatMap vs map — `andThen` is missing entirely

Production has zero uses of `Effect.andThen` and 27 uses of
`Effect.flatMap` / `Effect.map(`. The data-first-friendly `andThen` —
which collapses `flatMap` and `map` (and a constant-Effect overload)
into one operator — is not part of the team's vocabulary.

This is not a bug, but it is an idiomatic gap. Two cases stand out
where `andThen` would tighten the code:

- `packages/client/src/firegrid/operation-client.ts:281` —
  `send(op, input).pipe(Effect.flatMap((handle) => result(op, handle)))`.
  `andThen((handle) => result(op, handle))` is identical at runtime
  and matches the dual-friendly idiom.
- `packages/runtime/src/runtime/internal/operation-handler.ts:147` and
  `:178` — `completeRunEffect(...).pipe(Effect.flatMap((event) =>
  appendEvent(stream, event)), Effect.catchAll(...))`. The flatMap here
  is correct; `andThen` would also work and read more linearly.

`Effect.map` is used correctly throughout — only when the
transformation is a pure function from `A` to `B`. No misuses observed
(e.g. no `Effect.map((a) => Effect.succeed(...))` patterns hiding
flatMaps).

### 4. Effect.all variants — zero uses in production

Production has no uses of `Effect.all` for parallel composition.
Where multiple values must be assembled, the codebase uses sequential
`yield*` inside `Effect.gen`. That is sequential by definition.

For Firegrid's domain (single-stream durable producer/consumer with
strict ordering on appends) this is *probably correct* — concurrent
appends to the same DurableStream are not what most call sites want.
The `Effect.forEach` calls in `packages/substrate/src/subscribers.ts:183-186`
are sequential (no `{ concurrency: ... }`), which matches the comment
"sequential forEach, race-safe build".

Flagged for awareness, not change:
- `packages/runtime/src/runtime/internal/stream-resolver.ts:162-163` —
  the embedded resolver yields `EmbeddedDurableStreams` then
  `DurableStreamAdmin`. These are independent service Tags;
  `Effect.all({ embedded: EmbeddedDurableStreams, admin: DurableStreamAdmin })`
  is the canonical form. Today's two-yield gen is functionally
  identical and arguably more readable, so this is purely stylistic.

### 5. Effect.match / matchEffect — only matchCauseEffect, used correctly

The data-types review noted that `operator.ts` could use
`Effect.matchEffect` over an `Either.isLeft`/`Either.isRight` ladder.
Confirmed: `packages/substrate/src/operator.ts:148-205` runs three
`Either.is*` checks against `handlerResult` and `buildResult`. The
ladder is three-way (success / failure / build-rejection-race), so a
straight `Effect.matchEffect({ onFailure, onSuccess })` does not
collapse the whole thing cleanly — the data-types review's
recommendation (extract a helper for the build-rejection branch)
stands as the right shape; cross-referenced here, not duplicated.

The single matchCauseEffect site is
`packages/substrate/src/choreography/tools.ts:169-198`, where
`onSuccess` and `onFailure` discriminate "interrupt-only" (the expected
suspension signal) from defects. This is the textbook use of
`matchCauseEffect` and is correct.

`Effect.match` (the no-effect version) is unused, which is consistent
with the codebase: every error-channel branch needs to either fail
again, succeed with a typed value, or run a logging effect — none of
those collapse to a pure `match`.

### 6. tap / tapError / tapErrorCause — used as side-effect-only as required

The four tap-points all sit at observability boundaries:

- `packages/runtime/src/runtime/internal/event-stream-materializer.ts:183`
  — `tapErrorCause` for `logError`
- `packages/runtime/src/runtime/internal/operation-handler.ts:209` —
  `tapErrorCause` for `logError`
- `packages/runtime/src/runtime/internal/runner.ts:155` —
  `Effect.tap(() => Effect.sync(wake))` (deadline edge)
- `packages/runtime/src/runtime/internal/runner.ts:180` —
  `tapErrorCause` for `logError`

All four use `tap*` strictly for fire-and-forget side effects (logging,
poking the wake callback) without altering the success channel. None
attempt data flow through the tap. Good.

### 7. Effect.suspend / Effect.lazy

Two uses of `Effect.suspend`:

- `packages/substrate/src/projection-service.ts:49` — defers
  `query.evaluate(snapshotFromDb(...))` so the snapshot is read at
  *call time*, not at builder time. Correct (this is the canonical use
  of `suspend` in a query-builder context).
- `packages/substrate/src/event-plane/producer.ts:101` — defers a
  synchronous validate against `collectionsByType` whose entries depend
  on the at-call-time event. The explicit return type
  `: Effect.Effect<void, RevalidateError>` inside the suspend callback
  is good belt-and-braces against TS narrowing.

There are no `Effect.lazy` uses (the API was deprecated in favor of
`suspend`). No suspend that should be lazy or vice-versa observed.

### 8. Effect.runSync / runFork / runPromise — boundary discipline holds

All four production sites accounted for:

- `packages/substrate/src/state-machine.ts:39-45` — `runUnsafe` shim
  bridging Effect-returning state-machine builders to the legacy
  throw-on-illegal callsite contract. Documented as transitional.
- `apps/lab/src/lab/LabEventStreamPanel.tsx:54` — `Effect.runFork` for
  the follow fiber, with `eslint-disable-next-line no-restricted-syntax`
  and comment "React effect boundary". Correct.
- `apps/lab/src/lab/LabEventStreamPanel.tsx:82` — `Effect.runPromise` to
  interrupt the follow fiber on cleanup. Correct.
- `apps/lab/src/lab/LabEventStreamPanel.tsx:92` —
  `Effect.runPromiseExit` to bridge `emitLabEvent` into a React click
  handler. Correct.

The bin entry uses `NodeRuntime.runMain(...)` rather than
`Effect.runPromise` (`packages/runtime/bin/firegrid.ts:154`), which is
the platform-native entry — strictly preferable for a CLI process and
consistent with the @effect/platform-node convention.

`apps/lab/src/lab/RawStreamInspector.tsx` uses raw `async`/`await`
rather than Effect at all (lines 42-72). This is acceptable per the
file's docstring (it consumes the external `@durable-streams/client`
directly without going through a Firegrid Effect surface), but the
sibling `LabEventStreamPanel.tsx` *does* go through Effect for the same
job. A future cleanup pass could bring the raw inspector to the same
pattern; not blocking.

### 9. Effect type signatures — `Effect.Effect<A>` shorthand vs explicit form

Effect's `Effect.Effect<A>` shorthand expands to `Effect<A, never, never>`.
Both forms appear in the codebase:

- Shorthand `Effect.Effect<A>` (relying on default `never` params):
  - `packages/substrate/src/subscribers.ts:130` — `Effect.Effect<Option.Option<A>>`
  - `packages/runtime/src/runtime/internal/runner.ts:135, 142, 143` —
    `Effect.Effect<void>` for finalizer slots
  - `packages/runtime/src/runtime/internal/wake-stream.ts:3` —
    `type WakeFinalizer = Effect.Effect<void>`
  - `packages/runtime/src/runtime/internal/stream-resolver.ts:123` —
    `Effect.Effect<ResolvedStream>` on the `RuntimeStreamResolverService`
  - `packages/substrate/src/choreography/tools.ts:110, 170, 176` —
    `Effect.Effect<CompletionId, never>` and similar
- Explicit `Effect.Effect<A, E>` (R defaulted): the dominant form

There is no inconsistency *within* a file, and the shorthand is only
used at sites where R must be `never` for type-soundness reasons (Tag
service-method slots, finalizer slots). This is the idiomatic split.

A single anomaly: `packages/substrate/src/choreography/tools.ts:110` and
`:170, :176` use the verbose `Effect.Effect<X, never>` (E explicit as
never) where the shorthand `Effect.Effect<X>` would do. The author
likely wanted the second-position `never` to read as documentation
("this *cannot* fail"); leaving as-is is reasonable, but switching to
shorthand would be one less inconsistency with `wake-stream.ts:3`.

### 10. Cross-cutting: `validate.pipe(Effect.as(event))` micro-pattern

`packages/substrate/src/schema/state-machine.ts:127` defines:

```
validatedChangeEvent = (validate, event) => validate.pipe(Effect.as(event))
```

This is a textbook `Effect.as` use — replacing a `Effect<void, E>`'s
success with a constant `ChangeEvent`. The same pattern appears in
`packages/substrate/src/descriptors/append.ts:17`
(`appendChange` ends with `.pipe(Effect.asVoid)`). Both are correct and
cleaner than `Effect.map(() => event)` / `Effect.map(() => undefined)`.

## Out of scope

- General formatting, Schema-first, Match-first conversions: covered in
  `docs/REVIEW_EFFECT_CODE_STYLE_2026-05-05.md`.
- Tagged-error class shape, Cause-vs-Error distinction, Effect.either
  usage in `operator.ts`: covered in the data-types and error-management
  reviews. The `Either.isLeft`/`isRight` ladder in
  `packages/substrate/src/operator.ts:148-205` is left to those reviews
  per the brief.
- `apps/lab/src/lab/RawStreamInspector.tsx` raw async/await: noted as a
  *style* gap, not a core-Effect-idiom gap.
- Stream APIs (`Stream.runDrain`, `Stream.unwrapScoped`,
  `Stream.async{Scoped}`, `Stream.mapEffect`): all uses observed look
  idiomatic at quick read; full Stream review is its own pass.
- `@effect/platform` Command/Terminal usage in
  `packages/runtime/bin/firegrid.ts`: the bin is well-formed but is
  platform-specific and out of scope for a core-idioms pass.

## Top 5 idiomatic improvements

1. **Flatten `observe` in `operation-client.ts`** —
   `packages/client/src/firegrid/operation-client.ts:283-292` collapses
   from `Stream.unwrapScoped(Effect.gen(...))` to
   `Stream.unwrap(Effect.map(SubstrateClient, (client) => ...))`. One
   yield, one immediate return: the canonical post-R0B flatten target
   that the previous flatten pass missed.
2. **Adopt `Effect.andThen` for two-step pipes** — most pressing at
   `packages/client/src/firegrid/operation-client.ts:281`
   (`send(...).pipe(Effect.flatMap((h) => result(op, h)))`) and the
   `encode → append → asVoid` chain in
   `packages/client/src/firegrid/event-client.ts:114-128`. `andThen`
   accepts both the next-Effect-from-A function *and* a constant
   Effect; either side reads more linearly. Currently zero adoption in
   production — flagging as a deliberate-or-not call for the team.
3. **Document the `state-machine.ts` shim deletion in the issue
   tracker** — the `runUnsafe` helper in
   `packages/substrate/src/state-machine.ts:39-45` is the one
   transitional `Effect.runSync` site outside the React boundary. Each
   of its eight `export function` wrappers is a candidate for
   conversion to an Effect-returning surface (the schema layer already
   exposes `*Effect` variants). A tracker issue + dated TODO comment
   would let later code-style reviews drop the `runUnsafe` carve-out.
4. **Bring `RawStreamInspector.tsx` to parity with `LabEventStreamPanel.tsx`**
   — the sibling panel uses `Effect.runFork` + `Fiber.interrupt`; the
   raw inspector at `apps/lab/src/lab/RawStreamInspector.tsx:42-72`
   uses an ad-hoc `cancelled` boolean and try/catch. Bringing them to
   the same shape removes the only non-Effect async path in the lab
   app and aligns with the React-boundary suppression rationale.
5. **Replace `Effect.Effect<X, never>` with shorthand
   `Effect.Effect<X>`** at
   `packages/substrate/src/choreography/tools.ts:110, 170, 176` for
   consistency with `wake-stream.ts:3` and `runner.ts:135-143`.
   Trivial; mentioned for the next sweep.

## What strict-baseline enforces vs gaps

R0-R-STRICT-BASELINE locks in the run-boundary discipline (the four
documented production sites are the *only* `Effect.run*` calls), and
the post-R0B flatten pass appears to have been thorough — only the
single `observe` candidate in `operation-client.ts` and the small
single-yield gens in `LabEventStreamClient.ts` and
`subscribers.ts:319` remain.

What the baseline does not appear to enforce:

- **Preference for `Effect.andThen` over `Effect.flatMap`** for the
  pipe-friendly two-arity case. The team may legitimately prefer
  `flatMap` as the only binding operator and `andThen` as forbidden;
  if so, a comment in the code-style doc would close the loop. If
  not, an ESLint custom rule could nudge.
- **Guard against `Effect.try({ try: () => effectReturningFn() })`**
  — this codebase does not have the bug, but the only
  `Effect.try` site (`choreography/service.ts:207`) wraps a
  *compat-shim* function that does throw. A semgrep rule that flags
  `Effect.try` whose `try` callback's return type is `Effect.Effect<...>`
  would be cheap insurance against future drift if more compat shims
  appear.
- **Single-yield `Effect.gen` flatten** — the one remaining offender
  is in client code (`operation-client.ts:283-292`); an ESLint pass
  (the same one that drove R0B) re-run targeting `apps/`/
  `packages/client/` would catch it.
- **Single-Tag `Effect.gen` blocks that immediately return** — the
  pattern `yield* Tag; return ...` is the post-R0B canonical
  `Effect.map(Tag, fn)` flatten target. Two instances were found
  (`operation-client.ts:285`, `LabEventStreamClient.ts:45`); a small
  AST rule against this exact shape would add zero false positives.

Overall posture: idiomatic, conservative, and disciplined at the
boundaries. The remaining drift is small and well-bounded.
