import {
  FiregridLocalHostLive,
  type FiregridHost,
} from "@firegrid/host-sdk"
import {
  durableStreamUrl,
} from "@firegrid/protocol/launch"
import {
  FiregridLocalProcessFromEnv,
} from "@firegrid/host-sdk"
import {
  makeBidirectionalChannel,
} from "@firegrid/protocol/channels"
import {
  makeHostSessionsCreateOrLoadRequestRowChannel,
  RuntimeControlPlaneTable,
  runtimeControlPlaneStreamUrl,
} from "@firegrid/protocol/launch"
import type {
  SessionCreateOrLoadInput,
  SessionHandleReference,
} from "@firegrid/protocol/session-facade"
import {
  CallerOwnedFactStreams,
} from "@firegrid/runtime/streams"
import {
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

interface DurableChannelsSyncAsyncEnv {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly runId: string
}

const runtimeEnvLatch = (() => {
  let resolveRuntimeEnv: (env: DurableChannelsSyncAsyncEnv) => void =
    () => undefined
  const promise = new Promise<DurableChannelsSyncAsyncEnv>((resolve) => {
    resolveRuntimeEnv = resolve
  })
  return {
    promise,
    resolve: resolveRuntimeEnv,
  }
})()

export const durableChannelsSyncAsyncEnv = runtimeEnvLatch.promise

export const mailboxChannelTarget = "tf-lfxs.events"
export const driverResultMarker = "FIREGRID_TF_LFXS_SYNC_ASYNC_DONE"

const MailboxRowSchema = Schema.Struct({
  id: Schema.String.pipe(DurableTable.primaryKey),
  kind: Schema.String,
  shard: Schema.String,
  body: Schema.String,
})

class DurableChannelsMailboxTable extends DurableTable(
  "tfLfxsDurableChannelsMailbox",
  {
    rows: MailboxRowSchema,
  },
) {}

const controlPlaneLayer = (
  env: DurableChannelsSyncAsyncEnv,
) =>
  RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      }),
      contentType: "application/json",
    },
  })

const mailboxLayerOptions = (
  env: DurableChannelsSyncAsyncEnv,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(
      env.durableStreamsBaseUrl,
      `${env.namespace}.tf-lfxs.sync-async.mailbox.${env.runId}`,
    ),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const mailboxChannel = (
  table: DurableChannelsMailboxTable["Type"],
) =>
  makeBidirectionalChannel({
    target: mailboxChannelTarget,
    schema: MailboxRowSchema,
    sourceClasses: ["static-source", "predicate-eligible"],
    stream: table.rows.rows(),
    append: payload =>
      table.rows.insertOrGet(payload).pipe(Effect.asVoid),
  })

const reflectedHostSessionsCreateOrLoadChannel = (
  control: RuntimeControlPlaneTable["Type"],
) => {
  const requestRowChannel = makeHostSessionsCreateOrLoadRequestRowChannel(
    control,
    { bindingSource: "tf-lfxs-sync-handshake-spike" },
  )

  return {
    ...requestRowChannel,
    binding: {
      ...requestRowChannel.binding,
      call: (request: SessionCreateOrLoadInput) =>
        requestRowChannel.binding.call(request).pipe(
          Effect.tap(response =>
            control.contexts.rows().pipe(
              Stream.filter(context =>
                context.contextId === response.contextId),
              Stream.runHead,
              Effect.flatMap(Option.match({
                onNone: () =>
                  Effect.fail(
                    new Error(
                      `context ${response.contextId} was not reflected`,
                    ),
                  ),
                onSome: context => Effect.succeed(context),
              })),
            ),
          ),
          Effect.map((response): SessionHandleReference => ({
            contextId: response.contextId,
            sessionId: response.sessionId,
          })),
          Effect.withSpan("firegrid.tf_lfxs.sync_handshake.call", {
            kind: "client",
            attributes: {
              "firegrid.channel.target": String(requestRowChannel.target),
              "firegrid.channel.direction": "call",
              "firegrid.tf_lfxs.barrier": "request-row-to-context-reflection",
            },
          }),
        ),
    },
  }
}

export const durableChannelsReflectedCreateOrLoad = (
  env: DurableChannelsSyncAsyncEnv,
  request: SessionCreateOrLoadInput,
): Effect.Effect<SessionHandleReference, unknown> =>
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    const channel = reflectedHostSessionsCreateOrLoadChannel(control)
    return yield* channel.binding.call(request)
  }).pipe(
    Effect.provide(controlPlaneLayer(env)),
  )

export const durableChannelsSyncAsyncHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  const simEnv: DurableChannelsSyncAsyncEnv = {
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    runId: env.runId,
  }
  runtimeEnvLatch.resolve(simEnv)

  const mailboxTable = DurableChannelsMailboxTable.layer(
    mailboxLayerOptions(simEnv),
  )

  const host = Layer.unwrapEffect(
    Effect.gen(function*() {
      const table = yield* DurableChannelsMailboxTable
      const channel = mailboxChannel(table)
      const callerFacts = Layer.succeed(CallerOwnedFactStreams, {
        streamFor: (stream: string) =>
          stream === mailboxChannelTarget ? table.rows.rows() : Stream.empty,
      })

      return FiregridLocalHostLive({
        durableStreamsBaseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
        input: true,
        mcpChannels: [channel],
      }).pipe(
        Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
        Layer.provideMerge(callerFacts),
      )
    }),
  ).pipe(
    Layer.provide(mailboxTable),
  )

  return host as Layer.Layer<FiregridHost, unknown, never>
}
