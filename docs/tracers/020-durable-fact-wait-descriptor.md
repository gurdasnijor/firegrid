# 020: Durable Fact Wait Descriptor

## Problem

A *wait* is a durable fact that says "block until some event matches a
predicate, then write a terminal outcome fact." The substrate must:

- carry no JS predicate code inside durable rows; matchers are named
  and versioned host code;
- produce at most one terminal outcome (matched / failed) per wait id
  across evaluator restarts;
- not reintroduce required-action-specific services, workflows, or
  composition roots;
- not recreate `packages/runtime/src/runtime-operators/**` under
  another name.

## v0 Composition

The wait evaluator is a composition of three additive helpers in
`effect-durable-operators` plus the Firegrid wait row protocol:

| Concern | API |
| --- | --- |
| Once-per-wait request consumption | `DurableConsumer.forEach` (defaults `policy` to `ClaimPolicy.AtMostOnce()`) |
| Source predicate lookup | `ConsumerSource.findFirst(source, predicate, options?)` |
| Durable Streams adapter starting offset | `ConsumerSource.fromDurableStream(bound, { cursor })` |
| Per-subscriber wait progress | `ConsumerCheckpointStore` |
| Wait rows | `@firegrid/protocol/wait` (`makeWaitRequestedRow`, `makeWaitMatchedRow`, `makeWaitFailedRow`, …) |

**No wait-specific operator module is published.** No `DurableWait`,
no `defineX`/`runX` lifecycle, no matcher registry `Context.Tag`. The
two new helpers — `DurableConsumer.forEach` and
`ConsumerSource.findFirst` — are domain-neutral conveniences over the
existing `define`/`run`/`Stream.runHead` composition; both are useful
for time waits and any other "process each request → look up first
matching source row" shape.

v0 composition is snapshot-only and resolves each processed request to
matched or failed: the source is read with `live: false`, and a
snapshot that closes without a match produces a typed
`reason: "matcher-error"` durable failure outcome. `AtMostOnce` writes
the checkpoint claim before invoking process, so terminated waits do
not re-process across evaluator restarts.

**Deferred for follow-up tracers:**

- Live snapshot-then-follow — a wait registered before its source row
  exists, possibly blocking across evaluator restarts. v0 returns a
  typed `matcher-error` failure in that case
  (spec ACID `firegrid-durable-fact-wait-descriptor.EVALUATOR.7`).
- Timeouts — `timeoutAt` is in the wire format but v0 does not fire
  (`TIMEOUT.{1,2,3}`).
- Time waits more broadly — `schedule_me` / timers lower to durable
  `timer.fired` / `schedule.due` facts and reuse the same
  `DurableConsumer.forEach` + `ConsumerSource.findFirst` pattern. No
  time-specific public API is added here.

## The composition

```ts
import {
  ConsumerCheckpointStoreLive,
  ConsumerSource,
  DurableConsumer,
} from "effect-durable-operators"
import { DurableStream } from "effect-durable-streams"
import {
  makeWaitFailedRow,
  makeWaitMatchedRow,
  type WaitFailure,
  type WaitMatch,
  type WaitRequestedRow,
  type WaitRow,
  WaitRowSchema,
} from "@firegrid/protocol/wait"
import { Effect, Option, Schema } from "effect"

// Host-owned matcher table. Plain data; no framework.
type Matcher = (row: unknown, params: unknown) => Option.Option<unknown>
const matchers: Record<string, Matcher> = {
  "text-equals@1": (row, params) =>
    (row as { text?: unknown })?.text === (params as { text: string }).text
      ? Option.some(row)
      : Option.none(),
}

const evaluateSnapshotWait = (req: WaitRequestedRow) => {
  const append = (out: WaitMatch | WaitFailure) =>
    "reason" in out
      ? outcomes.append(makeWaitFailedRow({ waitId: req.waitId, failure: out }))
      : outcomes.append(makeWaitMatchedRow({ waitId: req.waitId, match: out }))

  return Effect.gen(function* () {
    const matcher = matchers[`${req.matcherId}@${req.matcherVersion}`]
    if (matcher === undefined) {
      yield* append({ reason: "unknown-matcher" })
      return
    }
    const found = yield* ConsumerSource.findFirst(
      ConsumerSource.fromDurableStream(
        DurableStream.define({
          endpoint: { url: req.source.streamUrl },
          schema: Schema.Unknown,
        }),
        req.source.cursor === undefined ? undefined : { cursor: req.source.cursor },
      ),
      (row) => matcher(row, req.matcherParams),
    )
    yield* Option.match(found, {
      onNone: () => append({ reason: "matcher-error" }),
      onSome: (matchedValue) =>
        append({
          waitId: req.waitId,
          matcherId: req.matcherId,
          matcherVersion: req.matcherVersion,
          matchedAt: new Date().toISOString(),
          matchedValue,
        }),
    })
  })
}

yield* DurableConsumer.forEach({
  name: "firegrid.wait.evaluator",
  source: ConsumerSource.fromDurableStream(
    DurableStream.define({ endpoint: { url: waitStreamUrl }, schema: WaitRowSchema }),
  ),
  checkpoint: { subscriberId: "firegrid:wait-evaluator" },
  select: (row: WaitRow) =>
    row.type === "firegrid.wait.requested"
      ? Option.some(row satisfies WaitRequestedRow)
      : Option.none(),
  key: (req) => req.waitId,
  live: false,
  process: evaluateSnapshotWait,
}).pipe(Effect.provide(ConsumerCheckpointStoreLive({ /* … */ })))
```

`scenarios/firegrid/src/tracer-020.test.ts` is this shape end-to-end.

## What This Ships

| Path | Role |
| --- | --- |
| `packages/protocol/src/wait/{ids,schema,rows,index}.ts` | Schemas + trusted constructors for `firegrid.wait.{requested,matched,failed,timed_out}`. No dependency on `effect-durable-operators` / `effect-durable-streams` / `@effect/platform`. |
| `packages/effect-durable-operators/src/DurableConsumer.ts` | Adds `forEach` (thin wrapper over `define + run`; default policy `AtMostOnce`). Existing `define`/`run`/`sink`/`stream` APIs unchanged. |
| `packages/effect-durable-operators/src/ConsumerSource.ts` | Adds `findFirst` (snapshot predicate lookup) and an optional `cursor` to `fromDurableStream`. The generic `ConsumerSource.read` shape is unchanged. |
| `packages/effect-durable-operators/test/for-each-find-first.test.ts` | Generic, non-Firegrid tests for both helpers + the cursor option. |
| `scenarios/firegrid/src/tracer-020.test.ts` | Firegrid protocol usage proof. Five assertions over the composition. |
| `features/firegrid/firegrid-durable-fact-wait-descriptor.feature.yaml` | Spec — `DESCRIPTOR`, `EVALUATOR`, `TIMEOUT` (deferred), `BOUNDARY`, `AUTHORITY`, `INVARIANTS`. |
| `features/firegrid/effect-durable-operators.feature.yaml` | Adds `CONSUMER.9`, `SOURCE.6`, `SOURCE.7`. |

## What This Does Not Ship

- No `DurableWait` module. No `defineEvaluator`/`runEvaluator`/
  `defineResolver`/`runResolver`/`defineTerminalEvaluator` lifecycle
  framework. No matcher registry `Context.Tag`.
- No live snapshot-then-follow across evaluator restarts.
- No timeout firing or durable-clock substrate.
- No required-action service / workflow / runtime root.
- No wiring of the evaluator into `FiregridRuntimeHostLive`.

## Boundaries

- `@firegrid/protocol/wait` stays schemas + ids + pure row
  constructors. No `effect-durable-operators` / `effect-durable-streams` /
  `@effect/platform` import.
- The matcher table is host configuration. Public client / prompt
  APIs do not register matcher code.
- `effect-durable-operators` additions are domain-neutral; nothing in
  `forEach` or `findFirst` mentions waits, Firegrid, or required
  actions.
- No new `runtime-operators/**`, `runtime-waits/**`,
  `OperatorSource.scan`, or workflow-launch endpoint is introduced.

## Validation

```bash
pnpm --filter @firegrid/protocol run check
pnpm --filter effect-durable-operators run check
pnpm --filter @firegrid/scenario-firegrid test -- tracer-020
pnpm run check:docs && pnpm run check:specs
pnpm run lint && pnpm run lint:deps && pnpm run lint:dup \
  && pnpm run lint:dead && pnpm run lint:effect-quality
pnpm exec acai push --all --product firegrid
```

## Acceptance

- `firegrid-durable-fact-wait-descriptor.DESCRIPTOR.{1,2,3,4}` covered
  by protocol schema tests + scenario.
- `EVALUATOR.{1,3,4,5,6,7}` covered by `tracer-020.test.ts`.
- `effect-durable-operators.{CONSUMER.9, SOURCE.6, SOURCE.7}` covered
  by `test/for-each-find-first.test.ts`.
- `TIMEOUT.{1,2,3}` explicitly deferred — schemas exist, evaluator
  does not fire.
- Scenario uses production package surfaces only.
- No `DurableWait`, no `runtime-waits/**`, no required-action service
  reintroduced.
