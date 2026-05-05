# Effect-TS Traits Review — Firegrid

Date: 2026-05-05
Scope: `packages/substrate`, `packages/runtime`, `packages/client`, `apps/lab`
(production code; tests excluded except where explicitly cited).
Skill reference: `/Users/gnijor/gurdasnijor/claude-skill-effect-ts/skills/traits/SKILL.md`.

## Summary

Firegrid uses **zero** custom `Equal` / `Hash` / `Equivalence` / `Order`
implementations in production code. The codebase relies on:

- `Data.TaggedError` (28 sites) — gives every error class structural
  `Equal`/`Hash` for free via the Data module.
- Native `===` / `!==` exclusively against primitives (string IDs, enum
  state strings, `undefined` checks). No raw object-identity comparisons
  were found that would silently misbehave.
- Native `Map` / `Set` / `ReadonlyMap` for keyed collections (string
  keys), backed by `@tanstack/db` collection state at the substrate
  layer. No `HashMap` / `HashSet` usage anywhere.
- No `Array.prototype.sort` calls in production. The 18 `.sort()` sites
  are all in `__tests__/` and all sort arrays of strings (object keys
  for snapshot assertions) — primitive sorting, native sort is correct.

This is **absent-by-design**, not a gap. The substrate operates on
string-keyed primitive identifiers; the choreography boundary uses
`Brand.nominal` (still erased to string at runtime); state is stored in
ReadonlyMaps keyed by primitive strings. Effect's structural-equality
machinery would buy nothing on top of `===` for string keys.

## Inventory (grep results)

| Pattern | Production hits | Test hits |
|---|---|---|
| `Equal.equals` / `Equal.symbol` | 0 | 0 |
| `Hash.hash` / `Hash.symbol` / `Hash.combine` | 0 | 0 |
| `Equivalence.make` / `Equivalence.string` / `.mapInput` | 0 | 0 |
| `Order.lessThan` / `Order.make` / `Order.string` / `.combine` | 0 | 0 |
| `HashMap` / `HashSet` (Effect) | 0 | 0 |
| `Data.TaggedError` | 28 | n/a |
| `Brand.nominal` | 4 | n/a |
| `Schema.brand` | 0 | 0 |
| Native `Array.prototype.sort` | 0 | 18 (all primitive) |

`Data.TaggedError` sites span substrate (`retained-records.ts:18`,
`subscribers.ts:19,24,30`, `producer.ts:16,20`, `waits.ts:79`,
`operator-errors.ts:9,14,20`, `operator.ts:65`, `facade/work.ts:11`,
`schema/state-machine.ts:90,98`, `facade/projection.ts:25,31`,
`choreography/errors.ts:16`, `choreography/service.ts:55`,
`event-plane/projection.ts:17,24`, `event-plane/producer.ts:16,23,31`)
and runtime (`bin/firegrid.ts:7`, `internal/event-stream-materializer.ts:47,54`,
`internal/runner.ts:56`, `internal/stream-resolver.ts:31`,
`internal/operation-handler.ts:43,47`).

## Implicit Equality Check

Every `===`/`!==` site reviewed in production is a primitive comparison,
not an object identity check that could mask a structural mismatch. Spot
checks:

- `packages/substrate/src/retained-records.ts:74,85` — `claim.workId === workId`,
  `run.runId === runId`. Both sides are branded strings.
- `packages/substrate/src/subscribers.ts:86` — `completion.kind === kind && completion.state === "pending"`. Strings.
- `packages/substrate/src/operator.ts:120,138,157` — `winner.claimId !== claimId`, `preRun.state !== "blocked"`. Strings.
- `packages/substrate/src/schema/state-machine.ts:386–387` — comparing
  `blockedRun.state` and `blockedOnCompletionId` against a target. Strings.
- `packages/substrate/src/choreography/service.ts:189–203,232–233` —
  identical pattern: state-tag and completionId string comparisons.

There are no places where two `CompletionValue` / `RunValue` /
`ClaimAttemptValue` snapshots are compared as whole objects. The
projection layer (`projection.ts`, `event-plane/projection.ts`) only
copies maps and produces snapshots; it does not diff them, so there is
no missed `Equal.equals` opportunity.

## Sorting

Zero production sort sites. All 18 hits live under `packages/substrate/src/__tests__/`
and sort arrays of object keys or string IDs (e.g. `producer.test.ts:192`
sorts `["runId", "state"]`; `event-plane-projection.test.ts:75` sorts
`["r-1", "r-2"]`). Native lexicographic sort is the correct tool here;
`Order.string` would only add an import.

## HashMap / HashSet

None. Substrate state is exposed as `ReadonlyMap<string, RunValue>` /
`ReadonlyMap<string, CompletionValue>` etc.
(`packages/substrate/src/projection.ts:20–24`,
`packages/substrate/src/event-plane/projection.ts:44`,
`packages/runtime/src/runtime/internal/runner.ts:70`). These are
materialised from `@tanstack/db` collection state via
`new Map(db.collections.runs.state)` (`projection.ts:32–34`). Tanstack/DB
is an external collection store and does **not** participate in Effect's
`Equal`/`Hash` protocols; switching to `HashMap` would force a copy at
the boundary for no semantic gain (keys are strings).

## Branded Types — Cross-reference

`packages/substrate/src/choreography/branded.ts:14–21` and
`packages/substrate/src/descriptors/operation.ts:59` use `Brand.nominal`.
This is already flagged in the data-types review
(`docs/REVIEW_EFFECT_DATA_TYPES_2026-05-05.md:208,215`) as a candidate
for `pipe(Schema.brand("..."))` if/when these IDs need to ride through
Schema decode pipelines. Brands are erased at runtime, so they have **no
effect on Equal/Hash semantics either way** — branded strings still
compare with `===` and hash as strings. No additional traits-layer
recommendation is needed; defer to the data-types review note.

## `Data.TaggedError` and Equal

`Data.TaggedError` automatically supplies `Equal`/`Hash` via the Data
module (skill reference: "Data.Class — Automatic Implementation"). The
firegrid error classes are constructed and pattern-matched but never
compared with `Equal.equals`, so the inherited trait is unused but
harmless. Pattern matching is via `Match.tag` / `instanceof` (see
pattern-matching review), which is the correct idiom.

## Recommendations

1. **No action required for traits.** The trait surface is correctly
   absent; adding `Equal`/`Hash`/`Equivalence`/`Order` would be
   ceremony without payoff for the current data shapes.
2. **(Deferred to data-types review)** If `WorkId` / `CompletionId` /
   `OwnerId` / `OperationHandleId` start traversing `Schema.decode`
   pipelines, migrate from `Brand.nominal` to `pipe(Schema.brand(...))`
   per the data-types review at lines 208 and 215. This is a
   schema-integration concern, not a traits concern — `Equal` semantics
   are unchanged.
3. **No HashMap migration recommended.** The `ReadonlyMap` boundary
   with `@tanstack/db` is load-bearing; native `Map` is the correct
   primitive while collection state lives outside Effect.

## Verdict

Confirmatory pass. Zero findings of the form "you should be using a
trait here." The codebase's data shapes (string-keyed primitive maps,
tagged errors, primitive `===` comparisons) are well-matched to the
default trait behavior, and the one branded-type observation already
lives in the data-types review.
