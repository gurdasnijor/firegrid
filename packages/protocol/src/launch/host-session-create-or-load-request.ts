import {
  HostSessionsCreateOrLoadChannelTarget,
  HostSessionsCreateOrLoadRequestSchema,
  HostSessionsCreateOrLoadResponseSchema,
  makeCallableChannel,
} from "../channels/index.ts"
import { stampRowOtel } from "../otel/row-otel.ts"
import {
  sessionContextIdForExternalKey,
  type SessionCreateOrLoadInput,
  type SessionHandleReference,
} from "../session-facade/schema.ts"
import { makeRuntimeContextRequestRow } from "./control-request.ts"
import {
  RuntimeControlPlaneTable,
  type RuntimeControlPlaneTableService,
} from "./table.ts"
import { Effect } from "effect"

export const requestHostSessionCreateOrLoad = (
  request: SessionCreateOrLoadInput,
  options?: {
    readonly bindingSource?: string
  },
): Effect.Effect<SessionHandleReference, unknown, RuntimeControlPlaneTable> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- RuntimeControlPlaneTable's DurableTable service still leaks any through collection methods; the declared Effect R channel is the protocol launch boundary.
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    const contextId = sessionContextIdForExternalKey(request.externalKey)
    const stamped = yield* stampRowOtel(
      makeRuntimeContextRequestRow({
        contextId,
        runtime: request.runtime,
        ...(request.createdBy === undefined
          ? {}
          : { createdBy: request.createdBy }),
      }),
    )
    yield* control.contextRequests.insertOrGet(stamped)
    return {
      sessionId: contextId,
      contextId,
    }
  }).pipe(
    Effect.withSpan("firegrid.channel.host.sessions.create_or_load.call", {
      kind: "internal",
      attributes: {
        "firegrid.channel.target": HostSessionsCreateOrLoadChannelTarget,
        "firegrid.channel.direction": "call",
        "firegrid.channel.binding_pattern": "request-row-only",
        ...(options?.bindingSource === undefined
          ? {}
          : { "firegrid.channel.binding_source": options.bindingSource }),
        "firegrid.external_key.source": request.externalKey.source,
        "firegrid.external_key.id": request.externalKey.id,
      },
    }),
  )

export const makeHostSessionsCreateOrLoadRequestRowChannel = (
  control: RuntimeControlPlaneTableService,
  options?: {
    readonly bindingSource?: string
  },
) =>
  makeCallableChannel({
    target: HostSessionsCreateOrLoadChannelTarget,
    requestSchema: HostSessionsCreateOrLoadRequestSchema,
    responseSchema: HostSessionsCreateOrLoadResponseSchema,
    call: (request) =>
      requestHostSessionCreateOrLoad(request, options).pipe(
        Effect.provideService(RuntimeControlPlaneTable, control),
      ),
  })
