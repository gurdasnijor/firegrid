// firegrid-observability.ATTRIBUTES.1
// firegrid-observability.ATTRIBUTES.2
// firegrid-observability.ATTRIBUTES.3
// firegrid-observability.PACKAGE_BOUNDARY.1
// Browser-safe constants for Effect-native Firegrid substrate spans.

export const FiregridSpanName = {
  clientOperationSend: "firegrid.client.operation.send",
  clientOperationResult: "firegrid.client.operation.result",
  clientOperationObserve: "firegrid.client.operation.observe",
  eventStreamEmit: "firegrid.event_stream.emit",
  eventStreamEvents: "firegrid.event_stream.events",
  runtimeHandler: "firegrid.runtime.handler",
} as const

export const FiregridSpanAttribute = {
  operationDescriptor: "firegrid.operation.descriptor",
  operationHandleId: "firegrid.operation.handle_id",
  runId: "firegrid.run.id",
  runtimeId: "firegrid.runtime.id",
  streamDescriptor: "firegrid.stream.descriptor",
  eventKey: "firegrid.event.key",
  status: "firegrid.status",
  errorTag: "firegrid.error.tag",
} as const

export type FiregridSpanAttributeValue = string | number | boolean

export const firegridSpanAttributes = (
  attributes: Readonly<Record<string, FiregridSpanAttributeValue | undefined>>,
): Record<string, FiregridSpanAttributeValue> =>
  Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, FiregridSpanAttributeValue] =>
        entry[1] !== undefined,
    ),
  )

export const firegridErrorTag = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
  ) {
    return error._tag
  }
  if (error instanceof Error && error.name !== "") return error.name
  return typeof error
}
