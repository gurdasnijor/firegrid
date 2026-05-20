import { Chunk, Effect, Option, Stream } from "effect"
import type { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  dmChannel,
  humanChannelRegistrations,
  humanChannelTarget,
  makeChannelRegistry,
  notificationChannel,
  type HumanMessageSchema,
} from "../../src/host/index.ts"

const message = (
  handle: string,
  body: string,
): Schema.Schema.Type<typeof HumanMessageSchema> => ({
  handle,
  body,
})

describe("human channels", () => {
  it("firegrid-agent-body-plan.HUMAN_CHANNELS.1 firegrid-agent-body-plan.HUMAN_CHANNELS.3 firegrid-agent-body-plan.HUMAN_CHANNELS.4 registers dm(handle) as paired ingress/egress bindings at one opaque target", async () => {
    const sent: Array<Schema.Schema.Type<typeof HumanMessageSchema>> = []
    const inbound = message("operator", "hello")
    const dm = dmChannel({
      handle: "operator",
      incoming: Stream.succeed(inbound),
      send: payload => Effect.sync(() => {
        sent.push(payload)
      }),
    })
    const registry = makeChannelRegistry(dm.registrations)
    const metadata = registry.metadata()

    expect(dm.target).toBe("dm.operator")
    expect(metadata.map(entry => [entry.target, entry.direction])).toEqual([
      ["dm.operator", "ingress"],
      ["dm.operator", "egress"],
    ])
    for (const entry of metadata) {
      expect("binding" in entry).toBe(false)
      expect(JSON.stringify(entry)).not.toContain("mcp")
      expect(JSON.stringify(entry)).not.toContain("provider")
    }

    const ingress = dm.registrations[0]
    const observed = await Effect.runPromise(
      Stream.runCollect(ingress.binding.stream).pipe(
        Effect.map(Chunk.toReadonlyArray),
      ),
    )
    expect(observed).toEqual([inbound])

    const egress = dm.registrations[1]
    await Effect.runPromise(egress.binding.append(message("operator", "reply")))
    expect(sent).toEqual([message("operator", "reply")])
    expect(Option.getOrThrow(registry.getMetadata("dm.operator")).direction).toBe("ingress")
  })

  it("firegrid-agent-body-plan.HUMAN_CHANNELS.2 firegrid-agent-body-plan.HUMAN_CHANNELS.3 firegrid-agent-body-plan.HUMAN_CHANNELS.4 registers notification(handle) as paired ingress/egress bindings at one opaque target", async () => {
    const sent: Array<Schema.Schema.Type<typeof HumanMessageSchema>> = []
    const receipt = message("operator", "read")
    const notification = notificationChannel({
      handle: "operator",
      incoming: Stream.succeed(receipt),
      send: payload => Effect.sync(() => {
        sent.push(payload)
      }),
    })
    const registry = makeChannelRegistry(notification.registrations)

    expect(notification.target).toBe("notification.operator")
    expect(registry.metadata().map(entry => [entry.target, entry.direction])).toEqual([
      ["notification.operator", "ingress"],
      ["notification.operator", "egress"],
    ])
    await Effect.runPromise(
      notification.egress.binding.append(message("operator", "build complete")),
    )
    expect(sent).toEqual([message("operator", "build complete")])

    const observed = await Effect.runPromise(
      Stream.runCollect(notification.ingress.binding.stream).pipe(
        Effect.map(Chunk.toReadonlyArray),
      ),
    )
    expect(observed).toEqual([receipt])
  })

  it("firegrid-agent-body-plan.HUMAN_CHANNELS.1 firegrid-agent-body-plan.HUMAN_CHANNELS.2 exposes composition helpers for multiple human channels", () => {
    const dm = dmChannel({
      handle: "operator",
      incoming: Stream.empty,
      send: () => Effect.void,
    })
    const notification = notificationChannel({
      handle: "operator",
      incoming: Stream.empty,
      send: () => Effect.void,
    })
    const registrations = humanChannelRegistrations([dm, notification])

    expect(humanChannelTarget("dm", "operator")).toBe("dm.operator")
    expect(humanChannelTarget("notification", "operator")).toBe(
      "notification.operator",
    )
    expect(registrations.map(channel => [channel.target, channel.direction])).toEqual([
      ["dm.operator", "ingress"],
      ["dm.operator", "egress"],
      ["notification.operator", "ingress"],
      ["notification.operator", "egress"],
    ])
  })
})
