import { Effect } from "effect"

type FiregridSide = "driver" | "host" | "codec" | "subprocess" | "sdk"

export const annotateSide = (side: FiregridSide) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.withSpan(self, `firegrid.side.${side}`, {
      attributes: { "firegrid.side": side },
      kind: "internal",
    })
