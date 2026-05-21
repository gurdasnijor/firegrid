import {
  HostContextSnapshotChannel,
  HostContextSnapshotChannelTarget,
  HostContextSnapshotRequestSchema,
  HostContextsChannel,
  HostContextsChannelTarget,
  HostContextsCreateChannel,
  HostContextsCreateChannelTarget,
  HostContextsCreateRequestSchema,
  HostContextsCreateResponseSchema,
  HostPermissionRespondChannel,
  HostPermissionRespondChannelRequestSchema,
  HostPermissionRespondChannelResponseSchema,
  HostPermissionRespondChannelTarget,
  HostPromptChannel,
  HostPromptChannelTarget,
  HostSessionSnapshotChannel,
  HostSessionSnapshotChannelTarget,
  HostSessionSnapshotRequestSchema,
  HostSessionsStartChannel,
  HostSessionsStartChannelTarget,
  HostSessionsStartRequestSchema,
  HostSessionsStartResponseSchema,
  RuntimeContextSnapshotSchema,
  SessionLifecycleChannel,
  SessionLifecycleChannelTarget,
  SessionPromptChannel,
  SessionPromptChannelTarget,
  makeCallableChannel,
  makeEgressChannel,
  makeIngressChannel,
  type HostPermissionRespondChannelRequest,
} from "@firegrid/protocol/channels"
import {
  RuntimeControlPlaneTable,
  RuntimeContextSchema,
  RuntimeOutputTable,
  RuntimeRunEventSchema,
  makeRuntimeContextRequestRow,
  makeRuntimeStartRequestAck,
  makeRuntimeStartRequestRow,
  runtimeContextOutputStreamUrl,
  type RuntimeContextRow,
  type RuntimeRunEventRow,
} from "@firegrid/protocol/launch"
import {
  FiregridSessionIdSchema,
  RuntimeContextIdSchema,
  SessionHandlePromptInputSchema,
  runtimeAgentOutputObservationFromRow,
} from "@firegrid/protocol/session-facade"
import {
  PublicPromptRequestSchema,
  makeRuntimeInputIntentRow,
  promptToRuntimeIngressRequest,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { stampRowOtel } from "@firegrid/protocol/otel"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { RuntimeHostConfig } from "../../config.ts"

const runStatusRank = (status: RuntimeRunEventRow["status"]): number =>
  status === "started" ? 0 : status === "failed" ? 1 : 2

const latestRunStatus = (
  runs: ReadonlyArray<RuntimeRunEventRow>,
) =>
  [...runs].sort((left, right) =>
    left.at.localeCompare(right.at) ||
    runStatusRank(left.status) - runStatusRank(right.status)).at(-1)?.status

const outputLayerForContext = (
  config: RuntimeHostConfig["Type"],
  context: RuntimeContextRow,
) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: runtimeContextOutputStreamUrl({
        baseUrl: config.durableStreamsBaseUrl,
        prefix: context.host.streamPrefix,
        contextId: context.contextId,
      }),
      contentType: "application/json",
      ...(config.headers === undefined ? {} : { headers: config.headers }),
    },
  })

const appendInputIntent = (
  control: RuntimeControlPlaneTable["Type"],
  request: RuntimeIngressRequest,
) =>
  Effect.gen(function*() {
    const stamped = yield* stampRowOtel(makeRuntimeInputIntentRow(request))
    const result = yield* control.inputIntents.insertOrGet(stamped)
    return result._tag === "Found" ? result.row : stamped
  })

const permissionResponseInput = (
  request: HostPermissionRespondChannelRequest,
): RuntimeIngressRequest => ({
  contextId: request.contextId,
  kind: "required_action_result" as const,
  authoredBy: "client" as const,
  payload: {
    _tag: "PermissionResponse",
    permissionRequestId: request.permissionRequestId,
    decision: request.decision,
  },
  idempotencyKey: request.idempotencyKey ??
    `permission-response:${request.contextId}:${request.permissionRequestId}`,
})

const appendContextCreateRequest = (
  control: RuntimeControlPlaneTable["Type"],
  request: {
    readonly contextId: string
    readonly runtime: Parameters<typeof makeRuntimeContextRequestRow>[0]["runtime"]
    readonly createdBy?: string
  },
) =>
  stampRowOtel(makeRuntimeContextRequestRow(request)).pipe(
    Effect.flatMap(row => control.contextRequests.insertOrGet(row)),
  )

type HostControlChannels =
  | HostContextsCreateChannel
  | HostPromptChannel
  | SessionPromptChannel
  | HostSessionsStartChannel
  | HostContextSnapshotChannel
  | HostSessionSnapshotChannel
  | HostContextsChannel
  | SessionLifecycleChannel
  | HostPermissionRespondChannel

export const HostControlChannelsLive =
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const control = yield* RuntimeControlPlaneTable
      const config = yield* RuntimeHostConfig

      const snapshotForContext = (contextId: string) =>
        Effect.gen(function*() {
          const context = yield* control.contexts.get(contextId)
          const runs = yield* control.runs.query(coll =>
            coll.toArray.filter(row => row.contextId === contextId))
          if (Option.isNone(context)) {
            return {
              contextId,
              runs,
              events: [],
              logs: [],
              agentOutputs: [],
              ...(latestRunStatus(runs) === undefined
                ? {}
                : { status: latestRunStatus(runs) }),
            }
          }
          const [events, logs] = yield* Effect.gen(function*() {
            const output = yield* RuntimeOutputTable
            return yield* Effect.all([
              output.events.query(coll =>
                coll.toArray.filter(row => row.contextId === contextId)),
              output.logs.query(coll =>
                coll.toArray.filter(row => row.contextId === contextId)),
            ])
          }).pipe(Effect.provide(outputLayerForContext(config, context.value)))
          return {
            contextId,
            context: context.value,
            ...(latestRunStatus(runs) === undefined
              ? {}
              : { status: latestRunStatus(runs) }),
            runs,
            events,
            logs,
            agentOutputs: events.flatMap(row => {
              const output = runtimeAgentOutputObservationFromRow(row)
              return Option.isSome(output) ? [output.value] : []
            }),
          }
        })

      return Layer.mergeAll(
        Layer.succeed(
          HostContextsCreateChannel,
          makeCallableChannel({
            target: HostContextsCreateChannelTarget,
            requestSchema: HostContextsCreateRequestSchema,
            responseSchema: HostContextsCreateResponseSchema,
            call: request =>
              Effect.gen(function*() {
                yield* appendContextCreateRequest(control, {
                  contextId: request.contextId,
                  runtime: request.runtime,
                  ...(request.createdBy === undefined
                    ? {}
                    : { createdBy: request.createdBy }),
                })
                const sessionId = yield* Schema.decodeUnknown(
                  FiregridSessionIdSchema,
                )(request.contextId)
                const contextId = yield* Schema.decodeUnknown(
                  RuntimeContextIdSchema,
                )(request.contextId)
                return {
                  sessionId,
                  contextId,
                }
              }),
          }),
        ),
        Layer.succeed(
          HostPromptChannel,
          makeEgressChannel({
            target: HostPromptChannelTarget,
            schema: PublicPromptRequestSchema,
            append: request =>
              appendInputIntent(
                control,
                promptToRuntimeIngressRequest(request),
              ).pipe(Effect.asVoid),
          }),
        ),
        Layer.succeed(SessionPromptChannel, {
          forSession: sessionId =>
            makeEgressChannel({
              target: SessionPromptChannelTarget,
              schema: SessionHandlePromptInputSchema,
              append: request =>
                appendInputIntent(control, {
                  contextId: sessionId,
                  kind: "message",
                  authoredBy: "client",
                  payload: request.payload,
                  idempotencyKey: request.idempotencyKey,
                  ...(request.metadata === undefined
                    ? {}
                    : { metadata: request.metadata }),
                }).pipe(Effect.asVoid),
            }),
        }),
        Layer.succeed(
          HostSessionsStartChannel,
          makeCallableChannel({
            target: HostSessionsStartChannelTarget,
            requestSchema: HostSessionsStartRequestSchema,
            responseSchema: HostSessionsStartResponseSchema,
            call: request =>
              Effect.gen(function*() {
                const row = makeRuntimeStartRequestRow({
                  contextId: request.sessionId,
                  requestedBy: "client",
                })
                const stamped = yield* stampRowOtel(row)
                const result = yield* control.startRequests.insertOrGet(stamped)
                return makeRuntimeStartRequestAck({
                  requestId: row.requestId,
                  contextId: row.contextId,
                  inserted: result._tag === "Inserted",
                })
              }),
          }),
        ),
        Layer.succeed(
          HostContextSnapshotChannel,
          makeCallableChannel({
            target: HostContextSnapshotChannelTarget,
            requestSchema: HostContextSnapshotRequestSchema,
            responseSchema: RuntimeContextSnapshotSchema,
            call: request => snapshotForContext(request.contextId),
          }),
        ),
        Layer.succeed(
          HostSessionSnapshotChannel,
          makeCallableChannel({
            target: HostSessionSnapshotChannelTarget,
            requestSchema: HostSessionSnapshotRequestSchema,
            responseSchema: RuntimeContextSnapshotSchema,
            call: request => snapshotForContext(request.sessionId),
          }),
        ),
        Layer.succeed(
          HostContextsChannel,
          makeIngressChannel({
            target: HostContextsChannelTarget,
            schema: RuntimeContextSchema,
            sourceClass: "static-source",
            stream: control.contexts.rows(),
          }),
        ),
        Layer.succeed(SessionLifecycleChannel, {
          forSession: sessionId =>
            makeIngressChannel({
              target: SessionLifecycleChannelTarget,
              schema: RuntimeRunEventSchema,
              sourceClass: "static-source",
              stream: control.runs.rows().pipe(
                Stream.filter(row => row.contextId === sessionId),
              ),
            }),
        }),
        Layer.succeed(
          HostPermissionRespondChannel,
          makeCallableChannel({
            target: HostPermissionRespondChannelTarget,
            requestSchema: HostPermissionRespondChannelRequestSchema,
            responseSchema: HostPermissionRespondChannelResponseSchema,
            call: request =>
              Effect.gen(function*() {
                const row = yield* appendInputIntent(
                  control,
                  permissionResponseInput(request),
                )
                return {
                  responded: true,
                  contextId: request.contextId,
                  permissionRequestId: request.permissionRequestId,
                  inputId: row.intentId,
                }
              }),
          }),
        ),
      )
    }),
  ) as Layer.Layer<
    HostControlChannels,
    never,
    RuntimeControlPlaneTable | RuntimeHostConfig
  >
