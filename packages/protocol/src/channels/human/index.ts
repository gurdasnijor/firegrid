// Pure human-channel vocabulary helpers (DM + notification channel
// constructors over `HumanMessageSchema` + the underlying
// `humanChannelPair` factory).
//
// Relocated from the deleted host-sdk path
// `host-sdk/src/host/human-channel.ts` (Class D channel-Lives
// relocation; per dispatch: "pure human vocabulary -> protocol/channels/
// human; runtime live bits, if any, stay runtime/channels"). This file
// is entirely pure (protocol contract constructors + Effect/Stream
// signatures); no host-sdk, runtime, or durable-tables imports. Eligible
// for protocol's CLI-safe / browser-safe subpath.

import type { Effect, Stream } from "effect"
import { makeIngressChannel, makeEgressChannel, makeChannelTarget, type ChannelTarget, type HumanChannelKind, type HumanChannelPair, humanChannelTarget } from "../index.ts"
import type { Schema } from "effect"

export const humanChannelPair = <S extends Schema.Schema.Any>(
  options: {
    readonly kind: HumanChannelKind
    readonly handle: string
    readonly target?: ChannelTarget | string
    readonly schema: S
    readonly incoming: Stream.Stream<Schema.Schema.Type<S>, unknown, never>
    readonly send: (
      payload: Schema.Schema.Type<S>,
    ) => Effect.Effect<void, unknown, never>
  },
): HumanChannelPair<S> => {
  const target = options.target === undefined
    ? humanChannelTarget(options.kind, options.handle)
    : typeof options.target === "string"
    ? makeChannelTarget(options.target)
    : options.target
  const ingress = makeIngressChannel({
    target,
    schema: options.schema,
    stream: options.incoming,
  })
  const egress = makeEgressChannel({
    target,
    schema: options.schema,
    append: options.send,
  })
  return {
    kind: options.kind,
    handle: options.handle,
    target,
    ingress,
    egress,
    registrations: [ingress, egress],
  }
}
