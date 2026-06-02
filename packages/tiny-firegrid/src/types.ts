import type {
  Firegrid,
} from "@firegrid/client-sdk/firegrid"
import type {
  FiregridRuntime as RuntimeFiregridRuntime,
} from "@firegrid/runtime/unified"
import type { ChannelRegistration } from "@firegrid/protocol/channels"
import type { Effect, Layer } from "effect"

export type FiregridHost = Layer.Layer.Success<
  ReturnType<typeof RuntimeFiregridRuntime>
>

export interface TinyFiregridStopSignal {
  readonly complete: Effect.Effect<void>
}

export interface TinyFiregridHostEnv {
  readonly simulationId: string
  readonly runId: string
  readonly namespace: string
  readonly durableStreamsBaseUrl: string
  readonly processEnv: NodeJS.ProcessEnv
  readonly stopSignal: TinyFiregridStopSignal
}

export interface TinyFiregridSimulationDefinition<A, E = unknown> {
  readonly id: string
  readonly description: string
  readonly host: (
    env: TinyFiregridHostEnv,
  ) => Layer.Layer<FiregridHost, E>
  readonly channels?: (
    env: TinyFiregridHostEnv,
  ) => ReadonlyArray<ChannelRegistration>
  readonly launchHost?: boolean
  readonly driver: Effect.Effect<A, E, Firegrid>
}

declare const TinyFiregridSimulationBrand: unique symbol

export type TinyFiregridSimulation<A, E = unknown> =
  TinyFiregridSimulationDefinition<A, E> & {
    readonly [TinyFiregridSimulationBrand]: typeof TinyFiregridSimulationBrand
  }

export const defineSimulation = <A, E = unknown>(
  simulation: TinyFiregridSimulationDefinition<A, E>,
): TinyFiregridSimulation<A, E> =>
  simulation as TinyFiregridSimulation<A, E>
