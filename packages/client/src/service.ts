import { Context, type Effect, type Stream } from "effect"
import type { Operation, OperationHandle } from "@firegrid/substrate/descriptors"
import type { EventStreamClientService } from "./event-streams.ts"
import type {
  ObserveError,
  ResultError,
  SendError,
} from "./operations.ts"

export interface FiregridClientConfig {
  readonly streamUrl: string
  readonly contentType?: string
  readonly clientId?: string
}

export type OperationState<Op extends Operation.Any> =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Completed"; readonly output: Operation.Output<Op> }
  | { readonly _tag: "Failed"; readonly error: Operation.Error<Op> }
  | { readonly _tag: "Cancelled"; readonly terminalReason?: unknown }

export interface FiregridClientService extends EventStreamClientService {
  readonly send: <Op extends Operation.Any>(
    op: Op,
    input: Operation.Input<Op>,
  ) => Effect.Effect<OperationHandle<Op>, SendError>

  readonly result: <Op extends Operation.Any>(
    op: Op,
    handle: OperationHandle<Op>,
  ) => Effect.Effect<Operation.Output<Op>, ResultError | Operation.Error<Op>>

  readonly call: <Op extends Operation.Any>(
    op: Op,
    input: Operation.Input<Op>,
  ) => Effect.Effect<
    Operation.Output<Op>,
    SendError | ResultError | Operation.Error<Op>
  >

  readonly observe: <Op extends Operation.Any>(
    op: Op,
    handle: OperationHandle<Op>,
  ) => Stream.Stream<OperationState<Op>, ObserveError>
}

export class FiregridClient extends Context.Tag("firegrid/FiregridClient")<
  FiregridClient,
  FiregridClientService
>() {}
