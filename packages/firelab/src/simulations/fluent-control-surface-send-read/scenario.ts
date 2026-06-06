export const entityId = "session-1"
export const agentName = "firelab-fluent-control-surface"
export const surfaceId = "fluent-control-surface-send-read"

export const discoveryPath = (namespace: string): string =>
  [
    namespace,
    "fluent-control-surface",
    "discovery",
  ].map(encodeURIComponent).join("/")
