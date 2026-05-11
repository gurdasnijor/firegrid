import { type HttpClient } from "@effect/platform"
import {
  DurableDeferred,
  type WorkflowEngine,
} from "@effect/workflow"
import { Context, Effect, Layer, Schema } from "effect"
import { DurableStream } from "effect-durable-streams"
import {
  requiredActionRequestedRowId,
  requiredActionResolvedRowId,
} from "./ids.ts"
import {
  RequiredActionRequestedRowSchema,
  RequiredActionResolutionSchema,
  RequiredActionResolveRequestSchema,
  RequiredActionResolvedRowSchema,
  RequiredActionRowSchema,
  type RequiredActionRequest,
  type RequiredActionRequestedRow,
  type RequiredActionResolution,
  type RequiredActionResolveRequest,
  type RequiredActionResolvedRow,
  type RequiredActionRow,
  type RequiredActionState,
  type RequiredActionError,
  requiredActionError,
} from "./schema.ts"
import {
  RequiredActionResolutionDeferred,
} from "./deferred.ts"

export interface RequiredActionsOptions {
  readonly streamUrl: string
}

interface RequiredActionsService {
  readonly request: (
    request: RequiredActionRequest,
  ) => Effect.Effect<RequiredActionRequestedRow, RequiredActionError, HttpClient.HttpClient>
  readonly resolve: (
    resolution: RequiredActionResolveRequest,
  ) => Effect.Effect<RequiredActionResolution, RequiredActionError, HttpClient.HttpClient | WorkflowEngine.WorkflowEngine>
  readonly get: (
    requiredActionId: string,
  ) => Effect.Effect<RequiredActionState, RequiredActionError, HttpClient.HttpClient>
  readonly rows: Effect.Effect<ReadonlyArray<RequiredActionRow>, RequiredActionError, HttpClient.HttpClient>
}

export class RequiredActions extends Context.Tag("firegrid/runtime/RequiredActions")<
  RequiredActions,
  RequiredActionsService
>() {}

const nowIso = (): string => new Date().toISOString()

const requiredActionStream = (
  streamUrl: string,
) =>
  DurableStream.define({
    endpoint: { url: streamUrl },
    schema: RequiredActionRowSchema,
  })

const sameResolution = (
  left: RequiredActionResolution,
  right: RequiredActionResolution,
): boolean =>
  left.outcome === right.outcome &&
  left.selectedOptionId === right.selectedOptionId &&
  left.reason === right.reason

const foldRequiredActionState = (
  requiredActionId: string,
  rows: ReadonlyArray<RequiredActionRow>,
): RequiredActionState => {
  const { request, resolved } = rows.reduce<{
    readonly request?: RequiredActionRequestedRow
    readonly resolved?: RequiredActionResolvedRow
  }>((state, row) => {
    if (row.requiredActionId !== requiredActionId) return state
    if (row.type === "firegrid.required_action.requested") {
      return { ...state, request: row }
    }
    return { ...state, resolved: row }
  }, {})

  return {
    requiredActionId,
    status: resolved?.resolution.outcome ?? "requested",
    ...(request === undefined ? {} : { request }),
    ...(resolved === undefined ? {} : { resolution: resolved.resolution }),
  }
}

const appendRequiredActionRow = (
  streamUrl: string,
  row: RequiredActionRow,
): Effect.Effect<void, RequiredActionError, HttpClient.HttpClient> =>
  // effect-native-production-cutover.REQUIRED_ACTION.2
  requiredActionStream(streamUrl).append(row).pipe(
    Effect.asVoid,
    Effect.mapError(cause =>
      requiredActionError(
        "append",
        "failed to append required-action durable row",
        row.requiredActionId,
        cause,
      )),
  )

const readRequiredActionRows = (
  streamUrl: string,
): Effect.Effect<ReadonlyArray<RequiredActionRow>, RequiredActionError, HttpClient.HttpClient> =>
  // effect-native-production-cutover.REQUIRED_ACTION.1
  requiredActionStream(streamUrl).collect.pipe(
    Effect.mapError(cause =>
      requiredActionError(
        "read",
        "failed to read required-action durable rows",
        undefined,
        cause,
      )),
  )

const getRequiredActionState = (
  streamUrl: string,
  requiredActionId: string,
): Effect.Effect<RequiredActionState, RequiredActionError, HttpClient.HttpClient> =>
  readRequiredActionRows(streamUrl).pipe(
    Effect.map(rows => foldRequiredActionState(requiredActionId, rows)),
  )

const completeRequiredActionDeferred = (
  request: RequiredActionRequestedRow | undefined,
  resolution: RequiredActionResolution,
) =>
  request?.workflowDeferredToken === undefined
    ? Effect.void
    : DurableDeferred.succeed(RequiredActionResolutionDeferred, {
      token: request.workflowDeferredToken as DurableDeferred.Token,
      value: resolution,
    })

export const RequiredActionsLive = (
  options: RequiredActionsOptions,
) =>
  Layer.succeed(
    RequiredActions,
    RequiredActions.of({
      rows: readRequiredActionRows(options.streamUrl),
      request: request =>
        Effect.gen(function* () {
          const existing = yield* getRequiredActionState(
            options.streamUrl,
            request.requiredActionId,
          )
          if (
            existing.request !== undefined &&
            (
              existing.request.workflowDeferredToken !== undefined ||
              request.workflowDeferredToken === undefined
            )
          ) {
            return existing.request
          }

          const row = Schema.decodeUnknownSync(RequiredActionRequestedRowSchema)({
            type: "firegrid.required_action.requested",
            id: requiredActionRequestedRowId(request.requiredActionId),
            at: nowIso(),
            requiredActionId: request.requiredActionId,
            runtimeContextId: existing.request?.runtimeContextId ?? request.runtimeContextId,
            requestKind: existing.request?.requestKind ?? request.requestKind,
            subject: existing.request?.subject ?? request.subject,
            ...((existing.request?.options ?? request.options) === undefined
              ? {}
              : { options: existing.request?.options ?? request.options }),
            ...((existing.request?.prompt ?? request.prompt) === undefined
              ? {}
              : { prompt: existing.request?.prompt ?? request.prompt }),
            ...((existing.request?.expiresAt ?? request.expiresAt) === undefined
              ? {}
              : { expiresAt: existing.request?.expiresAt ?? request.expiresAt }),
            ...(request.workflowDeferredToken === undefined
              ? {}
              : { workflowDeferredToken: request.workflowDeferredToken }),
          })

          // firegrid-required-actions.RECORDS.1
          // firegrid-required-actions.WORKFLOW.1
          yield* appendRequiredActionRow(options.streamUrl, row)
          return row
        }),
      resolve: resolution =>
        Effect.gen(function* () {
          const requested = Schema.decodeUnknownSync(RequiredActionResolveRequestSchema)(resolution)
          const decoded = Schema.decodeUnknownSync(RequiredActionResolutionSchema)({
            ...requested,
            resolvedAt: requested.resolvedAt ?? nowIso(),
          })
          const existing = yield* getRequiredActionState(
            options.streamUrl,
            decoded.requiredActionId,
          )
          if (existing.resolution !== undefined) {
            // firegrid-required-actions.WORKFLOW.4
            // firegrid-required-actions.WORKFLOW.5
            yield* completeRequiredActionDeferred(existing.request, existing.resolution)
            return sameResolution(existing.resolution, decoded)
              ? existing.resolution
              : existing.resolution
          }

          const row = Schema.decodeUnknownSync(RequiredActionResolvedRowSchema)({
            type: "firegrid.required_action.resolved",
            id: requiredActionResolvedRowId(decoded.requiredActionId),
            at: decoded.resolvedAt,
            requiredActionId: decoded.requiredActionId,
            resolution: decoded,
          })

          // firegrid-required-actions.RECORDS.2
          // firegrid-required-actions.WORKFLOW.3
          yield* appendRequiredActionRow(options.streamUrl, row)
          yield* completeRequiredActionDeferred(existing.request, decoded)
          return decoded
        }),
      get: requiredActionId =>
        // firegrid-required-actions.RECORDS.3
        getRequiredActionState(options.streamUrl, requiredActionId),
    }),
  )
