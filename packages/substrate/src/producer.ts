import { randomUUID } from "node:crypto"
import { DurableStream } from "@durable-streams/client"
import type { ChangeEvent } from "@durable-streams/state"
import { Context, Effect, Layer } from "effect"
import {
  cancelCompletion as buildCancelCompletion,
  rejectCompletion as buildRejectCompletion,
  resolveCompletion as buildResolveCompletion,
  IllegalCompletionTransition,
  startRun,
} from "./state-machine.js"
import { rebuildProjection } from "./stream.js"

// effect-native-api.EFFECT_SERVICES.3
// semantic-producer.PRODUCER_ROLE.7 — config is provided through the layer
// factory `SubstrateProducerLive(config)`, not as a separately exported config
// service. The internal Tag stays private to producer.ts.
class SubstrateProducerConfig extends Context.Tag(
  "Substrate/ProducerConfig",
)<
  SubstrateProducerConfig,
  { readonly streamUrl: string; readonly contentType?: string }
>() {}

export class ProducerStreamError extends Error {
  readonly _tag = "ProducerStreamError"
  constructor(readonly cause: unknown) {
    super(`producer stream error: ${String(cause)}`)
  }
}

export class CompletionNotFoundError extends Error {
  readonly _tag = "CompletionNotFoundError"
  constructor(readonly completionId: string) {
    super(`completion ${completionId} not found in retained stream`)
  }
}

// effect-native-api.EFFECT_SERVICES.1
// semantic-producer.PRODUCER_ROLE.1, .2, .5
// semantic-producer.PRODUCER_EFFECT.1, .3, .5
// Work declaration only; run terminalization is owned by claim-and-operator-authority.
export class WorkProducer extends Effect.Service<WorkProducer>()(
  "Substrate/WorkProducer",
  {
    effect: Effect.gen(function* () {
      const config = yield* SubstrateProducerConfig
      const stream = new DurableStream({
        url: config.streamUrl,
        contentType: config.contentType ?? "application/json",
      })

      const append = (event: ChangeEvent) =>
        Effect.tryPromise({
          try: () => stream.append(JSON.stringify(event)),
          catch: (cause) => new ProducerStreamError(cause),
        })

      return {
        // semantic-producer.PRODUCER_EFFECT.1
        // Returns durable identity + projection-relevant state, never a handle.
        declareWork: (input?: { readonly runId?: string }) =>
          Effect.gen(function* () {
            const runId = input?.runId ?? randomUUID()
            const event = startRun({ runId })
            yield* append(event)
            return { runId, state: "started" as const }
          }),
      }
    }),
  },
) {}

// effect-native-api.EFFECT_SERVICES.1
// semantic-producer.PRODUCER_ROLE.1, .2, .5
// semantic-producer.PRODUCER_EFFECT.2, .3, .5
// Completion terminalization only; pending creation is owned by Slice 7
// (durable-waits-and-scheduling.AWAKEABLE_API).
export class CompletionProducer extends Effect.Service<CompletionProducer>()(
  "Substrate/CompletionProducer",
  {
    effect: Effect.gen(function* () {
      const config = yield* SubstrateProducerConfig
      const stream = new DurableStream({
        url: config.streamUrl,
        contentType: config.contentType ?? "application/json",
      })

      const append = (event: ChangeEvent) =>
        Effect.tryPromise({
          try: () => stream.append(JSON.stringify(event)),
          catch: (cause) => new ProducerStreamError(cause),
        })

      // Terminalization needs the kind from the existing pending record.
      // We rebuild the latest snapshot rather than caching live state
      // (semantic-producer.PRODUCER_EFFECT.3 — no hidden in-memory state).
      const loadCurrent = (completionId: string) =>
        Effect.gen(function* () {
          const snapshot = yield* Effect.tryPromise({
            try: () => rebuildProjection({ url: config.streamUrl }),
            catch: (cause) => new ProducerStreamError(cause),
          })
          const current = snapshot.completions.get(completionId)
          if (current === undefined) {
            return yield* Effect.fail(new CompletionNotFoundError(completionId))
          }
          return current
        })

      // effect-native-api.EFFECT_SERVICES.6
      // State-machine builders throw IllegalCompletionTransition synchronously
      // for direct callers (Slice 2 boundary). At the producer boundary that
      // throw is wrapped into the Effect error channel so callers can recover
      // via Effect.either / Effect.catchTag. Anything else surfaces as a defect.
      const tryBuild = <A>(build: () => A) =>
        Effect.try({
          try: build,
          catch: (cause): IllegalCompletionTransition => {
            if (cause instanceof IllegalCompletionTransition) return cause
            throw cause
          },
        })

      return {
        // semantic-producer.PRODUCER_EFFECT.2
        resolveCompletion: (input: {
          readonly completionId: string
          readonly result: unknown
        }) =>
          Effect.gen(function* () {
            const current = yield* loadCurrent(input.completionId)
            const event = yield* tryBuild(() =>
              buildResolveCompletion(current, { result: input.result }),
            )
            yield* append(event)
            return { completionId: input.completionId, state: "resolved" as const }
          }),

        // semantic-producer.PRODUCER_EFFECT.2
        rejectCompletion: (input: {
          readonly completionId: string
          readonly error: unknown
        }) =>
          Effect.gen(function* () {
            const current = yield* loadCurrent(input.completionId)
            const event = yield* tryBuild(() =>
              buildRejectCompletion(current, { error: input.error }),
            )
            yield* append(event)
            return { completionId: input.completionId, state: "rejected" as const }
          }),

        // semantic-producer.PRODUCER_EFFECT.2
        cancelCompletion: (input: {
          readonly completionId: string
          readonly terminalReason: unknown
        }) =>
          Effect.gen(function* () {
            const current = yield* loadCurrent(input.completionId)
            const event = yield* tryBuild(() =>
              buildCancelCompletion(current, { terminalReason: input.terminalReason }),
            )
            yield* append(event)
            return { completionId: input.completionId, state: "cancelled" as const }
          }),
      }
    }),
  },
) {}

// effect-native-api.EFFECT_SERVICES.3
// semantic-producer.PACKAGE_BOUNDARY.2 — single-package wiring; one stream per live layer.
// Returns a Layer with zero remaining requirements when given streamUrl.
export const SubstrateProducerLive = (
  config: { readonly streamUrl: string; readonly contentType?: string },
): Layer.Layer<WorkProducer | CompletionProducer> =>
  Layer.provide(
    Layer.merge(WorkProducer.Default, CompletionProducer.Default),
    Layer.succeed(SubstrateProducerConfig, config),
  )

// Re-export the Illegal* error classes from the state machine for callers
// that catch state-machine guard rejections at the producer boundary.
export { IllegalCompletionTransition }
