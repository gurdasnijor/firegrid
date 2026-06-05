import type { FiregridConfig } from "@firegrid/client-sdk/config"
import type {
  FiregridRuntime as RuntimeFiregridRuntime,
} from "@firegrid/runtime/unified"
import type { ChannelRegistration } from "@firegrid/protocol/channels"
import type { Effect, Layer } from "effect"
import type { CoverageSpec } from "./runner/coverage.ts"

export type { CoverageSpec } from "./runner/coverage.ts"

export type FiregridHost = Layer.Layer.Success<
  ReturnType<typeof RuntimeFiregridRuntime>
>

export interface FirelabStopSignal {
  readonly complete: Effect.Effect<void>
}

export interface FirelabHostEnv {
  readonly experimentId: string
  readonly runId: string
  readonly namespace: string
  readonly durableStreamsBaseUrl: string
  readonly processEnv: NodeJS.ProcessEnv
  readonly stopSignal: FirelabStopSignal
}

export interface FirelabExperimentDefinition<A, E = unknown> {
  readonly id: string
  readonly description: string
  readonly host?: (
    env: FirelabHostEnv,
  ) => Layer.Layer<FiregridHost, E>
  readonly channels?: (
    env: FirelabHostEnv,
  ) => ReadonlyArray<ChannelRegistration>
  readonly launchHost?: boolean
  readonly driver: Effect.Effect<A, E, FiregridConfig>
  /**
   * The trace-coverage oracle for this simulation. The verdict is computed from
   * the run's host-substrate OTel spans (runner/coverage.ts), not asserted by the
   * driver. `gates` decide the verdict and are lint-restricted to forge-proof
   * host-substrate span names; `corroborations` are report-only. Optional during
   * migration — a sim without a spec runs but produces no computed verdict.
   */
  readonly coverage?: CoverageSpec
}

declare const FirelabExperimentBrand: unique symbol

export type FirelabExperiment<A, E = unknown> =
  FirelabExperimentDefinition<A, E> & {
    readonly [FirelabExperimentBrand]: typeof FirelabExperimentBrand
  }

export const defineExperiment = <A, E = unknown>(
  simulation: FirelabExperimentDefinition<A, E>,
): FirelabExperiment<A, E> =>
  simulation as FirelabExperiment<A, E>
