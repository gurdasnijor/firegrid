import { DurableStream } from "@durable-streams/client"
import type { ChangeEvent } from "@durable-streams/state"
import { Context, Data, Effect, Layer } from "effect"
import { appendChange } from "../descriptors/append.ts"
import { IdGen, IdGenLive, type IdGenService } from "../id-gen.ts"
import {
  cancelCompletion as buildCancelCompletion,
  rejectCompletion as buildRejectCompletion,
  resolveCompletion as buildResolveCompletion,
  IllegalCompletionTransition,
  type IllegalRunTransition,
  startRun,
} from "../schema/state-machine.ts"
import { rebuildProjection } from "../stream.ts"

export class ProducerStreamError extends Data.TaggedError("ProducerStreamError")<{
  readonly cause: unknown
}> {}

export class CompletionNotFoundError extends Data.TaggedError(
  "CompletionNotFoundError",
)<{
  readonly completionId: string
}> {}

export interface SubstrateProducerConfig {
  readonly streamUrl: string
  readonly contentType?: string
}

export interface DeclareWorkInput {
  readonly runId?: string
  readonly data?: unknown
  readonly idempotencyKey?: string
}

export interface DeclareWorkResult {
  readonly runId: string
  readonly state: "started"
}

export interface WorkProducerService {
  readonly declareWork: (
    input?: DeclareWorkInput,
  ) => Effect.Effect<DeclareWorkResult, ProducerStreamError | IllegalRunTransition>
}

export interface CompletionProducerService {
  readonly resolveCompletion: (input: {
    readonly completionId: string
    readonly result: unknown
  }) => Effect.Effect<
    { readonly completionId: string; readonly state: "resolved" },
    ProducerStreamError | CompletionNotFoundError | IllegalCompletionTransition
  >

  readonly rejectCompletion: (input: {
    readonly completionId: string
    readonly error: unknown
  }) => Effect.Effect<
    { readonly completionId: string; readonly state: "rejected" },
    ProducerStreamError | CompletionNotFoundError | IllegalCompletionTransition
  >

  readonly cancelCompletion: (input: {
    readonly completionId: string
    readonly terminalReason: unknown
  }) => Effect.Effect<
    { readonly completionId: string; readonly state: "cancelled" },
    ProducerStreamError | CompletionNotFoundError | IllegalCompletionTransition
  >
}

// effect-native-api.EFFECT_SERVICES.1
// semantic-producer.PRODUCER_ROLE.1, .2, .5
// semantic-producer.PRODUCER_EFFECT.1, .3, .5
// Work declaration only; run terminalization is owned by claim-and-operator-authority.
export class WorkProducer extends Context.Tag("Substrate/WorkProducer")<
  WorkProducer,
  WorkProducerService
>() {}

// effect-native-api.EFFECT_SERVICES.1
// semantic-producer.PRODUCER_ROLE.1, .2, .5
// semantic-producer.PRODUCER_EFFECT.2, .3, .5
// Completion terminalization only; pending creation is owned by Slice 7
// (durable-waits-and-scheduling.AWAKEABLE_API).
export class CompletionProducer extends Context.Tag(
  "Substrate/CompletionProducer",
)<CompletionProducer, CompletionProducerService>() {}

const makeAppend =
  (stream: DurableStream) =>
  (event: ChangeEvent): Effect.Effect<void, ProducerStreamError> =>
    appendChange(stream, event, (cause) => new ProducerStreamError({ cause }))

// launchable-substrate-host.CLIENT_SURFACE.11
// Idempotency metadata travels as ChangeEvent headers, not inside
// the durable.run row value. Substrate readers ignore these
// headers; the kernel guarantees only that they are appended on
// the declaring event for downstream observability/dedupe layers.
const withIdempotencyHeader = (
  event: ChangeEvent,
  idempotencyKey: string | undefined,
): ChangeEvent => {
  if (idempotencyKey === undefined) return event
  const merged: Record<string, string> = {
    ...(event.headers as unknown as Record<string, string>),
    idempotencyKey,
  }
  return {
    ...event,
    headers: merged as unknown as ChangeEvent["headers"],
  }
}

const buildWorkProducer = (
  config: SubstrateProducerConfig,
  idGen: IdGenService,
): WorkProducerService => {
  const stream = new DurableStream({
    url: config.streamUrl,
    contentType: config.contentType ?? "application/json",
  })
  const append = makeAppend(stream)

  return {
    // semantic-producer.PRODUCER_EFFECT.1
    // launchable-substrate-host.CLIENT_SURFACE.11
    // launchable-substrate-host.CLIENT_SURFACE.12
    // `input` is optional substrate-generic run data; it is stored
    // verbatim on the durable.run row's `data` field. `idempotencyKey`
    // travels as an event header, not on the run row value.
    declareWork: (input) =>
      Effect.gen(function* () {
        const runId = input?.runId ?? (yield* idGen.nextId)
        const event = yield* startRun({
          runId,
          ...(input?.data !== undefined ? { data: input.data } : {}),
        })
        yield* append(withIdempotencyHeader(event, input?.idempotencyKey))
        return { runId, state: "started" as const }
      }),
  }
}

const buildCompletionProducer = (
  config: SubstrateProducerConfig,
): CompletionProducerService => {
  const stream = new DurableStream({
    url: config.streamUrl,
    contentType: config.contentType ?? "application/json",
  })
  const append = makeAppend(stream)

  // Terminalization needs the kind from the existing pending record.
  // We rebuild the latest snapshot rather than caching live state
  // (semantic-producer.PRODUCER_EFFECT.3 — no hidden in-memory state).
  const loadCurrent = (completionId: string) =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.tryPromise({
        try: () => rebuildProjection({ url: config.streamUrl }),
        catch: (cause) => new ProducerStreamError({ cause }),
      })
      const current = snapshot.completions.get(completionId)
      if (current === undefined) {
        return yield* Effect.fail(new CompletionNotFoundError({ completionId }))
      }
      return current
    })

  return {
    // semantic-producer.PRODUCER_EFFECT.2
    resolveCompletion: (input) =>
      Effect.gen(function* () {
        const current = yield* loadCurrent(input.completionId)
        const event = yield* buildResolveCompletion(current, {
          result: input.result,
        })
        yield* append(event)
        return { completionId: input.completionId, state: "resolved" as const }
      }),

    // semantic-producer.PRODUCER_EFFECT.2
    rejectCompletion: (input) =>
      Effect.gen(function* () {
        const current = yield* loadCurrent(input.completionId)
        const event = yield* buildRejectCompletion(current, {
          error: input.error,
        })
        yield* append(event)
        return { completionId: input.completionId, state: "rejected" as const }
      }),

    // semantic-producer.PRODUCER_EFFECT.2
    cancelCompletion: (input) =>
      Effect.gen(function* () {
        const current = yield* loadCurrent(input.completionId)
        const event = yield* buildCancelCompletion(current, {
          terminalReason: input.terminalReason,
        })
        yield* append(event)
        return { completionId: input.completionId, state: "cancelled" as const }
      }),
  }
}

// effect-native-api.EFFECT_SERVICES.3
// semantic-producer.PACKAGE_BOUNDARY.2 — single-package wiring; one stream per live layer.
// firegrid-remediation-hardening.EFFECT_CONSISTENCY.5
// IdGen is captured at layer-build time and `IdGenLive` is provided at
// the producer's own root, so callers compose `SubstrateProducerLive`
// at zero remaining requirements. Tests that need deterministic IDs
// can either use the per-method override seams documented at each call
// site or compose a different `IdGen` layer through the kernel
// `@firegrid/substrate/id-gen` subpath.
export const SubstrateProducerLive = (
  config: SubstrateProducerConfig,
): Layer.Layer<WorkProducer | CompletionProducer> =>
  Layer.merge(
    Layer.effect(
      WorkProducer,
      Effect.map(IdGen, (idGen) => buildWorkProducer(config, idGen)),
    ),
    Layer.succeed(CompletionProducer, buildCompletionProducer(config)),
  ).pipe(Layer.provide(IdGenLive))

// Re-export the Illegal* error classes from the state machine for callers
// that catch state-machine guard rejections at the producer boundary.
export { IllegalCompletionTransition }
