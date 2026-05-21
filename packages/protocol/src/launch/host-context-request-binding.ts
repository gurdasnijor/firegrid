import { Effect, Schema } from "effect"
import { stampRowOtel } from "../otel/row-otel.ts"
import {
  FiregridSessionIdSchema,
  RuntimeContextIdSchema,
  type SessionHandleReference,
} from "../session-facade/schema.ts"
import { makeRuntimeContextRequestRow } from "./control-request.ts"
import type { RuntimeControlPlaneTableService } from "./table.ts"
import type { PublicLaunchRuntimeIntent } from "./schema.ts"

export const requestRuntimeContextCreate = (
  control: RuntimeControlPlaneTableService,
  request: {
    readonly contextId: string
    readonly runtime: PublicLaunchRuntimeIntent
    readonly createdBy?: string | undefined
  },
): Effect.Effect<SessionHandleReference, unknown> =>
  Effect.gen(function*() {
    const stamped = yield* stampRowOtel(
      makeRuntimeContextRequestRow({
        contextId: request.contextId,
        runtime: request.runtime,
        ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
      }),
    )
    yield* control.contextRequests.insertOrGet(stamped)
    const sessionId = yield* Schema.decodeUnknown(FiregridSessionIdSchema)(
      request.contextId,
    )
    const contextId = yield* Schema.decodeUnknown(RuntimeContextIdSchema)(
      request.contextId,
    )
    return { sessionId, contextId }
  })
