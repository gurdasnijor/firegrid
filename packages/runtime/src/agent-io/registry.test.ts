/**
 * Tests for the static codec registry.
 *
 * The registry is intentionally minimal — lookup by kind + duplicate
 * detection. Codec authoring is a per-codec concern (Phase 1 PR 2/3).
 */

import { Effect, Option, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type { AgentByteStream } from "./byte-stream.ts"
import { AgentCodecError, type AgentCodec } from "./codec.ts"
import type { AgentInputEvent, AgentOutputEvent } from "./contract.ts"
import { makeCodecRegistry } from "./registry.ts"

const stubSession = {
  send: (_event: AgentInputEvent) =>
    Effect.fail(
      new AgentCodecError({
        codec: "stub",
        op: "send",
        message: "stub codec does not handle inputs",
      }),
    ),
  outputs: Stream.empty as Stream.Stream<AgentOutputEvent, AgentCodecError>,
}

const stubCodec = (kind: string): AgentCodec => ({
  kind,
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
  open: (_bytes: AgentByteStream) => Effect.succeed(stubSession),
})

describe("makeCodecRegistry", () => {
  it("returns the codec for a known kind", () => {
    const { registry, conflicts } = makeCodecRegistry([
      stubCodec("stdio-jsonl"),
      stubCodec("acp"),
    ])
    expect(registry.has("stdio-jsonl")).toBe(true)
    expect(Option.isSome(registry.get("stdio-jsonl"))).toBe(true)
    expect(registry.kinds).toEqual(["stdio-jsonl", "acp"])
    expect(conflicts).toEqual([])
  })

  it("returns Option.none for an unknown kind", () => {
    const { registry } = makeCodecRegistry([stubCodec("stdio-jsonl")])
    expect(registry.has("acp")).toBe(false)
    expect(Option.isNone(registry.get("acp"))).toBe(true)
  })

  it("returns conflicts for duplicate codec kinds and keeps the first registration", () => {
    const first = stubCodec("acp")
    const second = stubCodec("acp")
    const { registry, conflicts } = makeCodecRegistry([first, second])
    expect(registry.kinds).toEqual(["acp"])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ kind: "acp" })
    expect(Option.getOrThrow(registry.get("acp"))).toBe(first)
  })
})
