declare module "@firegrid/runtime" {
  import type { Operation } from "@firegrid/client"
  import type { Effect, Layer } from "effect"

  export interface FiregridRuntimeConnection {
    readonly streamUrl: string
  }

  export interface RunOptions {
    readonly connection: FiregridRuntimeConnection
    readonly runtime: Layer.Layer<never, unknown, unknown>
  }

  export const run: (
    options: RunOptions,
  ) => Effect.Effect<never, unknown, never>

  export const Firegrid: {
    readonly composeRuntime: (options: {
      readonly handlers?: readonly Layer.Layer<never, unknown, unknown>[]
      readonly subscribers?: readonly Layer.Layer<never, unknown, unknown>[]
      readonly provide?: readonly Layer.Layer<unknown, unknown, unknown>[]
    }) => Layer.Layer<never, unknown, unknown>
    readonly handler: <Op extends Operation.Any, Error = never, Requirements = never>(
      operation: Op,
      handler: (
        input: Operation.Input<Op>,
      ) => Effect.Effect<Operation.Output<Op>, Operation.Error<Op> | Error, Requirements>,
    ) => Layer.Layer<never, never, Requirements>
  }
}
