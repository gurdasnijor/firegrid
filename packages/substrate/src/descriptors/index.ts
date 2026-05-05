// firegrid-architecture-boundary.SURFACE_AREA.1
// firegrid-operation-messaging.OPERATIONS.4
// firegrid-event-streams.SCHEMA_OWNERSHIP.3
//
// Shared-kernel descriptor namespaces. These modules depend only on
// Effect / Schema / Data / Brand and are safe to import from both
// clients and runtimes. They do not touch substrate internals; a
// future extraction to @firegrid/core is mechanical.

export * from "./operation.ts"
export * from "./event-stream.ts"
