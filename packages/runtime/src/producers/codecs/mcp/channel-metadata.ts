import { McpSchema, McpServer } from "@effect/ai"
import type {
  ChannelSourceClass,
  ChannelTarget,
} from "@firegrid/protocol/channels"
import type { ChannelRouteMetadata } from "@firegrid/protocol/channels/router"
import { Effect, JSONSchema, type Schema } from "effect"
import { RuntimeChannelRouter } from "../../../channels/index.ts"

/**
 * Legacy MCP-extension flattened metadata shape that predates
 * `ChannelRouteMetadata`. Used ONLY by the MCP `tools/list`
 * `x-firegrid-channels` extension payload below; `ChannelRouteMetadata` from
 * `@firegrid/protocol/channels/router` is the canonical router metadata for
 * new consumers. Inlined here (moved from `host-sdk/src/host/channel.ts`)
 * so the MCP codec is self-contained.
 */
type ChannelMetadata =
  | {
    readonly target: ChannelTarget
    readonly direction: "ingress"
    readonly schema: Schema.Schema.Any
    readonly sourceClass?: ChannelSourceClass
  }
  | {
    readonly target: ChannelTarget
    readonly direction: "egress"
    readonly schema: Schema.Schema.Any
  }
  | {
    readonly target: ChannelTarget
    readonly direction: "bidirectional"
    readonly directions: readonly ["ingress", "egress"]
    readonly schema: Schema.Schema.Any
    readonly sourceClasses: ReadonlyArray<ChannelSourceClass>
  }
  | {
    readonly target: ChannelTarget
    readonly direction: "call"
    readonly requestSchema: Schema.Schema.Any
    readonly responseSchema: Schema.Schema.Any
  }

const channelInventoryExtensionKey = "x-firegrid-channels"
const waitForToolName = "wait_for"

type RuntimeContextMcpChannelCatalogEntry =
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

export const runtimeContextMcpChannelCatalog = (
  metadata: ReadonlyArray<ChannelMetadata>,
): ReadonlyArray<RuntimeContextMcpChannelCatalogEntry> =>
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

const routeMetadataToChannelMetadata = (
  entry: ChannelRouteMetadata,
): ChannelMetadata => {
  // ChannelRouteMetadata is canonical. This adapter exists only for the
  // legacy MCP extension payload shape that predated the router descriptor.
  switch (entry.schema.direction) {
    case "ingress":
      return {
        target: entry.target,
        direction: "ingress",
        schema: entry.schema.schema,
        ...(entry.schema.sourceClass === undefined
          ? {}
          : { sourceClass: entry.schema.sourceClass }),
      }
    case "egress":
      return {
        target: entry.target,
        direction: "egress",
        schema: entry.schema.schema,
      }
    case "bidirectional":
      return {
        target: entry.target,
        direction: "bidirectional",
        directions: entry.schema.directions,
        schema: entry.schema.schema,
        sourceClasses: entry.schema.sourceClasses,
      }
    case "call":
      return {
        target: entry.target,
        direction: "call",
        requestSchema: entry.schema.requestSchema,
        responseSchema: entry.schema.responseSchema,
      }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const withRuntimeContextMcpChannelCatalog = (
  inputSchema: unknown,
  inventory: ReadonlyArray<RuntimeContextMcpChannelCatalogEntry>,
): unknown =>
  isRecord(inputSchema)
    ? {
      ...inputSchema,
      [channelInventoryExtensionKey]: inventory,
    }
    : inputSchema

const channelInventoryDescription = (
  inventory: ReadonlyArray<RuntimeContextMcpChannelCatalogEntry>,
): string =>
  inventory
    .map(entry => `${entry.name} (${entry.direction})`)
    .join(", ")

const appendRuntimeContextMcpChannelCatalogDescription = (
  description: string | undefined,
  inventory: ReadonlyArray<RuntimeContextMcpChannelCatalogEntry>,
): string | undefined => {
  if (inventory.length === 0) return description
  const inventoryText = `Registered Firegrid channels: ${channelInventoryDescription(inventory)}. Schema details are in ${channelInventoryExtensionKey}.`
  return description === undefined || description.length === 0
    ? inventoryText
    : `${description}\n\n${inventoryText}`
}

export const enrichRuntimeContextMcpToolWithChannelMetadata = (
  tool: McpSchema.Tool,
  inventory: ReadonlyArray<RuntimeContextMcpChannelCatalogEntry>,
): void => {
  if (inventory.length === 0) return
  Object.assign(tool, new McpSchema.Tool({
    ...tool,
    description: appendRuntimeContextMcpChannelCatalogDescription(
      tool.description,
      inventory,
    ),
    inputSchema: withRuntimeContextMcpChannelCatalog(tool.inputSchema, inventory),
  }))
}

export const enrichRuntimeContextMcpToolsListWithChannelMetadata =
  Effect.gen(function* () {
    const mcpServer = yield* McpServer.McpServer
    const channelRouter = yield* RuntimeChannelRouter
    const inventory = runtimeContextMcpChannelCatalog(
      channelRouter.metadata.map(routeMetadataToChannelMetadata),
    )

    const waitForTool = mcpServer.tools.find(tool => tool.name === waitForToolName)
    if (waitForTool === undefined) return

    // firegrid-agent-body-plan.MCP_CHANNEL_METADATA.1
    // firegrid-agent-body-plan.MCP_CHANNEL_METADATA.3
    enrichRuntimeContextMcpToolWithChannelMetadata(waitForTool, inventory)
  })
