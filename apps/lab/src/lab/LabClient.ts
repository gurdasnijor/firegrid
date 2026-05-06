/* eslint-disable @effect/no-import-from-barrel-package -- firegrid-client-api.LAB_COMPATIBILITY.1: the lab seam intentionally consumes the production @firegrid/client root. */
import {
  FiregridClient,
  FiregridClientLive,
  Operation,
  OperationHandle,
  type OperationState,
} from "@firegrid/client"
/* eslint-enable @effect/no-import-from-barrel-package */
import { Effect, Schema, Stream } from "effect"
import type { LabEvent } from "./lab-events.ts"
import { LabEvents } from "./lab-events.ts"

interface LabClientConfig {
  readonly streamUrl: string
}

interface LabClient {
  readonly typedEvents: {
    readonly emit: (event: LabEvent) => Effect.Effect<void, unknown>
    readonly events: () => Stream.Stream<LabEvent, unknown>
  }
  readonly operations: {
    readonly sendEcho: (
      input: LabEchoOperationInput,
    ) => Effect.Effect<LabOperationHandle, unknown>
    readonly callEcho: (
      input: LabEchoOperationInput,
    ) => Effect.Effect<LabOperationOutput, unknown>
    readonly resultEcho: (
      handle: LabOperationHandle,
    ) => Effect.Effect<LabOperationOutput, unknown>
    readonly observeEcho: (
      handle: LabOperationHandle,
    ) => Stream.Stream<LabOperationState, unknown>
  }
}

interface LabEchoOperationInput {
  readonly message: string
  readonly count: number
}

export interface LabOperationHandle {
  readonly id: string
  readonly operation: string
}

export interface LabOperationOutput {
  readonly echoed: string
  readonly total: number
}

export type LabOperationState =
  | { readonly _tag: "Pending" }
  | {
      readonly _tag: "Completed"
      readonly output: LabOperationOutput
    }
  | {
      readonly _tag: "Failed"
      readonly error: { readonly code: string; readonly message: string }
    }
  | { readonly _tag: "Cancelled"; readonly terminalReason?: unknown }

const LabEchoOperation = Operation.define({
  name: "lab.echo",
  input: Schema.Struct({
    message: Schema.String,
    count: Schema.NumberFromString,
  }),
  output: Schema.Struct({
    echoed: Schema.String,
    total: Schema.NumberFromString,
  }),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
})

const layerFor = (cfg: LabClientConfig) =>
  FiregridClientLive({
    streamUrl: cfg.streamUrl,
    clientId: "firegrid-lab",
  })

const emitLabEvent = (
  cfg: LabClientConfig,
  event: LabEvent,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const client = yield* FiregridClient
    yield* client.emit(LabEvents, event)
  }).pipe(Effect.provide(layerFor(cfg)))

const labEvents = (
  cfg: LabClientConfig,
): Stream.Stream<LabEvent, unknown> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* FiregridClient
      return client.events(LabEvents)
    }).pipe(Effect.provide(layerFor(cfg))),
  )

const toLabOperationHandle = (
  handle: OperationHandle<typeof LabEchoOperation>,
): LabOperationHandle => ({
  id: handle.id,
  operation: handle._operation,
})

const fromLabOperationHandle = (
  handle: LabOperationHandle,
): OperationHandle<typeof LabEchoOperation> =>
  OperationHandle.make(LabEchoOperation, handle.id)

const toLabOperationState = (
  state: OperationState<typeof LabEchoOperation>,
): LabOperationState => state

const sendEchoOperation = (
  cfg: LabClientConfig,
  input: LabEchoOperationInput,
): Effect.Effect<LabOperationHandle, unknown> =>
  Effect.gen(function* () {
    const client = yield* FiregridClient
    const handle = yield* client.send(LabEchoOperation, input)
    return toLabOperationHandle(handle)
  }).pipe(Effect.provide(layerFor(cfg)))

const callEchoOperation = (
  cfg: LabClientConfig,
  input: LabEchoOperationInput,
): Effect.Effect<LabOperationOutput, unknown> =>
  Effect.gen(function* () {
    const client = yield* FiregridClient
    return yield* client.call(LabEchoOperation, input)
  }).pipe(Effect.provide(layerFor(cfg)))

const resultEchoOperation = (
  cfg: LabClientConfig,
  handle: LabOperationHandle,
): Effect.Effect<LabOperationOutput, unknown> =>
  Effect.gen(function* () {
    const client = yield* FiregridClient
    return yield* client.result(
      LabEchoOperation,
      fromLabOperationHandle(handle),
    )
  }).pipe(Effect.provide(layerFor(cfg)))

const observeEchoOperation = (
  cfg: LabClientConfig,
  handle: LabOperationHandle,
): Stream.Stream<LabOperationState, unknown> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* FiregridClient
      return client
        .observe(LabEchoOperation, fromLabOperationHandle(handle))
        .pipe(Stream.map(toLabOperationState))
    }).pipe(Effect.provide(layerFor(cfg))),
  )

// firegrid-client-api.LAB_COMPATIBILITY.1
// firegrid-client-api.CLIENT_SURFACE.1
// firegrid-client-api.CLIENT_SURFACE.2
// firegrid-client-api.CLIENT_SURFACE.4
// firegrid-client-api.LAB_COMPATIBILITY.3
// firegrid-client-api.LAB_COMPATIBILITY.4
// firegrid-client-api.AUTHORITY_BOUNDARY.1
// firegrid-client-api.AUTHORITY_BOUNDARY.2
// runtime-lab-inspector.WRITE_BOUNDARY.1
// runtime-lab-inspector.NO_PRIVILEGED_LAB.2
//
// App-local seam between React UI code and the current production
// Firegrid client adapter. C2 can swap the implementation behind
// this boundary without exposing raw writers, runtime registration,
// substrate kernel authority, claims, or terminalization to lab UI
// components.
export const createLabClient = (cfg: LabClientConfig): LabClient => ({
  typedEvents: {
    emit: (event) => emitLabEvent(cfg, event),
    events: () => labEvents(cfg),
  },
  operations: {
    sendEcho: (input) => sendEchoOperation(cfg, input),
    callEcho: (input) => callEchoOperation(cfg, input),
    resultEcho: (handle) => resultEchoOperation(cfg, handle),
    observeEcho: (handle) => observeEchoOperation(cfg, handle),
  },
})
