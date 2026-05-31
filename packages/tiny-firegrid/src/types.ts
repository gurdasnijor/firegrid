import type {
  Firegrid,
} from "@firegrid/client-sdk/firegrid"
import type {
  CurrentHostSession,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  RuntimeStartCapability,
} from "@firegrid/protocol/launch"
import type { SessionAgentOutputChannel } from "@firegrid/protocol/channels"
import type { RuntimeChannelRouter } from "@firegrid/runtime/channels/router/live"
import type { Effect, Layer } from "effect"

export type FiregridHost =
  | RuntimeStartCapability
  | SessionAgentOutputChannel
  | CurrentHostSession
  | RuntimeControlPlaneTable
  | RuntimeOutputTable
  | RuntimeChannelRouter

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

export interface TinyFiregridSimulation<A, E = unknown> {
  readonly id: string
  readonly description: string
  readonly host: (
    env: TinyFiregridHostEnv,
  ) => Layer.Layer<FiregridHost, E>
  readonly driver: Effect.Effect<A, E, Firegrid>
}

export const defineSimulation = <A, E = unknown>(
  simulation: TinyFiregridSimulation<A, E>,
): TinyFiregridSimulation<A, E> => simulation
