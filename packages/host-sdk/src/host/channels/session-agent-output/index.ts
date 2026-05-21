import {
  CurrentHostSession,
  RuntimeOutputTable,
  runtimeContextOutputStreamUrl,
} from "@firegrid/protocol/launch"
import {
  RuntimeAgentOutputObservationSchema,
} from "@firegrid/protocol/session-facade"
import {
  makeIngressChannel,
  SessionAgentOutputChannel,
  SessionAgentOutputChannelTarget,
  type SessionAgentOutputChannelRegistration,
} from "@firegrid/protocol/channels"
import {
  runtimeAgentOutputObservationFromRow,
} from "@firegrid/runtime/events"
import { Effect, Layer, Stream } from "effect"
import {
  RuntimeHostConfig,
} from "../../config.ts"

const outputTableLayer = (
  options: {
    readonly hostConfig: RuntimeHostConfig["Type"]
    readonly hostSession: CurrentHostSession["Type"]
    readonly contextId: string
  },
) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: runtimeContextOutputStreamUrl({
        baseUrl: options.hostConfig.durableStreamsBaseUrl,
        prefix: options.hostSession.streamPrefix,
        contextId: options.contextId,
      }),
      contentType: "application/json",
      ...(options.hostConfig.headers === undefined
        ? {}
        : { headers: options.hostConfig.headers }),
    },
  })

export const sessionAgentOutputChannel = (
  options: {
    readonly hostConfig: RuntimeHostConfig["Type"]
    readonly hostSession: CurrentHostSession["Type"]
    readonly contextId: string
  },
): SessionAgentOutputChannelRegistration =>
  makeIngressChannel({
    target: SessionAgentOutputChannelTarget,
    schema: RuntimeAgentOutputObservationSchema,
    sourceClass: "static-source",
    stream: Stream.unwrap(
      Effect.map(RuntimeOutputTable, table =>
        table.events.rows().pipe(
          Stream.filterMap(runtimeAgentOutputObservationFromRow),
        )),
    ).pipe(
      Stream.provideLayer(outputTableLayer(options)),
      Stream.withSpan("firegrid.host.channel.session_agent_output", {
        kind: "internal",
        attributes: {
          "firegrid.context.id": options.contextId,
        },
      }),
    ),
  })

export const SessionAgentOutputChannelLive: Layer.Layer<
  SessionAgentOutputChannel,
  never,
  RuntimeHostConfig | CurrentHostSession
> =
  Layer.effect(
    SessionAgentOutputChannel,
    Effect.gen(function*() {
      const hostConfig = yield* RuntimeHostConfig
      const hostSession = yield* CurrentHostSession
      return SessionAgentOutputChannel.of({
        forContext: contextId =>
          sessionAgentOutputChannel({
            hostConfig,
            hostSession,
            contextId,
          }),
      })
    }),
  )
