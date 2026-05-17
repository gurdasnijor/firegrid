import {
  hostOwnedStreamUrl,
  provideRuntimeContext,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  RuntimeIngressTable,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Effect } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import {
  RuntimeIngressAppendAndGet,
  RuntimeIngressAppenderLayer,
  runtimeIngressError,
} from "@firegrid/runtime/host-substrate"
import type { RuntimeHostConfig } from "../config.ts"

const ownerIngressLayer = (
  options: {
    readonly baseUrl: string
    readonly headers?: DurableTableHeaders
    readonly context: RuntimeContext
  },
) =>
  RuntimeIngressTable.layer({
    streamOptions: {
      url: hostOwnedStreamUrl({
        baseUrl: options.baseUrl,
        prefix: options.context.host.streamPrefix,
        segment: "runtimeIngress",
      }),
      contentType: "application/json",
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    },
  })

export const appendRuntimeIngressToOwner = (
  request: RuntimeIngressRequest,
  context: RuntimeContext,
  options: RuntimeHostConfig["Type"],
) =>
  appendRuntimeIngressInCurrentContext(request).pipe(
    provideRuntimeContext(context),
    Effect.provide(RuntimeIngressAppenderLayer({
      currentContextId: context.contextId,
    })),
    Effect.provide(ownerIngressLayer({
      baseUrl: options.durableStreamsBaseUrl,
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      context,
    })),
    Effect.scoped,
  )

const appendRuntimeIngressInCurrentContext = (
  request: RuntimeIngressRequest,
) =>
  Effect.gen(function* () {
    const appendIngress = yield* RuntimeIngressAppendAndGet
    return yield* appendIngress.append(request)
  }).pipe(
    Effect.mapError(cause =>
      runtimeIngressError(
        "append",
        "failed to append runtime ingress durable row",
        request.contextId,
        request.inputId,
        cause,
      )),
  )
