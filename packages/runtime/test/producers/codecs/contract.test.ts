import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentCodecs from "../../../src/producers/codecs/index.ts"
import { AgentSession } from "../../../src/producers/codecs/index.ts"

describe("AgentSession", () => {
  it("firegrid-runtime-boundary-reconciliation.CODEC_SESSION.1 firegrid-runtime-boundary-reconciliation.CODEC_SESSION.2 is provided as an Effect Context.Tag service", async () => {
    const session = await Effect.runPromise(
      AgentSession.pipe(
        Effect.provide(
          Layer.succeed(AgentSession, {
            meta: {
              kind: "test",
              capabilities: {
                streamingText: true,
                tools: false,
                permissions: false,
                images: false,
                structuredInput: false,
                cancellation: false,
                multiTurn: false,
                customStatus: [],
              },
            },
            toolUseMode: "observation_only",
            send: () => Effect.void,
            outputs: Stream.empty,
          }),
        ),
      ),
    )

    expect(session.meta.kind).toBe("test")
    expect(session.toolUseMode).toBe("observation_only")
  })

  it("firegrid-runtime-boundary-reconciliation.CODEC_SESSION.7 does not export the retired active codec objects or descriptor helper", () => {
    expect("AcpCodec" in AgentCodecs).toBe(false)
    expect("StdioJsonlCodec" in AgentCodecs).toBe(false)
    expect("defineAgentTool" in AgentCodecs).toBe(false)
  })
})
