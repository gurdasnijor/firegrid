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

The wait evaluator is a composition of
`effect-durable-operators.DurableConsumer`, `ConsumerSource`, and
`ConsumerCheckpointStore` over `@firegrid/protocol/wait` request rows
with a host-owned named matcher table. **There is no published
wait-specific operator module.** `effect-durable-operators` does not
change; the existing primitives already express the wait semantics.

v0 composition is snapshot-only and resolves each processed request to
matched or failed: the source stream is read with `live: false`, and
the snapshot closing without a match produces a typed
`reason: "matcher-error"` durable failure outcome rather than blocking
the wait indefinitely. `ClaimPolicy.AtMostOnce` writes the checkpoint
claim before invoking process, so terminated waits are not
re-processed across evaluator restarts.

**Deferred for follow-up tracers:**

- Live snapshot-then-follow — a wait registered before its source row
  exists, possibly blocking across evaluator restarts. v0 returns a
  typed `matcher-error` failure in that case.
  (Spec: `firegrid-durable-fact-wait-descriptor.EVALUATOR.7`.)
- Timeouts — `timeoutAt` is in the wire format but v0 does not fire.
  (Spec: `TIMEOUT.{1,2,3}`.)
- Time waits more broadly — `schedule_me` / timers lower to durable
  `timer.fired` / `schedule.due` facts and reuse the same
  `DurableConsumer + matcher table` shape. No time-specific public API
  is added to `effect-durable-operators` here.

## The composition, in full

The Firegrid scenario is the API doc; the entire evaluator is the
snippet below.

```ts
import {
  ClaimPolicy,
  ConsumerCheckpointStoreLive,
  ConsumerSource,
  DurableConsumer,
} from "effect-durable-operators"
import { DurableStream } from "effect-durable-streams"
import {
  makeWaitFailedRow,
  makeWaitMatchedRow,
  type WaitRequestedRow,
  type WaitRow,
  WaitRowSchema,
} from "@firegrid/protocol/wait"
import { Effect, Option, Schema, Stream } from "effect"

// Host-owned matcher table. Plain data; no framework.
type Matcher = (row: unknown, params: unknown) => Option.Option<unknown>
const matchers: Record<string, Matcher> = {
  "test.text-equals@1": (row, params) =>
    (row as { text?: unknown })?.text === (params as { text: string }).text
      ? Option.some(row)
      : Option.none(),
}

const handleWait = (req: WaitRequestedRow) =>
  Effect.gen(function* () {
    const matcher = matchers[`${req.matcherId}@${req.matcherVersion}`]
    if (matcher === undefined) {
      return yield* outcomes.append(
        makeWaitFailedRow({
          waitId: req.waitId,
          failure: { reason: "unknown-matcher" },
        }),
      )
    }
    const found = yield* Stream.runHead(
      DurableStream.define({
        endpoint: { url: req.source.streamUrl },
        schema: Schema.Unknown,
      })
        .read({ live: false })
        .pipe(Stream.filterMap((row) => matcher(row, req.matcherParams))),
    )
    yield* Option.match(found, {
      onNone: () =>
        outcomes.append(
          makeWaitFailedRow({
            waitId: req.waitId,
            failure: { reason: "matcher-error" },
          }),
        ),
      onSome: (value) =>
        outcomes.append(
          makeWaitMatchedRow({
            waitId: req.waitId,
            match: {
              waitId: req.waitId,
              matcherId: req.matcherId,
              matcherVersion: req.matcherVersion,
              matchedAt: new Date().toISOString(),
              matchedValue: value,
            },
          }),
        ),
    })
  })

yield* DurableConsumer.run({
  source: ConsumerSource.fromDurableStream(
    DurableStream.define({ endpoint: { url: waitStreamUrl }, schema: WaitRowSchema }),
  ),
  checkpoint: { subscriberId: "firegrid:wait-evaluator" },
  definition: DurableConsumer.define({
    name: "firegrid.wait.evaluator",
    select: (row: WaitRow) =>
      row.type === "firegrid.wait.requested"
        ? Option.some(row satisfies WaitRequestedRow)
        : Option.none(),
    key: (req: WaitRequestedRow) => req.waitId,
  }),
  policy: ClaimPolicy.AtMostOnce(),
  live: false,
  process: handleWait,
}).pipe(Effect.provide(checkpointStore))
```

`scenarios/firegrid/src/tracer-020.test.ts` is exactly this shape.

## What This Ships

| Path | Role |
| --- | --- |
| `packages/protocol/src/wait/{ids,schema,rows,index}.ts` | Schemas + trusted constructors for `firegrid.wait.requested` / `.matched` / `.failed` / `.timed_out`. |
| `scenarios/firegrid/src/tracer-020.test.ts` | The wait evaluator + four assertions (retained match, restart dedupe, unknown matcher, snapshot-without-match). |
| `features/firegrid/firegrid-durable-fact-wait-descriptor.feature.yaml` | Spec. Components `DESCRIPTOR`, `EVALUATOR`, `TIMEOUT` (deferred). Constraints `BOUNDARY`, `AUTHORITY`, `INVARIANTS`. |

`effect-durable-operators` is unchanged.

## What This Does Not Ship

- No new public module in `effect-durable-operators`. Not
  `DurableWait`, not a `defineX/runX` lifecycle, not a matcher
  registry `Context.Tag`. Hosts pick whatever matcher-storage shape
  they want (plain `Record`, `Map`, custom `Layer`, etc.); the
  substrate stays neutral.
- No live snapshot-then-follow waits across evaluator restarts.
- No timeout firing or durable-clock substrate.
- No required-action behavior. Required actions were deleted in PR
  #161 and a future tracer will compose them on top of this substrate
  by registering a `required-action.resolved` matcher.
- No wiring of the evaluator into `FiregridRuntimeHostLive`. That is
  consumer wiring, not part of the v0 substrate proof.

## Boundaries

- The evaluator is six lines plus a `process` callback over existing
  `effect-durable-operators` primitives. It is not a new abstraction.
- The matcher table is host configuration. Public client / prompt
  APIs do not register matcher code.
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
- `TIMEOUT.{1,2,3}` explicitly deferred — schemas exist, evaluator
  does not fire.
- Scenario uses production package surfaces only; no shadow harness.
- No `DurableWait` module, no `runtime-waits/**`, no required-action
  service reintroduced.
