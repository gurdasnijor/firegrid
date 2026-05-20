import { McpSchema, McpServer } from "@effect/ai"
import { Effect, JSONSchema } from "effect"
import {
  ChannelInventory,
  channelMetadata,
  type ChannelMetadata,
} from "./channel.ts"

const channelInventoryExtensionKey = "x-firegrid-channels"
const waitForToolName = "wait_for"

type RuntimeContextMcpChannelInventoryEntry =
  | {
    readonly name: string
    readonly direction: "ingress"
    readonly schema: { readonly row: JSONSchema.JsonSchema7Root }
  }
  | {
    readonly name: string
    readonly direction: "egress"
    readonly schema: { readonly payload: JSONSchema.JsonSchema7Root }
  }
  | {
    readonly name: string
    readonly direction: "bidirectional"
    readonly schema: {
      readonly row: JSONSchema.JsonSchema7Root
      readonly payload: JSONSchema.JsonSchema7Root
    }
  }
  | {
    readonly name: string
    readonly direction: "call"
    readonly schema: {
      readonly request: JSONSchema.JsonSchema7Root
      readonly response: JSONSchema.JsonSchema7Root
    }
  }

const schemaJson = (
  schema: Parameters<typeof JSONSchema.make>[0],
): JSONSchema.JsonSchema7Root => JSONSchema.make(schema)

export const runtimeContextMcpChannelInventory = (
  metadata: ReadonlyArray<ChannelMetadata>,
): ReadonlyArray<RuntimeContextMcpChannelInventoryEntry> =>
  metadata.map(entry => {
    switch (entry.direction) {
      case "ingress":
        return {
          name: entry.target,
          direction: entry.direction,
          schema: { row: schemaJson(entry.schema) },
        }
      case "egress":
        return {
          name: entry.target,
          direction: entry.direction,
          schema: { payload: schemaJson(entry.schema) },
        }
      case "bidirectional":
        return {
          name: entry.target,
          direction: entry.direction,
          schema: {
            row: schemaJson(entry.schema),
            payload: schemaJson(entry.schema),
          },
        }
      case "call":
        return {
          name: entry.target,
          direction: entry.direction,
          schema: {
            request: schemaJson(entry.requestSchema),
            response: schemaJson(entry.responseSchema),
          },
        }
    }
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const withChannelInventory = (
  inputSchema: unknown,
  inventory: ReadonlyArray<RuntimeContextMcpChannelInventoryEntry>,
): unknown =>
  isRecord(inputSchema)
    ? {
      ...inputSchema,
      [channelInventoryExtensionKey]: inventory,
    }
    : inputSchema

const channelInventoryDescription = (
  inventory: ReadonlyArray<RuntimeContextMcpChannelInventoryEntry>,
): string =>
  inventory
    .map(entry => `${entry.name} (${entry.direction})`)
    .join(", ")

const appendChannelInventoryDescription = (
  description: string | undefined,
  inventory: ReadonlyArray<RuntimeContextMcpChannelInventoryEntry>,
): string | undefined => {
  if (inventory.length === 0) return description
  const inventoryText = `Registered Firegrid channels: ${channelInventoryDescription(inventory)}. Schema details are in ${channelInventoryExtensionKey}.`
  return description === undefined || description.length === 0
    ? inventoryText
    : `${description}\n\n${inventoryText}`
}

export const enrichRuntimeContextMcpToolWithChannelMetadata = (
  tool: McpSchema.Tool,
  inventory: ReadonlyArray<RuntimeContextMcpChannelInventoryEntry>,
): void => {
  if (inventory.length === 0) return
  Object.assign(tool, new McpSchema.Tool({
    ...tool,
    description: appendChannelInventoryDescription(
      tool.description,
      inventory,
    ),
    inputSchema: withChannelInventory(tool.inputSchema, inventory),
  }))
}

export const enrichRuntimeContextMcpToolsListWithChannelMetadata =
  Effect.gen(function* () {
    const mcpServer = yield* McpServer.McpServer
    const channelInventory = yield* ChannelInventory
    const metadata = channelInventory.channels.map(channelMetadata)
    const inventory = runtimeContextMcpChannelInventory(metadata)

    const waitForTool = mcpServer.tools.find(tool => tool.name === waitForToolName)
    if (waitForTool === undefined) return

    // firegrid-agent-body-plan.MCP_CHANNEL_METADATA.1
    // firegrid-agent-body-plan.MCP_CHANNEL_METADATA.3
    enrichRuntimeContextMcpToolWithChannelMetadata(waitForTool, inventory)
  })
