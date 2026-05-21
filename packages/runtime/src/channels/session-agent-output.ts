import {
  type HostStreamPrefix,
  RuntimeOutputTable,
  runtimeContextOutputStreamUrl,
} from "@firegrid/protocol/launch"
import { RuntimeAgentOutputObservationSchema } from "@firegrid/protocol/session-facade"
import {
  makeIngressChannel,
  SessionAgentOutputChannelTarget,
  type SessionAgentOutputChannelRegistration,
} from "@firegrid/protocol/channels"
import type { DurableTableHeaders } from "effect-durable-operators"
import { Effect, Stream } from "effect"
import { runtimeAgentOutputObservationFromRow } from "../agent-event-pipeline/events/index.ts"

// tf-bffo: the durable SessionAgentOutput channel implementation lives in the
// runtime (the privileged durable core). host-sdk only COMPOSES it — it resolves
// the host topology config and CurrentHostSession and calls this builder. The
// channel is the only above-box doorway to this durable output stream.
export interface SessionAgentOutputChannelOptions {
  readonly durableStreamsBaseUrl: string
  readonly streamPrefix: HostStreamPrefix
  readonly headers?: DurableTableHeaders
  readonly contextId: string
}

const outputTableLayer = (options: SessionAgentOutputChannelOptions) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: runtimeContextOutputStreamUrl({
        baseUrl: options.durableStreamsBaseUrl,
        prefix: options.streamPrefix,
        contextId: options.contextId,
      }),
      contentType: "application/json",
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    },
  })

const runtimeAgentOutputRows = (table: RuntimeOutputTable["Type"]) =>
  table.events.rows().pipe(
    Stream.filterMap(runtimeAgentOutputObservationFromRow),
  )

export const sessionAgentOutputChannel = (
  options: SessionAgentOutputChannelOptions,
): SessionAgentOutputChannelRegistration =>
  makeIngressChannel({
    target: SessionAgentOutputChannelTarget,
    schema: RuntimeAgentOutputObservationSchema,
    sourceClass: "static-source",
    stream: Stream.unwrap(
      Effect.map(RuntimeOutputTable, runtimeAgentOutputRows),
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
