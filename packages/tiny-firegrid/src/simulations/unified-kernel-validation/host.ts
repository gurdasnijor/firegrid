/**
 * unified-kernel-validation host.
 *
 * Exposes the runtime scenarios to the driver via the module latch
 * pattern used by other tiny-firegrid simulations. Each scenario is
 * scoped to its own URL space so reruns against a persistent durable-
 * streams backend don't collide.
 *
 * Each scenario drives the product surface through `UnifiedChannels`
 * (the channel registry that, in production, would replace the Shape
 * C / DurableDeferred control-plane bindings).
 */

import type { FiregridHost } from "@firegrid/runtime/composition/host-live"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Effect, Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import {
  boundedOwnershipScenario,
  type BoundedOwnershipResult,
  crashRecoveryScenario,
  type CrashRecoveryResult,
  endToEndScenario,
  type EndToEndResult,
  toolIdempotencyScenario,
  type ToolIdempotencyResult,
  webhookBadHmacScenario,
  type WebhookBadHmacResult,
} from "./scenarios.ts"
import {
  endToEndViaFiregridClient,
  type FiregridClientE2EResult,
} from "./firegrid-client-scenarios.ts"
import type { GenerationUrls } from "./substrate.ts"

export interface UnifiedKernelRuntime {
  readonly runEndToEnd: Effect.Effect<EndToEndResult, unknown>
  readonly runCrashRecovery: Effect.Effect<CrashRecoveryResult, unknown>
  readonly runToolIdempotency: Effect.Effect<ToolIdempotencyResult, unknown>
  readonly runWebhookBadHmac: Effect.Effect<WebhookBadHmacResult, unknown>
  readonly runBoundedOwnership: Effect.Effect<BoundedOwnershipResult, unknown>
  readonly runEndToEndViaFiregridClient: Effect.Effect<FiregridClientE2EResult, unknown>
}

const runtimeLatch = (() => {
  let resolveRuntime: (runtime: UnifiedKernelRuntime) => void = () => undefined
  const promise = new Promise<UnifiedKernelRuntime>((resolve) => {
    resolveRuntime = resolve
  })
  return { promise, resolve: resolveRuntime }
})()

export const unifiedKernelRuntime = runtimeLatch.promise

const urlsFor = (env: TinyFiregridHostEnv, scenarioId: string): GenerationUrls => ({
  engineStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.ukv.${env.runId}.${scenarioId}.engine`,
  ),
  unifiedTableStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.ukv.${env.runId}.${scenarioId}.unified`,
  ),
  signalTableStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.ukv.${env.runId}.${scenarioId}.signals`,
  ),
})

export const unifiedKernelValidationHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> =>
  Layer.scopedDiscard(
    Effect.sync(() => {
      runtimeLatch.resolve({
        runEndToEnd: endToEndScenario(urlsFor(env, "end-to-end")),
        runCrashRecovery: crashRecoveryScenario(urlsFor(env, "crash-recovery")),
        runToolIdempotency: toolIdempotencyScenario(urlsFor(env, "tool-idempotency")),
        runWebhookBadHmac: webhookBadHmacScenario(urlsFor(env, "webhook-bad-hmac")),
        runBoundedOwnership: boundedOwnershipScenario(urlsFor(env, "bounded-ownership")),
        runEndToEndViaFiregridClient: endToEndViaFiregridClient(
          urlsFor(env, "firegrid-client-e2e"),
          `${env.namespace}.ukv-fg.${env.runId}`,
        ),
      })
    }),
  ) as unknown as Layer.Layer<FiregridHost, unknown, never>
