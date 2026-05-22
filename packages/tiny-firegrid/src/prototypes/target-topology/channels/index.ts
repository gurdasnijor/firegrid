// channels/ — the typed wire-edge capability boundary.
//
// IMPORT DIRECTION: the channel *contracts* (`IngressChannel`, `EgressChannel`,
// direction/polarity, `ChannelTarget`, `ChannelRouteCompletion`) are
// PROTOCOL-OWNED and imported from `@firegrid/protocol/channels`. This folder
// only declares the host *service tags* typed by those contracts and provides
// their bindings. No channel schema is re-declared here — moving a
// protocol-owned channel schema into this runtime folder is exactly the C7
// violation the topology forbids.
//
// Polarity lives in the type: an `EgressChannel` tag in a subscriber's `R` is a
// write-side authority; an `IngressChannel` tag is a read-side observer.

import {
  type EgressChannel,
  type IngressChannel,
  makeEgressChannel,
  makeIngressChannel,
} from "@firegrid/protocol/channels"
import { Context, Effect, Layer, Schema, Stream } from "effect"

// A minimal prompt payload schema OWNED HERE only because it is a prototype
// stand-in. In production the schema comes from the protocol channel definition;
// the host wires the binding, never the schema.
const PromptPayload = Schema.Struct({
  contextId: Schema.String,
  text: Schema.String,
})

const OutputPayload = Schema.Struct({
  contextId: Schema.String,
  sequence: Schema.Number,
})

// Egress = write side. The Shape C subscriber names this tag in `R` to dispatch
// a prompt to the agent edge through the router, not by reaching past it.
export class HostPromptChannel extends Context.Tag(
  "@proto/target-topology/HostPromptChannel",
)<HostPromptChannel, EgressChannel<typeof PromptPayload>>() {}

// Ingress = read side. Per-context typed output observation (C6).
export class SessionAgentOutputChannel extends Context.Tag(
  "@proto/target-topology/SessionAgentOutputChannel",
)<SessionAgentOutputChannel, IngressChannel<typeof OutputPayload>>() {}

export const HostPromptChannelStubLayer: Layer.Layer<HostPromptChannel> =
  Layer.succeed(
    HostPromptChannel,
    makeEgressChannel({
      target: "host.prompt",
      schema: PromptPayload,
      append: () => Effect.void,
    }),
  )

export const SessionAgentOutputChannelStubLayer: Layer.Layer<SessionAgentOutputChannel> =
  Layer.succeed(
    SessionAgentOutputChannel,
    makeIngressChannel({
      target: "session.agent.output",
      schema: OutputPayload,
      stream: Stream.empty,
    }),
  )
