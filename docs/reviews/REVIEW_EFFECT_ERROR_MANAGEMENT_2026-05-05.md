# Effect-TS Error-Management Review — Firegrid

Date: 2026-05-05
Scope: `packages/{substrate,runtime,client}/src` and `apps/lab/src` production code (R0–R7-R-STRICT-BASELINE).
Primary skill: `claude-skill-effect-ts/skills/error-management/SKILL.md`.

## Summary

Firegrid's error-management posture is in healthy shape after R7 finished migrating eleven `extends Error` classes onto `Data.TaggedError`. The error channel is meaningfully typed at every package boundary (substrate kernel, runtime, client), `Effect.tryPromise` is used everywhere a promise crosses into the Effect world, and the choreography facade has a deliberately narrow public error channel with internal verification failures funnelled into `Cause.isDie` via `Effect.orDie`. `Cause.isInterruptedOnly` appears at every long-lived loop boundary so interruption is correctly distinguished from real failure.

The dominant cross-cutting question is the `Data.TaggedError` vs `Schema.TaggedError` policy gap noted in code-style review #1. There are 39 `Data.TaggedError` declarations in production code and zero `Schema.TaggedError` declarations. The error-management skill explicitly recommends `Schema.TaggedError` ("Recommended" in `SKILL.md:23`). This review takes a position on that debate (see §1) and lists the smaller wins that are independent of it.

## Findings

### 1. `Data.TaggedError` vs `Schema.TaggedError` policy (load-bearing)

Counts (production code only, tests excluded):
- `Data.TaggedError`: 39 declarations across 18 files
- `Schema.TaggedError`: 0 declarations

Representative sites:
- `packages/substrate/src/subscribers.ts:19,24,30`
- `packages/substrate/src/producer.ts:16,20`
- `packages/substrate/src/operator-errors.ts:9,14,20`
- `packages/substrate/src/choreography/errors.ts:16`
- `packages/substrate/src/choreography/service.ts:55` (defect carrier — internal only)
- `packages/runtime/src/runtime/internal/event-stream-materializer.ts:47,54`
- `packages/runtime/src/runtime/internal/operation-handler.ts:43,47`
- `packages/runtime/src/runtime/internal/runner.ts:56`
- `packages/client/src/firegrid/operation-client.ts:66,73,81,88`
- `packages/client/src/firegrid/event-client.ts:34,41,48,55`

The skill's recommendation rests on `Schema.TaggedError` giving you a `Schema` you can compose into envelope schemas, decode from wire payloads, and reuse in Schema-driven serialization. None of those affordances are exercised in firegrid today: errors are never put on the wire (durable rows carry domain payloads, not error classes), domain operations encode their own typed `error` schema (`packages/runtime/src/runtime/internal/operation-handler.ts:170` uses `Schema.encodeUnknown(input.op.error …)`), and there is no error-as-Schema requirement in any module. `Data.TaggedError` is strictly cheaper at the construction site (no `Schema.Struct` machinery), and the existing 39-site footprint is consistent.

Recommendation: keep `Data.TaggedError` as the firegrid policy and document the deviation explicitly in the code-style addendum. The deciding question is "do we need to decode errors from a wire?" — and the answer is no. Adopt `Schema.TaggedError` only at the moment a future descriptor needs to ship error instances across an envelope boundary. Re-litigating R7 is not worth the churn given the migration just landed.

### 2. `catchTag` / `catchTags` discipline

`Effect.catchTag` is used in 6 sites and `Effect.catchTags` in 0. The usage is principled:

- `packages/substrate/src/subscribers.ts:133` — `Effect.catchTag("IllegalCompletionTransition", …)` collapses race-loss into `Option.none()`. This is exactly the pattern the skill calls out at `SKILL.md:58`.
- `packages/runtime/src/runtime/internal/operation-handler.ts:124,138,173` — three `Effect.catchTag("ParseError", …)` sites where input/output/error decoding falls back to `Effect.logError(...).pipe(Effect.as(undefined))` so a single bad row does not tear down the dispatch loop.

There are two `Effect.catchAll` sites in `operation-handler.ts:148,179` that catch an `AppendEventError` channel where the surrounding effect already has a single typed error type. These are functionally fine but `Effect.catchTag("AppendEventError", …)` would be more precise and remove the implicit "all errors are append errors here" assumption — it would survive the refactor where `appendEvent` grows a second failure mode without silently widening the catch. Recommend converting these two to `catchTag`.

No `Effect.catchSome` sites exist, and there is no `(cause) => cause` pass-through catch — R1's cleanup held.

### 3. `mapError` chains

12 `Effect.mapError` sites; none compound. Every site maps a "raw" error (durable-streams cause, `ParseError`, foreign module error) into a domain `Data.TaggedError`. The chains are flat: one `mapError` per boundary, and the boundaries match where the documented error taxonomy changes.

Notable consolidation candidates are absent. The closest near-pair is `packages/substrate/src/operator.ts:93–95` and `:189` where the same `(cause) => new ClaimStreamError({ cause })` constructor is built twice — extracting a module-local `toClaimStreamError` would shrink three call sites (also `internal-claim.ts:52,70,74`) but the duplication is one expression long and not load-bearing.

The `appendChange` helper in `packages/substrate/src/descriptors/append.ts:9` is the right shape for this pattern: `appendChange(stream, event, (cause) => new ProducerStreamError({ cause }))` already centralizes the `tryPromise + mapError` pair. Six callers use it consistently. This is good — it means firegrid did the consolidation that would otherwise be the obvious recommendation.

### 4. `Cause` introspection patterns

`Cause.isInterruptedOnly` appears in 5 sites and `Cause.failureOption` / `Cause.pretty` in 1 site each:

- `packages/runtime/src/runtime/internal/operation-handler.ts:159,160,174,210`
- `packages/runtime/src/runtime/internal/event-stream-materializer.ts:184`
- `packages/runtime/src/runtime/internal/runner.ts:181`
- `packages/substrate/src/choreography/tools.ts:177` (used inside `Effect.matchCauseEffect` to translate interrupt into `ChoreographySuspension`)

The pattern is consistent: every long-lived `Stream.runDrain` wraps in `Effect.tapErrorCause((cause) => Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError(...))`. This is the right shape; the concurrency review already flagged that the predicate could be centralized into a `logCauseUnlessInterrupted` helper. From an error-management lens, the discipline is correct: interruption is recognized as not-a-failure at every loop boundary that owns a fiber it can be interrupted on.

`Cause.failureOption` + `Cause.pretty` co-occur once at `operation-handler.ts:160–174`, where a typed failure is preferred for the encoded error payload and `Cause.pretty(cause)` is the documented fallback. This is the right shape for a "we have to land *some* error event" requirement and the comment block (`:162–169`) already documents why.

### 5. `Effect.try` / `Effect.tryPromise` discipline

`Effect.tryPromise` appears 14 times; `Effect.try` once. Every site has a `catch` that produces a typed error or wraps the unknown cause in a `Data.TaggedError`. There is one `throw new Error(...)` in production code at `packages/substrate/src/waits.ts:17`:

```
throw new Error("global awakeable requires a non-empty namespace")
```

This is a pure synchronous helper called from outside an Effect context, so an Effect-typed signature is not natural here. It is, however, a programming-error precondition — a defect, not a typed error. Acceptable as-is, but if `globalAwakeableKey` ever moves into Effect-land it should be `Effect.dieMessage`.

`packages/substrate/src/event-plane/producer.ts:120` does `throw new PlaneProducerValidationError(...)` *inside* an `Effect.tryPromise` `try` — this is intentional because the surrounding helper handles the synchronous-vs-Promise Standard-Schema validate ambiguity. The `catch` at `:127` checks `cause instanceof PlaneProducerValidationError` to preserve the typed error rather than re-wrap it. This is a reasonable workaround for a non-Effect Standard-Schema API; the comment at `:113–115` documents the intent. Consider extracting it into a small helper named `tryStandardValidate` to make the pattern legible if it spreads.

`packages/substrate/src/state-machine.ts:39` is a `runUnsafe` synchronous unwrapper used by `createPendingCompletion` etc. (the non-Effect `state-machine.ts` re-export). It re-throws the typed error. This is a deliberate non-Effect surface and is documented as such.

### 6. `Effect.orDie` / `Layer.orDie` / `Effect.die` sites

13 distinct sites. Each is annotated. Inventory and rationale:

| Site | Rationale |
|---|---|
| `packages/substrate/src/choreography/tools.ts:118` | `Effect.dieMessage` for tool-harness invariant violation (post-interrupt run not blocked) |
| `tools.ts:123` | `Effect.orDie` on `observeBlockedCompletion` — internal, defects-only |
| `tools.ts:155` | `readAuthoritativeRun(…).pipe(Effect.orDie)` — pre-call retained-fold read failure is unrecoverable |
| `tools.ts:158,163,171` | `Effect.dieMessage` for tool-harness pre-call invariants |
| `packages/substrate/src/choreography/service.ts:258,293,316,344` | `Effect.orDie` on `sleep` / `waitFor` / `scheduleAt` / `awaitAwakeable` — documented at `service.ts:46–51,257`: internal failures are defects, public error channel is empty |
| `packages/runtime/src/runtime/internal/stream-resolver.ts:166,171` | `Effect.orDie` on embedded-server start and `DurableStreamAdmin.create` — boot-time only |
| `packages/client/src/client/work.ts:115` | `Effect.orDie` on `declareWork` — comment at `:110–114` documents that internal stream-write failures should not widen the public error taxonomy |
| `packages/client/src/client/service.ts:84` | `Layer.orDie` on the projection-acquire failure mode — comment at `:81–83` documents this |

Every site has either an explicit comment or sits inside a heavily commented module (`choreography/`). The `eslint:effectDebtGuardrails` warning is the right tripwire and the per-site `// eslint-disable` discipline is consistent. No additional `orDie`/`die` sites elsewhere.

### 7. Error-channel union types

The codebase is comfortable with `E1 | E2 | …` channels; representative declarations:

- `packages/substrate/src/internal-claim.ts:38–41` — `AttemptClaimError = ClaimStreamError | ClaimMissingCursorError | ClaimWinnerMissingError`
- `packages/substrate/src/subscribers.ts:37–40` — `SubscriberError = SubscriberStreamError | SubscriberDataError | SubscriberEvaluatorError`
- `packages/client/src/firegrid/operation-client.ts:96–101` — `ResultError` is a five-arm union
- `packages/substrate/src/event-plane/producer.ts:94` — `RevalidateError = PlaneProducerValidationError | PlaneProducerUnknownTypeError`

`Schema.Union` is used exactly once in error-adjacent code at `packages/substrate/src/choreography/triggers.ts:25` — and that's for a domain trigger, not an error. Promoting these `type X = A | B | C` aliases to `Schema.Union(A, B, C)` would only pay off if errors had to round-trip through a wire-format decoder, which they do not (see §1). The detector flags `subscribers.ts:37` and `subscribers.ts:300` under `schema/rule-011` — those are correct flags structurally but with `Data.TaggedError` (not `Schema.TaggedError`) the `Schema.Union` promotion has no Schema member to compose against. Resolve by keeping the `type` aliases and treating that detector hit as expected.

### 8. Retry / timeout / accumulation

- `Effect.timeoutFail` appears once at `packages/substrate/src/projection-service.ts:83`. The site supplies `onTimeout` returning a typed `PlaneProjectionWaitTimeout` (constructed via `input.timeout(query.label, timeout)`). This is the canonical use of the API.
- `Effect.retry` is not used in firegrid production code. Retries are pushed up to host policy layers (see comment at `packages/client/src/client/work.ts:110–114`). For a v1 surface this is defensible.
- `Effect.partition` / `Effect.validate` are not used. Validation errors are not accumulated — every check fails fast with a typed error. Given firegrid's authority-model focus (one decision per record), fail-fast is correct here. Note this for descriptor-validation flows that may want accumulation later.

### 9. Sandboxing

`Effect.sandbox` is not used. The closest analogue is `Effect.matchCauseEffect` at `packages/substrate/src/choreography/tools.ts:169` which explicitly inspects `Cause.isInterruptedOnly` and re-fails the cause when it isn't. This is the correct shape for the choreography "interrupt means suspended" translation — `sandbox` would over-promote unrecoverable defects into the error channel and reverse the documented `Effect.orDie` policy. No change needed.

## Out of scope

- The `Cause.isInterruptedOnly` repetition (concurrency review owns it).
- The `Schema.Union` upgrade for non-error type aliases (schema review owns it).
- The error-message hygiene of `String(cause)` interpolations at `service.ts:130,161` etc. (logging/observability review).
- `eslint:effectDebtGuardrails` rule wording (lint addendum already covers).

## Top 5 improvements

1. **Convert `operation-handler.ts:148, :179` from `catchAll` to `catchTag("AppendEventError", …)`** so a future second failure mode in `appendEvent` does not silently get swallowed by the existing `logError` recovery (`packages/runtime/src/runtime/internal/operation-handler.ts:148,179`).
2. **Document the `Data.TaggedError` policy** in `docs/CODE_STYLE.md` (or equivalent) with a one-paragraph rationale (no error-on-the-wire requirement; 39-site consistency; `Schema.TaggedError` is reserved for the moment a descriptor needs error decoding). Closes the open code-style review #1 cross-cutting item.
3. **Extract a `logCauseUnlessInterrupted` helper** for the four `Effect.tapErrorCause + Cause.isInterruptedOnly` sites (operation-handler.ts:209, runner.ts:180, event-stream-materializer.ts:183, plus subscribers.ts pattern). Even a 6-line module-local helper improves readability and is the right place to add structured-log fields later.
4. **Extract the `tryStandardValidate` helper** for the Standard-Schema sync-or-Promise pattern at `event-plane/producer.ts:115–146`. The current shape is correct but the `throw new PlaneProducerValidationError` inside `try` is the kind of code that invites future regressions; making it a single-purpose helper documents the intent.
5. **Audit `Effect.orDie` sites for an explicit `// effect-debt:orDie` justification token** rather than the freeform comments today. The choreography sites have full paragraphs; `client/service.ts:84` and `client/work.ts:115` have shorter comments. A consistent inline marker makes the guardrail audit mechanical rather than prose-grep.

## What strict-baseline already enforces vs gaps

Already enforced:

- No `extends Error` (R7 migration; `state-machine.ts:39` is the sole `E extends Error` *generic* and runs Effect code, not declares an error).
- ESLint `effectDebtGuardrails` warns on every `Effect.orDie` / `Layer.orDie` / `Effect.die`. Each warning is suppressed at the site with rationale comments.
- All durable-streams promise boundaries go through `Effect.tryPromise` with typed `catch` mappings.
- `appendChange` consolidates the most common `tryPromise + mapError` pair into a single helper (`packages/substrate/src/descriptors/append.ts`).
- `Cause.isInterruptedOnly` discipline at every long-lived stream loop.
- No `(cause) => cause` pass-through catches (R1).

Gaps not enforced by lint or types:

- `Data.TaggedError` vs `Schema.TaggedError` choice (no rule; relies on convention).
- `catchAll` vs `catchTag` precision (no rule; relies on review).
- `Effect.orDie` justification comment presence (lint warns on the call but not on the absence of a justification token).
- Error-channel union promotion to `Schema.Union` (covered by `schema/rule-011` detector but the rule fires on type aliases that are semantically fine in firegrid's policy).
- Retry/timeout shape — there is no rule that forces `timeoutFail` over `timeout + match`. Currently a non-issue (one site).

## Closing

Firegrid's error story is mature. The R7 migration, the `appendChange` consolidation, the `Cause.isInterruptedOnly` discipline, and the documented `Effect.orDie` policy in choreography together form a coherent posture. The single load-bearing decision is the `Data.TaggedError` vs `Schema.TaggedError` policy, and the recommendation is to keep `Data.TaggedError` and document why. The remaining items are small, mechanical, and individually sub-hour fixes.
