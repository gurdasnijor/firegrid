import {
  DurableDeferred,
  type WorkflowEngine,
} from "@effect/workflow"
import {
  appendJson,
  readRetainedJson,
} from "@firegrid/durable-streams"
import { Context, Effect, Layer, Schema } from "effect"
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
  ) => Effect.Effect<RequiredActionRequestedRow, RequiredActionError>
  readonly resolve: (
    resolution: RequiredActionResolveRequest,
  ) => Effect.Effect<RequiredActionResolution, RequiredActionError, WorkflowEngine.WorkflowEngine>
  readonly get: (
    requiredActionId: string,
  ) => Effect.Effect<RequiredActionState, RequiredActionError>
  readonly rows: Effect.Effect<ReadonlyArray<RequiredActionRow>, RequiredActionError>
}

export class RequiredActions extends Context.Tag("firegrid/runtime/RequiredActions")<
  RequiredActions,
  RequiredActionsService
>() {}

const nowIso = (): string => new Date().toISOString()

const decodeRow = (
  row: unknown,
): RequiredActionRow | undefined =>
  Schema.decodeUnknownOption(RequiredActionRowSchema)(row).pipe(
    option => option._tag === "Some" ? option.value : undefined,
  )

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
  const matchingRows = rows.filter(row => row.requiredActionId === requiredActionId)
  const request = matchingRows.find(
    (row): row is RequiredActionRequestedRow =>
      row.type === "firegrid.required_action.requested",
  )
  const resolution = matchingRows.find(
    (row): row is RequiredActionResolvedRow =>
      row.type === "firegrid.required_action.resolved",
  )?.resolution

  return {
    requiredActionId,
    status: resolution?.outcome ?? "requested",
    ...(request === undefined ? {} : { request }),
    ...(resolution === undefined ? {} : { resolution }),
  }
}

const appendRequiredActionRow = (
  streamUrl: string,
  row: RequiredActionRow,
) =>
  appendJson({ streamUrl, event: row }).pipe(
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
): Effect.Effect<ReadonlyArray<RequiredActionRow>, RequiredActionError> =>
  readRetainedJson<unknown>({ streamUrl }).pipe(
    Effect.map(rows => rows.flatMap(row => {
      const decoded = decodeRow(row)
      return decoded === undefined ? [] : [decoded]
    })),
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
): Effect.Effect<RequiredActionState, RequiredActionError> =>
  readRequiredActionRows(streamUrl).pipe(
    Effect.map(rows => foldRequiredActionState(requiredActionId, rows)),
  )

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
          if (existing.request !== undefined) return existing.request

          const row = Schema.decodeUnknownSync(RequiredActionRequestedRowSchema)({
            type: "firegrid.required_action.requested",
            id: requiredActionRequestedRowId(request.requiredActionId),
            at: nowIso(),
            requiredActionId: request.requiredActionId,
            runtimeContextId: request.runtimeContextId,
            requestKind: request.requestKind,
            subject: request.subject,
            ...(request.options === undefined ? {} : { options: request.options }),
            ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
            ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
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
          if (existing.request?.workflowDeferredToken !== undefined) {
            yield* DurableDeferred.succeed(RequiredActionResolutionDeferred, {
              token: existing.request.workflowDeferredToken as DurableDeferred.Token,
              value: decoded,
            })
          }
          return decoded
        }),
      get: requiredActionId =>
        // firegrid-required-actions.RECORDS.3
        getRequiredActionState(options.streamUrl, requiredActionId),
    }),
  )
