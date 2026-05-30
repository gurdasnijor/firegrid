/**
 * unified-kernel-validation host.
 *
 * Exposes the runtime probes (P1A..P5E2E) to the driver via the module
 * latch pattern used by other tiny-firegrid simulations (kernel-owned-
 * write-arm, inv5-cross-agent-event-choreography). Each probe builds
 * its own GenerationUrls scoped to the run namespace + runId + probe
 * id, so probes are isolated across simulation runs (rerunning the
 * sim against a persistent durable-streams backend doesn't collide
 * with a previous run's state).
 *
 * The host layer is a `Layer.scopedDiscard` that resolves the latch
 * once. The driver consumes the latch via `Effect.promise`. This is
 * the same minimal-host shape the kernel-owned-write-arm simulation
 * uses.
 */

import type { FiregridHost } from "@firegrid/runtime/composition/host-live"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Effect, Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import {
  probeP1A,
  probeP1B,
  probeP1C,
  type ProbeP1AResult,
  type ProbeP1BResult,
  type ProbeP1CResult,
} from "./probes/p1-signal.ts"
import {
  probeP2A,
  probeP2B,
  probeP2C,
  type ProbeP2AResult,
  type ProbeP2BResult,
  type ProbeP2CResult,
} from "./probes/p2-session.ts"
import {
  probeP3A,
  probeP3B,
  type ProbeP3AResult,
  type ProbeP3BResult,
} from "./probes/p3-permission-tool.ts"
import {
  probeP4A,
  probeP4B,
  probeP4C,
  probeP4D,
  type ProbeP4AResult,
  type ProbeP4BResult,
  type ProbeP4CResult,
  type ProbeP4DResult,
} from "./probes/p4-scheduled-webhook-peer.ts"
import {
  probeP5E2E,
  type ProbeP5E2EResult,
} from "./probes/p5-end-to-end.ts"
import type { GenerationUrls } from "./substrate.ts"

export interface UnifiedKernelRuntime {
  readonly runProbeP1A: Effect.Effect<ProbeP1AResult, unknown>
  readonly runProbeP1B: Effect.Effect<ProbeP1BResult, unknown>
  readonly runProbeP1C: Effect.Effect<ProbeP1CResult, unknown>
  readonly runProbeP2A: Effect.Effect<ProbeP2AResult, unknown>
  readonly runProbeP2B: Effect.Effect<ProbeP2BResult, unknown>
  readonly runProbeP2C: Effect.Effect<ProbeP2CResult, unknown>
  readonly runProbeP3A: Effect.Effect<ProbeP3AResult, unknown>
  readonly runProbeP3B: Effect.Effect<ProbeP3BResult, unknown>
  readonly runProbeP4A: Effect.Effect<ProbeP4AResult, unknown>
  readonly runProbeP4B: Effect.Effect<ProbeP4BResult, unknown>
  readonly runProbeP4C: Effect.Effect<ProbeP4CResult, unknown>
  readonly runProbeP4D: Effect.Effect<ProbeP4DResult, unknown>
  readonly runProbeP5E2E: Effect.Effect<ProbeP5E2EResult, unknown>
}

const runtimeLatch = (() => {
  let resolveRuntime: (runtime: UnifiedKernelRuntime) => void = () => undefined
  const promise = new Promise<UnifiedKernelRuntime>((resolve) => {
    resolveRuntime = resolve
  })
  return { promise, resolve: resolveRuntime }
})()

export const unifiedKernelRuntime = runtimeLatch.promise

const urlsFor = (env: TinyFiregridHostEnv, probeId: string): GenerationUrls => ({
  engineStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.ukv.${env.runId}.${probeId}.engine`,
  ),
  unifiedTableStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.ukv.${env.runId}.${probeId}.unified`,
  ),
  signalTableStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.ukv.${env.runId}.${probeId}.signals`,
  ),
})

export const unifiedKernelValidationHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> =>
  Layer.scopedDiscard(
    Effect.sync(() => {
      runtimeLatch.resolve({
        runProbeP1A: probeP1A(urlsFor(env, "p1a")),
        runProbeP1B: probeP1B(urlsFor(env, "p1b")),
        runProbeP1C: probeP1C(urlsFor(env, "p1c")),
        runProbeP2A: probeP2A(urlsFor(env, "p2a")),
        runProbeP2B: probeP2B(urlsFor(env, "p2b")),
        runProbeP2C: probeP2C(urlsFor(env, "p2c")),
        runProbeP3A: probeP3A(urlsFor(env, "p3a")),
        runProbeP3B: probeP3B(urlsFor(env, "p3b")),
        runProbeP4A: probeP4A(urlsFor(env, "p4a")),
        runProbeP4B: probeP4B(urlsFor(env, "p4b")),
        runProbeP4C: probeP4C(urlsFor(env, "p4c")),
        runProbeP4D: probeP4D(urlsFor(env, "p4d")),
        runProbeP5E2E: probeP5E2E(urlsFor(env, "p5e2e")),
      })
    }),
  ) as unknown as Layer.Layer<FiregridHost, unknown, never>
