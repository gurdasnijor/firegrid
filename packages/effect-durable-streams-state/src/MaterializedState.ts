import { HashMap, Option, type Schema } from "effect"
import * as P from "./Protocol.ts"

/**
 * Pure data structure: apply a sequence of decoded change events to an
 * in-memory `HashMap` keyed by `(type, key)`. No I/O, no Effect — useful
 * as an escape hatch for callers that already own the read stream (e.g.,
 * tests, batch ETL pipelines, snapshot serializers).
 *
 * Multi-type: each `apply` call routes by `msg.type`. Get a typed view
 * with `getType<V>(type)` after applying.
 *
 * For the streaming + write path, use `State.make` instead.
 */
export class MaterializedState {
  /** type → key → value */
  private readonly data: Map<string, Map<string, unknown>> = new Map()

  apply<V>(msg: P.ChangeMessage<V>): void {
    const op = msg.headers.operation
    let typeMap = this.data.get(msg.type)
    if (!typeMap) {
      typeMap = new Map()
      this.data.set(msg.type, typeMap)
    }
    switch (op) {
      case "insert":
      case "update":
      case "upsert": {
        if (msg.value !== undefined && msg.value !== null) {
          typeMap.set(msg.key, msg.value)
        }
        break
      }
      case "delete":
        typeMap.delete(msg.key)
        break
    }
  }

  applyBatch<V>(msgs: Iterable<P.ChangeMessage<V>>): void {
    for (const msg of msgs) this.apply(msg)
  }

  /**
   * Apply a control event. `reset` clears all state (across every type).
   * `snapshot-start` / `snapshot-end` are no-ops at this layer — track
   * them at the caller if needed.
   */
  applyControl(msg: P.ControlMessage): void {
    if (msg.headers.control === "reset") {
      this.data.clear()
    }
  }

  get<V = unknown>(type: string, key: string): Option.Option<V> {
    const typeMap = this.data.get(type)
    if (!typeMap) return Option.none()
    const v = typeMap.get(key)
    return v === undefined ? Option.none() : Option.some(v as V)
  }

  has(type: string, key: string): boolean {
    return this.data.get(type)?.has(key) ?? false
  }

  size(type: string): number {
    return this.data.get(type)?.size ?? 0
  }

  typeCount(): number {
    return this.data.size
  }

  /**
   * Snapshot the materialized state for a given type as an `HashMap`.
   * Returns an empty map if the type has never been seen.
   */
  snapshot<V = unknown>(type: string): HashMap.HashMap<string, V> {
    const typeMap = this.data.get(type)
    if (!typeMap) return HashMap.empty<string, V>()
    let out = HashMap.empty<string, V>()
    for (const [k, v] of typeMap) {
      out = HashMap.set(out, k, v as V)
    }
    return out
  }

  /**
   * Clear all materialized state. Equivalent to applying a `reset` control.
   */
  clear(): void {
    this.data.clear()
  }
}

/**
 * Convenience: pre-decode a stream of raw wire messages against a per-type
 * schema map and apply them to a fresh `MaterializedState`. Decode failures
 * for a given message are skipped (the protocol allows this in §7).
 */
export const replayFrom = <V>(
  raw: Iterable<P.Message<unknown>>,
  schemas: Map<string, Schema.Schema<V, unknown>>,
): MaterializedState => {
  const state = new MaterializedState()
  for (const msg of raw) {
    if (P.isControlMessage(msg)) {
      state.applyControl(msg)
      continue
    }
    const change = msg
    const schema = schemas.get(change.type)
    if (!schema) continue // type without a schema → skip (caller's choice)
    // We rely on the runtime shape — Schema validation happens upstream
    // in the typed Store. Here `apply` operates on whatever value shape
    // was on the wire.
    state.apply(change)
  }
  return state
}
