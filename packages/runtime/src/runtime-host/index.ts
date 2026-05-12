import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import {
  DurableStreamsWorkflowEngine,
} from "@firegrid/durable-streams/workflow-engine"
import { Context, Effect, Layer } from "effect"
import { DurableStream } from "effect-durable-streams"
import {
  RuntimeContextWorkflowLayer,
} from "../runtime-context/workflow.ts"
import {
  RuntimeControlPlaneLive,
} from "../runtime-context/service.ts"
import {
  startRuntimeContext,
  type StartRuntimeContextOptions,
  type StartRuntimeResult,
} from "../runtime-context/launcher.ts"
import type {
  RuntimeContextError,
} from "../runtime-context/errors.ts"
import {
  LocalProcessSandboxProvider,
} from "../providers/sandboxes/index.ts"
import {
  asRuntimeContextError,
} from "../runtime-context/errors.ts"
import {
  type SessionInputError,
  type SessionInputRequest,
  type SessionInputRow,
  SessionInputRowSchema,
  sessionInputError,
} from "../session-input/index.ts"
import {
  makeSessionInputRow,
} from "../session-input/rows.ts"
import { Schema } from "effect"
import {
  RuntimeInputStreamsSchema,
  runtimeInputDisabled,
} from "./input.ts"

// Schema-backed host config: validation + defaulting happens once at
// `FiregridRuntimeHostLive`. Callers may pass either a plain options
// object (it's `Schema.decodeUnknownSync`'d at the boundary) or
// already-decoded values from elsewhere.
export const RuntimeHostStreamsSchema = Schema.Struct({
  workflow: Schema.String,
  controlPlane: Schema.String,
  runtimeOutput: Schema.String,
  /**
   * Runtime input capability. Tagged so the misconfiguration "session input
   * stream without a checkpoint stream" is unrepresentable at the type
   * level. Omitting `input` decodes to {@link runtimeInputDisabled}.
   *
   * Use `new RuntimeInputDurableStreams({ sessionInput, checkpoints })` to
   * enable durable input. Both streams must be pre-created.
   */
  input: Schema.optionalWith(RuntimeInputStreamsSchema, {
    default: () => runtimeInputDisabled,
  }),
})
export type RuntimeHostStreams = Schema.Schema.Type<typeof RuntimeHostStreamsSchema>
export type RuntimeHostStreamsInput = Schema.Schema.Encoded<typeof RuntimeHostStreamsSchema>

export const RuntimeHostOptionsSchema = Schema.Struct({
  streams: RuntimeHostStreamsSchema,
  workerId: Schema.optional(Schema.String),
})
export type RuntimeHostOptions = Schema.Schema.Type<typeof RuntimeHostOptionsSchema>
export type RuntimeHostOptionsInput = Schema.Schema.Encoded<typeof RuntimeHostOptionsSchema>

export type StartRuntimeOptions = StartRuntimeContextOptions

interface FiregridRuntimeHostService {
  readonly start: (
    options: StartRuntimeOptions,
  ) => Effect.Effect<StartRuntimeResult, RuntimeContextError>
  readonly sessionInput: (
    request: SessionInputRequest,
  ) => Effect.Effect<SessionInputRow, SessionInputError>
}

export class FiregridRuntimeHost extends Context.Tag("firegrid/runtime/FiregridRuntimeHost")<
  FiregridRuntimeHost,
  FiregridRuntimeHostService
>() {}

const appendSessionInputRow = (
  streamUrl: string,
  row: SessionInputRow,
): Effect.Effect<void, SessionInputError, HttpClient.HttpClient> =>
  // effect-native-production-cutover.RUNTIME_IO.2
  DurableStream.define({
    endpoint: { url: streamUrl },
    schema: SessionInputRowSchema,
  }).append(row).pipe(
    Effect.asVoid,
    Effect.mapError(cause =>
      sessionInputError(
        "append",
        "failed to append session input durable row",
        row.contextId,
        row.sessionInputId,
        cause,
      )),
  )

const appendSessionInputRequestToStream = (
  streamUrl: string,
  request: SessionInputRequest,
): Effect.Effect<SessionInputRow, SessionInputError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const row = makeSessionInputRow(request)
    // firegrid-agent-ingress.INGRESS.1
    // firegrid-agent-ingress.INGRESS.3
    // firegrid-agent-ingress.INGRESS.6
    // firegrid-agent-ingress.HOST.1
    yield* appendSessionInputRow(streamUrl, row)
    return row
  })

const runtimeContextLayer = (
  options: RuntimeHostOptions,
) =>
  // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.1
  // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.2
  // effect-native-production-cutover.RUNTIME_IO.4
  //
  // No misconfiguration guard needed: `RuntimeInputStreams` is a tagged
  // union, so "session input without checkpoints" is unrepresentable at the
  // type level.
  RuntimeContextWorkflowLayer({
    runtimeOutputStreamUrl: options.streams.runtimeOutput,
    input: options.streams.input,
  }).pipe(
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: options.streams.workflow,
      ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    })),
    Layer.provide(RuntimeControlPlaneLive({
      streamUrl: options.streams.controlPlane,
    })),
    Layer.provide(LocalProcessSandboxProvider.layer()),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeContext.layer),
  )

/**
 * Wires the Firegrid runtime host.
 *
 * Accepts options in **decoded** shape (returned by
 * `Schema.decode(RuntimeHostOptionsSchema)`) OR in **encoded** shape
 * (plain JS object with optional `streams.input`). Plain-object input
 * is normalized through `Schema.decodeUnknownSync(RuntimeHostOptionsSchema)`
 * at this single boundary, which:
 *   - validates the shape (rejects unknown/half-formed `input` values
 *     such as `{ _tag: "RuntimeInputDurableStreams", sessionInput: "..." }`
 *     missing `checkpoints`),
 *   - applies the `input -> runtimeInputDisabled` default,
 *   - constructs class instances for the tagged union members.
 *
 * Any callers further down the stack receive the normalized
 * `RuntimeHostOptions` value and never re-decode.
 */
export const FiregridRuntimeHostLive = (
  options: RuntimeHostOptions | RuntimeHostOptionsInput,
) => {
  const normalized: RuntimeHostOptions =
    Schema.decodeUnknownSync(RuntimeHostOptionsSchema)(options)
  return Layer.succeed(
    FiregridRuntimeHost,
    FiregridRuntimeHost.of({
      start: request =>
        startRuntimeContext(request).pipe(
          Effect.provide(runtimeContextLayer(normalized)),
          Effect.catchTags({
            RuntimeControlPlaneError: cause =>
              Effect.fail(asRuntimeContextError(
                `runtime-control-plane.${cause.op}`,
                "failed to initialize runtime control plane",
                request.contextId,
                cause,
              )),
            WorkflowStateStoreError: cause =>
              Effect.fail(asRuntimeContextError(
                `workflow-state.${cause.op}`,
                "failed to run runtime context workflow state",
                request.contextId,
                cause,
              )),
          }),
        ),
      sessionInput: request =>
        // firegrid-agent-ingress.HOST.1
        // firegrid-agent-ingress.HOST.2
        normalized.streams.input._tag === "RuntimeInputDurableStreams"
          ? appendSessionInputRequestToStream(
              normalized.streams.input.sessionInput,
              request,
            ).pipe(Effect.provide(FetchHttpClient.layer))
          : Effect.fail(sessionInputError(
              "append",
              "session input stream is not configured",
              request.contextId,
              request.sessionInputId,
            )),
    }),
  )
}

export const startRuntime = (
  options: StartRuntimeOptions,
): Effect.Effect<StartRuntimeResult, RuntimeContextError, FiregridRuntimeHost> =>
  // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.3
  FiregridRuntimeHost.pipe(
    Effect.flatMap(host => host.start(options)),
  )

export const appendSessionInput = (
  request: SessionInputRequest,
): Effect.Effect<SessionInputRow, SessionInputError, FiregridRuntimeHost> =>
  // firegrid-agent-ingress.HOST.1
  FiregridRuntimeHost.pipe(
    Effect.flatMap(host => host.sessionInput(request)),
  )
