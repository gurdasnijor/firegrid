// events/ — runtime-owned fact and identity types.
//
// IMPORT DIRECTION: this folder MAY import protocol-owned row schemas
// (`RuntimeEventRow`, `RuntimeIngressInputRow`) because protocol owns the wire
// record contracts. It MUST NOT re-declare those schemas, and protocol MUST NOT
// import from here. See ../README.md.
//
// The runtime-owned pieces here are the *identity* of a keyed entity
// (`RuntimeContext`) and the *target event* union the keyed subscriber reduces
// over. Those are runtime concepts, not wire records, so they live in runtime.

import type { RuntimeEventRow } from "@firegrid/protocol/launch"
import type { RuntimeIngressInputRow } from "@firegrid/protocol/runtime-ingress"

// C1: a RuntimeContext is a durable entity keyed by `contextId`. This is the
// key kind every Shape C subscriber and the RuntimeContextStateStore own.
export interface RuntimeContext {
  readonly contextId: string
}

// A typed output observation. In production this is the runtime-owned
// `RuntimeAgentOutputObservation` projected from `RuntimeEventRow`. The
// prototype keeps a minimal shape that still carries the source cursor (C6:
// observations are typed source + cursor + match).
export interface RuntimeAgentOutputObservation {
  readonly contextId: string
  readonly sequence: number
  readonly row: RuntimeEventRow
}

// The "ToolResult" arm of the runtime input-event family, kept minimal.
export interface ToolResultEvent {
  readonly _tag: "ToolResult"
  readonly toolUseId: string
  readonly output: unknown
}

// C2/C7: the keyed subscriber reduces over this union — one fact for its key —
// rather than scanning dense raw output inside a parked body.
export type RuntimeContextTargetEvent =
  | { readonly _tag: "Input"; readonly event: RuntimeIngressInputRow }
  | { readonly _tag: "Output"; readonly event: RuntimeAgentOutputObservation }
  | { readonly _tag: "ToolResult"; readonly event: ToolResultEvent }
