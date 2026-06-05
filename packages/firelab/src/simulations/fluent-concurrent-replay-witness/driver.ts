import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { FiregridConfig, type ClientOptions } from "@firegrid/client-sdk/config"
import { execute, run, type ExecutionContext } from "@firegrid/fluent-firegrid"
import { Console, Duration, Effect, Layer, Ref, Schema, type Scope } from "effect"
import { DurableStream, type Endpoint } from "effect-durable-streams"

type Epoch = "first" | "replay"

interface StepPlan {
  readonly name: string
  readonly firstDelayMs: number
  readonly replayDelayMs: number
}

interface VariantReport {
  readonly variant: "named" | "positional-mutation"
  readonly firstResult: ReadonlyArray<string>
  readonly replayResult: ReadonlyArray<string>
  readonly firstActions: number
  readonly replayActions: number
  readonly firstJournalRows: number
  readonly replayJournalRows: number
}

type FluentRequirements = FetchHttpClient.Fetch | HttpClient.HttpClient | Scope.Scope

const stepPlans: ReadonlyArray<StepPlan> = [
  { name: "slow", firstDelayMs: 30, replayDelayMs: 0 },
  { name: "fast", firstDelayMs: 0, replayDelayMs: 30 },
  { name: "mid", firstDelayMs: 15, replayDelayMs: 15 },
]

const withFetchClient = <A, E>(
  effect: Effect.Effect<A, E, FluentRequirements>,
): Effect.Effect<A, E> =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(Layer.succeed(FetchHttpClient.Fetch, globalThis.fetch)),
    ),
  )

const journalEndpoint = (
  config: ClientOptions,
  name: string,
): Endpoint => {
  if (config.durableStreamsBaseUrl === undefined) {
    throw new Error("fluent-concurrent-replay-witness requires durableStreamsBaseUrl")
  }
  const baseUrl = config.durableStreamsBaseUrl.replace(/\/+$/, "")
  const namespace = encodeURIComponent(config.namespace ?? "firelab")
  return {
    url: `${baseUrl}/v1/stream/fluent-concurrent-replay/${namespace}/${encodeURIComponent(name)}`,
  }
}

const invocation = (
  config: ClientOptions,
  name: string,
): ExecutionContext => ({
  journal: { endpoint: journalEndpoint(config, name) },
})

const journalRows = (
  endpoint: Endpoint,
): Effect.Effect<ReadonlyArray<unknown>, unknown, FluentRequirements> =>
  DurableStream.define({
    endpoint,
    schema: Schema.Unknown,
  }).collect

const journalRowCount = (
  endpoint: Endpoint,
): Effect.Effect<number, unknown> =>
  withFetchClient(
    journalRows(endpoint).pipe(Effect.map(rows => rows.length)),
  )

const delayFor = (plan: StepPlan, epoch: Epoch): number =>
  epoch === "first" ? plan.firstDelayMs : plan.replayDelayMs

const actionFor = (
  actions: Ref.Ref<ReadonlyArray<{ readonly epoch: Epoch; readonly name: string }>>,
  epoch: Epoch,
  plan: StepPlan,
) =>
  Effect.sleep(Duration.millis(delayFor(plan, epoch))).pipe(
    Effect.zipRight(Ref.update(actions, current => [...current, { epoch, name: plan.name }])),
    Effect.as(`${plan.name}:value`),
  )

const namedHandler = (
  ctx: ExecutionContext,
  epoch: Epoch,
  actions: Ref.Ref<ReadonlyArray<{ readonly epoch: Epoch; readonly name: string }>>,
) =>
  execute(
    ctx,
    Effect.all(
      stepPlans.map(plan => run(plan.name, actionFor(actions, epoch, plan))),
      { concurrency: "unbounded" },
    ),
  )

const positionalMutationHandler = (
  ctx: ExecutionContext,
  epoch: Epoch,
  actions: Ref.Ref<ReadonlyArray<{ readonly epoch: Epoch; readonly name: string }>>,
) =>
  execute(
    ctx,
    Effect.gen(function*() {
      const counter = yield* Ref.make(0)
      return yield* Effect.all(
        stepPlans.map(plan =>
          Effect.sleep(Duration.millis(delayFor(plan, epoch))).pipe(
            Effect.flatMap(() =>
              Ref.getAndUpdate(counter, n => n + 1).pipe(
                Effect.flatMap(index =>
                  run(`${index}:${plan.name}`, actionFor(actions, epoch, plan)),
                ),
              ),
            ),
          ),
        ),
        { concurrency: "unbounded" },
      )
    }),
  )

const actionCount = (
  actions: ReadonlyArray<{ readonly epoch: Epoch; readonly name: string }>,
  epoch: Epoch,
): number =>
  actions.filter(action => action.epoch === epoch).length

const runVariant = (
  config: ClientOptions,
  variant: VariantReport["variant"],
  handler: (
    ctx: ExecutionContext,
    epoch: Epoch,
    actions: Ref.Ref<ReadonlyArray<{ readonly epoch: Epoch; readonly name: string }>>,
  ) => Effect.Effect<ReadonlyArray<string>, unknown, FluentRequirements>,
) =>
  Effect.gen(function*() {
    const actions = yield* Ref.make<ReadonlyArray<{ readonly epoch: Epoch; readonly name: string }>>([])
    const ctx = invocation(config, variant)
    const firstResult = yield* withFetchClient(handler(ctx, "first", actions))
    const firstJournalRows = yield* journalRowCount(ctx.journal.endpoint)
    const replayResult = yield* withFetchClient(handler(ctx, "replay", actions))
    const replayJournalRows = yield* journalRowCount(ctx.journal.endpoint)
    const allActions = yield* Ref.get(actions)
    return {
      variant,
      firstResult,
      replayResult,
      firstActions: actionCount(allActions, "first"),
      replayActions: actionCount(allActions, "replay"),
      firstJournalRows,
      replayJournalRows,
    } satisfies VariantReport
  }).pipe(
    Effect.withSpan("firelab.fluent_concurrent_replay.variant", {
      attributes: { "firegrid.fluent_replay.variant": variant },
    }),
  )

const arraysEqual = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const namedIsGreen = (report: VariantReport): boolean =>
  report.firstActions === stepPlans.length &&
  report.replayActions === 0 &&
  report.firstJournalRows === stepPlans.length &&
  report.replayJournalRows === stepPlans.length &&
  arraysEqual(report.firstResult, report.replayResult)

const mutationIsRed = (report: VariantReport): boolean =>
  report.firstActions === stepPlans.length &&
  report.replayActions > 0 &&
  report.firstJournalRows === stepPlans.length &&
  report.replayJournalRows > report.firstJournalRows &&
  arraysEqual(report.firstResult, report.replayResult)

export const fluentConcurrentReplayWitnessDriver = Effect.gen(function*() {
  const config = yield* FiregridConfig
  const named = yield* runVariant(config, "named", namedHandler)
  const mutation = yield* runVariant(config, "positional-mutation", positionalMutationHandler)
  const namedGreen = namedIsGreen(named)
  const mutationRed = mutationIsRed(mutation)
  const report = { named, mutation, namedGreen, mutationRed }

  yield* Effect.sync(() => {
    if (!namedGreen || !mutationRed) {
      throw new Error(
        `fluent concurrent replay witness failed: ${JSON.stringify(report)}`,
      )
    }
  }).pipe(
    Effect.withSpan("firelab.fluent_concurrent_replay.verdict", {
      attributes: {
        "firegrid.fluent_replay.named_green": String(namedGreen),
        "firegrid.fluent_replay.mutation_red": String(mutationRed),
        "firegrid.fluent_replay.named_replay_actions": String(named.replayActions),
        "firegrid.fluent_replay.mutation_replay_actions": String(mutation.replayActions),
      },
    }),
  )

  yield* Console.log(JSON.stringify(report, null, 2))
}).pipe(
  Effect.withSpan("firelab.fluent_concurrent_replay.driver", {
    kind: "client",
    attributes: {
      "firegrid.fluent_replay.hostless_witness": "true",
      "firegrid.fluent_replay.feature": "features/fluent/substrate/fluent-concurrent-replay-soundness.feature",
      "firegrid.fluent_replay.scope": "appendix-a-named-key-replay",
    },
  }),
)
