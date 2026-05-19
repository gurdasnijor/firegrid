import type {
  Firegrid,
} from "@firegrid/client-sdk/firegrid"
import type {
  FiregridHost,
  RuntimeHostTopologyOptions,
} from "@firegrid/host-sdk"
import type { Effect, Layer } from "effect"

export interface TinyFiregridSimulationEnv {
  readonly id: string
  readonly runId: string
  readonly namespace: string
  readonly durableStreamsBaseUrl: string
  readonly runDir: string
  readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
  readonly processEnv: NodeJS.ProcessEnv
}

export interface TinyFiregridSimulation<A> {
  readonly id: string
  readonly description: string
  readonly makeHost: (
    env: TinyFiregridSimulationEnv,
  ) => Layer.Layer<FiregridHost, unknown>
  readonly driver: (
    env: TinyFiregridSimulationEnv,
  ) => Effect.Effect<A, unknown, Firegrid>
  readonly summarize: (result: A) => Record<string, unknown>
  readonly localize?: (result: A) => ReadonlyArray<string>
}
