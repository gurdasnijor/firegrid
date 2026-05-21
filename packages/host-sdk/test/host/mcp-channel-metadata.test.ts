import { McpSchema } from "@effect/ai"
import { Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeBidirectionalChannel,
  makeCallableChannel,
  makeEgressChannel,
  makeIngressChannel,
} from "@firegrid/protocol/channels"
import {
  channelMetadata,
} from "../../src/host/channel.ts"
import {
  enrichRuntimeContextMcpToolWithChannelMetadata,
  runtimeContextMcpChannelCatalog,
} from "../../src/host/mcp-channel-metadata.ts"

const FactoryEventRowSchema = Schema.Struct({
  eventType: Schema.String,
  payload: Schema.Unknown,
})

const NotifySchema = Schema.Struct({
  message: Schema.String,
})

const ApprovalRequestSchema = Schema.Struct({
  prompt: Schema.String,
})

const ApprovalResponseSchema = Schema.Struct({
  approved: Schema.Boolean,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

describe("runtime-context MCP channel metadata", () => {
  it("firegrid-agent-body-plan.MCP_CHANNEL_METADATA.1 projects name, direction, and schema for registered channels", () => {
    const channels = [
      makeIngressChannel({
        target: "factory.events",
        schema: FactoryEventRowSchema,
        stream: Stream.empty,
      }),
      makeEgressChannel({
        target: "notification.operator",
        schema: NotifySchema,
        append: () => Effect.void,
      }),
      makeBidirectionalChannel({
        target: "event.plan.ready",
        schema: FactoryEventRowSchema,
        sourceClasses: ["static-source", "predicate-eligible"],
        stream: Stream.empty,
        append: () => Effect.void,
      }),
      makeCallableChannel({
        target: "approval.operator",
        requestSchema: ApprovalRequestSchema,
        responseSchema: ApprovalResponseSchema,
        call: () => Effect.succeed({ approved: true }),
      }),
    ]
    const inventory = runtimeContextMcpChannelCatalog(channels.map(channelMetadata))

    expect(inventory.map(entry => [entry.name, entry.direction])).toEqual([
      ["factory.events", "ingress"],
      ["notification.operator", "egress"],
      ["event.plan.ready", "bidirectional"],
      ["approval.operator", "call"],
    ])
    expect(inventory[0]?.schema).toHaveProperty("row")
    expect(inventory[1]?.schema).toHaveProperty("payload")
    expect(inventory[2]?.schema).toHaveProperty("row")
    expect(inventory[2]?.schema).toHaveProperty("payload")
    const callEntry = inventory.find(entry => entry.direction === "call")
    expect(callEntry).toBeDefined()
    if (callEntry === undefined) {
      return
    }
    expect(isRecord(callEntry.schema.request)).toBe(true)
    expect(isRecord(callEntry.schema.response)).toBe(true)
    if (isRecord(callEntry.schema.request)) {
      expect(callEntry.schema.request.type).toBe("object")
    }
    if (isRecord(callEntry.schema.response)) {
      expect(callEntry.schema.response.type).toBe("object")
    }
  })

  it("firegrid-agent-body-plan.MCP_CHANNEL_METADATA.1 firegrid-agent-body-plan.MCP_CHANNEL_METADATA.2 firegrid-agent-body-plan.MCP_CHANNEL_METADATA.3 enriches wait_for tools/list metadata without substrate names", async () => {
    const channel = makeIngressChannel({
      target: "factory.events",
      schema: FactoryEventRowSchema,
      stream: Stream.empty,
    })
    const inventory = runtimeContextMcpChannelCatalog([
      {
        target: channel.target,
        direction: channel.direction,
        schema: channel.schema,
      },
    ])
    const tool = new McpSchema.Tool({
      name: "wait_for",
      description: "Wait until a matching durable event appears.",
      inputSchema: { type: "object", properties: {} },
    })
    enrichRuntimeContextMcpToolWithChannelMetadata(
      tool,
      inventory,
    )

    expect(tool).toBeDefined()
    expect(tool?.description).toContain("Registered Firegrid channels")
    expect(tool?.description).toContain("factory.events (ingress)")
    expect(isRecord(tool?.inputSchema)).toBe(true)
    if (!isRecord(tool?.inputSchema)) {
      return
    }
    const metadataInventory = tool.inputSchema["x-firegrid-channels"]
    expect(Array.isArray(metadataInventory)).toBe(true)
    if (!Array.isArray(metadataInventory)) {
      return
    }
    const firstEntry: unknown = metadataInventory[0]
    expect(isRecord(firstEntry)).toBe(true)
    if (!isRecord(firstEntry)) {
      return
    }
    expect(firstEntry.name).toBe("factory.events")
    expect(firstEntry.direction).toBe("ingress")
    expect(isRecord(firstEntry.schema)).toBe(true)
    if (!isRecord(firstEntry.schema)) {
      return
    }
    expect(isRecord(firstEntry.schema.row)).toBe(true)
    if (!isRecord(firstEntry.schema.row)) {
      return
    }
    expect(firstEntry.schema.row.type).toBe("object")
    expect(isRecord(firstEntry.schema.row.properties)).toBe(true)
    if (!isRecord(firstEntry.schema.row.properties)) {
      return
    }
    expect(isRecord(firstEntry.schema.row.properties.eventType)).toBe(true)
    if (isRecord(firstEntry.schema.row.properties.eventType)) {
      expect(firstEntry.schema.row.properties.eventType.type).toBe("string")
    }

    const metadataText = JSON.stringify(metadataInventory)
    expect(metadataText).not.toContain("CallerFact")
    expect(metadataText).not.toContain("DurableTable")
    expect(metadataText).not.toContain("stream")
  })
})
