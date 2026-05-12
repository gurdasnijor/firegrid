/**
 * DurableConsumer — "process each logical item once per subscriber" operator.
 *
 * Implements:
 *  - effect-durable-operators.CONSUMER.1 — select + key per subscriber
 *  - effect-durable-operators.CONSUMER.2 — checkpoint storage via the
 *    `ConsumerCheckpointStore` service tag
 *  - effect-durable-operators.CONSUMER.3 — `ClaimPolicy` is an explicit
 *    tagged enum (AtMostOnce / AtLeastOnce / AtLeastOnceWithClaim)
 *  - effect-durable-operators.CONSUMER.4 — AtMostOnce writes claim BEFORE
 *    the externally visible side effect
 *  - effect-durable-operators.CONSUMER.5 — AtLeastOnce writes completion
 *    AFTER successful side effect
 *  - effect-durable-operators.CONSUMER.6 — both Sink-shaped and Stream-shaped
 *    APIs are exposed
 *  - effect-durable-operators.CONSUMER.7 — optional Schedule for retrying
 *    the processing effect.
 *
 * Consumer checkpoint state is distinct from durable-stream producer
 * idempotency (BOUNDARIES.4 / SDD §Checkpoint Semantics).
 */

import {
  type Context,
  Data,
  Effect,
  Option,
  type Schedule,
  Sink,
  Stream,
} from "effect"
import { ConsumerCheckpointStore } from "./ConsumerCheckpointStore.ts"
import type { ConsumerSource } from "./ConsumerSource.ts"
import { DurableConsumerError } from "./Errors.ts"

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export interface ConsumerDefinition<Fact, Key extends string, Input> {
  readonly name: string
  /** Filter + adapt source facts to the consumer's logical input. */
  readonly select: (fact: Fact) => Option.Option<Input>
  /** Derive a stable subscriber-scoped key. */
  readonly key: (input: Input) => Key
}

export const define = <Fact, Key extends string, Input>(
  def: ConsumerDefinition<Fact, Key, Input>,
): ConsumerDefinition<Fact, Key, Input> => def

// ---------------------------------------------------------------------------
// ClaimPolicy
// ---------------------------------------------------------------------------

// `Data.TaggedEnum` constraints reject `Record<string, never>`; the members
// genuinely carry no payload in v0, so the empty object literal is the
// correct shape. Lint suppression is local and precise.
/* eslint-disable @typescript-eslint/no-empty-object-type */
export type ClaimPolicyType = Data.TaggedEnum<{
  AtMostOnce: {}
  AtLeastOnce: {}
  AtLeastOnceWithClaim: {}
}>
/* eslint-enable @typescript-eslint/no-empty-object-type */

export const ClaimPolicy = Data.taggedEnum<ClaimPolicyType>()

// ---------------------------------------------------------------------------
// Common parameters
// ---------------------------------------------------------------------------

export interface Checkpoint {
  readonly subscriberId: string
}

interface ProcessParams<Fact, SourceError, SourceRequirements, Key extends string, Input, Output, E, R> {
  readonly source: ConsumerSource<Fact, SourceError, SourceRequirements>
  readonly checkpoint: Checkpoint
  readonly definition: ConsumerDefinition<Fact, Key, Input>
  readonly policy: ClaimPolicyType
  // Generic in caller-chosen error E and requirements R so adapters can
  // freely compose their own Effect services (HttpClient, custom tools,
  // etc.) without bending around an inflated R channel.
  readonly process: (input: Input) => Effect.Effect<Output, E, R>
  readonly retry?: Schedule.Schedule<unknown, E | DurableConsumerError, never>
  /**
   * If `true`, read the source with `live: true`. Default `true` for `run`/`sink`
   * (long-running consumers). The `stream` form follows the same default.
   */
  readonly live?: boolean
}

// ---------------------------------------------------------------------------
// Core processing — selects facts, dedupes via checkpoint, applies policy.
// Returns a stream of *processed* outputs (one per input that was processed
// during this call; previously-completed inputs are skipped silently).
// ---------------------------------------------------------------------------

// Wrap any checkpoint/process failure into a typed DurableConsumerError. The
// `cause` slot is `unknown`-typed for callers; we discriminate on `_tag` at
// the surface only.
const wrapErr = (name: string) =>
  Effect.mapError(
    (cause: unknown) => new DurableConsumerError({ consumer: name, cause }),
  )

const applyRetry = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
  retry: Schedule.Schedule<unknown, E, never> | undefined,
): Effect.Effect<A, E, R> =>
  retry !== undefined ? Effect.retry(eff, retry) : eff

// Policy → decision: returns whether to skip the input, and the pre/post
// claim/completion hooks. Centralizes the policy semantics so they live in
// exactly one place (and so jscpd doesn't see three near-identical branches).
type PolicyAction = {
  readonly skip: boolean
  readonly preProcess: "claim" | "claim-if-unclaimed" | "none"
  readonly postProcess: "completion" | "none"
}

const decidePolicy = (
  policy: ClaimPolicyType,
  existing: Option.Option<{
    readonly claimedAt: Option.Option<string>
    readonly completedAt: Option.Option<string>
  }>,
): PolicyAction =>
  ClaimPolicy.$match(policy, {
    AtMostOnce: () => ({
      skip:
        Option.isSome(existing) && Option.isSome(existing.value.claimedAt),
      preProcess: "claim" as const,
      postProcess: "none" as const,
    }),
    AtLeastOnce: () => ({
      skip:
        Option.isSome(existing) && Option.isSome(existing.value.completedAt),
      preProcess: "none" as const,
      postProcess: "completion" as const,
    }),
    AtLeastOnceWithClaim: () => ({
      skip:
        Option.isSome(existing) && Option.isSome(existing.value.completedAt),
      preProcess: "claim-if-unclaimed" as const,
      postProcess: "completion" as const,
    }),
  })

const runOnePolicy = <Input, Output, E, R>(
  store: Context.Tag.Service<typeof ConsumerCheckpointStore>,
  subscriberId: string,
  k: string,
  input: Input,
  process: (input: Input) => Effect.Effect<Output, E, R>,
  retry: Schedule.Schedule<unknown, E | DurableConsumerError, never> | undefined,
  action: PolicyAction,
  name: string,
): Effect.Effect<Output, E | DurableConsumerError, R> => {
  const claim = store.writeClaim(subscriberId, k).pipe(wrapErr(name))
  const complete = store.writeCompletion(subscriberId, k).pipe(wrapErr(name))
  return Effect.gen(function* () {
    if (action.preProcess === "claim") yield* claim
    else if (action.preProcess === "claim-if-unclaimed") yield* claim
    const out = yield* applyRetry(
      process(input) as Effect.Effect<Output, E | DurableConsumerError, R>,
      retry,
    )
    if (action.postProcess === "completion") yield* complete
    return out
  })
}

const processedStream = <Fact, SourceError, SourceRequirements, Key extends string, Input, Output, E, R>(
  params: ProcessParams<Fact, SourceError, SourceRequirements, Key, Input, Output, E, R>,
): Stream.Stream<
  Output,
  SourceError | E | DurableConsumerError,
  SourceRequirements | R | ConsumerCheckpointStore
> =>
  Stream.unwrap(
    Effect.map(ConsumerCheckpointStore, (store) => {
      const live = params.live ?? true
      const handle = (
        fact: Fact,
      ): Stream.Stream<Output, E | DurableConsumerError, R> => {
        const selected = params.definition.select(fact)
        if (Option.isNone(selected)) return Stream.empty
        const input = selected.value
        const k = params.definition.key(input)
        return Stream.unwrap(
          Effect.map(
            store
              .read(params.checkpoint.subscriberId, k)
              .pipe(wrapErr(params.definition.name)),
            (existing) => {
              const action = decidePolicy(params.policy, existing)
              return action.skip
                ? Stream.empty
                : Stream.fromEffect(
                    runOnePolicy(
                      store,
                      params.checkpoint.subscriberId,
                      k,
                      input,
                      params.process,
                      params.retry,
                      action,
                      params.definition.name,
                    ),
                  )
            },
          ),
        )
      }
      return params.source.read({ live }).pipe(Stream.flatMap(handle))
    }),
  )

// ---------------------------------------------------------------------------
// Public APIs: run / sink / stream
// ---------------------------------------------------------------------------

export type RunOptions<Fact, SourceError, SourceRequirements, Key extends string, Input, Output, E, R> =
  ProcessParams<Fact, SourceError, SourceRequirements, Key, Input, Output, E, R>

/**
 * Drain the source through the consumer. Returns the number of inputs
 * processed during this call.
 */
export const run = <Fact, SourceError, SourceRequirements, Key extends string, Input, Output, E, R>(
  opts: RunOptions<Fact, SourceError, SourceRequirements, Key, Input, Output, E, R>,
): Effect.Effect<
  { readonly processed: number },
  SourceError | E | DurableConsumerError,
  SourceRequirements | R | ConsumerCheckpointStore
> =>
  processedStream(opts).pipe(
    Stream.runFold(0, (n) => n + 1),
    Effect.map((processed) => ({ processed })),
  )

/**
 * Ergonomic convenience over `define` + `run`. Combines the consumer
 * definition (`name`, `select`, `key`) and the runtime parameters
 * (`source`, `checkpoint`, `process`) into one inlined options object,
 * and defaults `policy` to `ClaimPolicy.AtMostOnce()` for the common
 * "process each logical key once per subscriber" case.
 *
 * The lower-level `define` / `run` / `sink` / `stream` APIs are
 * unchanged; this helper is purely additive.
 *
 * Implements effect-durable-operators.CONSUMER.9.
 */
export interface ForEachOptions<
  Fact,
  SourceError,
  SourceRequirements,
  Key extends string,
  Input,
  Output,
  E,
  R,
> {
  readonly name: string
  readonly source: ConsumerSource<Fact, SourceError, SourceRequirements>
  readonly checkpoint: Checkpoint
  readonly select: (fact: Fact) => Option.Option<Input>
  readonly key: (input: Input) => Key
  readonly process: (input: Input) => Effect.Effect<Output, E, R>
  readonly policy?: ClaimPolicyType
  readonly retry?: Schedule.Schedule<unknown, E | DurableConsumerError, never>
  readonly live?: boolean
}

export const forEach = <Fact, SourceError, SourceRequirements, Key extends string, Input, Output, E, R>(
  opts: ForEachOptions<Fact, SourceError, SourceRequirements, Key, Input, Output, E, R>,
): Effect.Effect<
  { readonly processed: number },
  SourceError | E | DurableConsumerError,
  SourceRequirements | R | ConsumerCheckpointStore
> =>
  run({
    source: opts.source,
    checkpoint: opts.checkpoint,
    definition: define<Fact, Key, Input>({
      name: opts.name,
      select: opts.select,
      key: opts.key,
    }),
    policy: opts.policy ?? ClaimPolicy.AtMostOnce(),
    process: opts.process,
    ...(opts.retry === undefined ? {} : { retry: opts.retry }),
    ...(opts.live === undefined ? {} : { live: opts.live }),
  })

/**
 * Sink form — consumes a `Stream<Fact>` and returns the processed count.
 * Use when the caller owns the source stream lifecycle.
 */
export const sink = <Fact, Key extends string, Input, Output, E, R>(opts: {
  readonly checkpoint: Checkpoint
  readonly definition: ConsumerDefinition<Fact, Key, Input>
  readonly policy: ClaimPolicyType
  readonly process: (input: Input) => Effect.Effect<Output, E, R>
  readonly retry?: Schedule.Schedule<unknown, E | DurableConsumerError, never>
}): Sink.Sink<
  { readonly processed: number },
  Fact,
  never,
  E | DurableConsumerError,
  R | ConsumerCheckpointStore
> => {
  const step = (acc: number, fact: Fact) =>
    Effect.gen(function* () {
      const store = yield* ConsumerCheckpointStore
      const selected = opts.definition.select(fact)
      if (Option.isNone(selected)) return acc
      const input = selected.value
      const k = opts.definition.key(input)
      const existing = yield* store
        .read(opts.checkpoint.subscriberId, k)
        .pipe(wrapErr(opts.definition.name))
      const action = decidePolicy(opts.policy, existing)
      if (action.skip) return acc
      yield* runOnePolicy(
        store,
        opts.checkpoint.subscriberId,
        k,
        input,
        opts.process,
        opts.retry,
        action,
        opts.definition.name,
      )
      return acc + 1
    })

  return Sink.foldEffect<
    number,
    Fact,
    E | DurableConsumerError,
    R | ConsumerCheckpointStore
  >(0, () => true, step).pipe(
    Sink.ignoreLeftover,
    Sink.map((processed) => ({ processed })),
  )
}

/**
 * Stream form — emits the `Output` value for each processed input. Inputs
 * skipped due to claim/completion are not emitted. For AtMostOnce, a process
 * failure after claim does NOT emit; the failure surfaces via the stream's
 * error channel (per SDD open question #2; observability-only side channel
 * is deferred).
 */
export const stream = <Fact, SourceError, SourceRequirements, Key extends string, Input, Output, E, R>(
  opts: RunOptions<Fact, SourceError, SourceRequirements, Key, Input, Output, E, R>,
): Stream.Stream<
  Output,
  SourceError | E | DurableConsumerError,
  SourceRequirements | R | ConsumerCheckpointStore
> => processedStream(opts)
