/**
 * Host identity Layer — builds and provides `CurrentHostSession`.
 *
 * `CurrentHostSession` carries the host's identity (hostId, hostSessionId,
 * stream prefix). The unified-host composition needs this to:
 *
 *   - Populate the `host` field of context rows written through
 *     `HostContextsCreateChannelLive` (so the context resolver later
 *     finds them with proper host binding).
 *   - Construct host-owned durable-streams URLs if a future codec needs
 *     them.
 *
 * The hostId is a single dot-free segment, branded via
 * `HostIdSegmentSchema`. The stream prefix is derived as
 * `${namespace}.firegrid.host.${hostId}` via the protocol's
 * `makeHostStreamPrefix` codec.
 */

import {
  CurrentHostSession,
  HostIdSegmentSchema,
  type HostId,
  type HostSessionId,
  makeHostSessionRow,
} from "@firegrid/protocol/launch"
import { Clock, Effect, Layer, Schema } from "effect"

const decodeHostIdSegment = Schema.decodeSync(HostIdSegmentSchema)

const sanitizeHostIdSegment = (raw: string): HostId => {
  // HostIdSegment must be a single dot-free segment, non-empty.
  // Sanitize by replacing disallowed chars with `_`. Production callers
  // should pass a value that already satisfies the brand.
  const cleaned = raw.replace(/\./g, "_") || "host"
  return decodeHostIdSegment(cleaned)
}

export interface HostIdentityOptions {
  readonly namespace: string
  /**
   * Optional explicit host id. If omitted, derived from the namespace
   * (replacing dots with `_` and appending `-host`).
   */
  readonly hostId?: string
  /**
   * Optional host-session id. Defaults to a fresh `crypto.randomUUID()`
   * value — fine for sims; production hosts often want a stable value.
   */
  readonly hostSessionId?: string
}

export const buildCurrentHostSessionLayer = (
  options: HostIdentityOptions,
): Layer.Layer<CurrentHostSession> =>
  Layer.effect(
    CurrentHostSession,
    Effect.gen(function*() {
      const hostId = sanitizeHostIdSegment(
        options.hostId ?? `${options.namespace}-host`,
      )
      const hostSessionId = (options.hostSessionId ?? `session-${crypto.randomUUID()}`) as HostSessionId
      const startedAtMs = yield* Clock.currentTimeMillis
      return makeHostSessionRow({
        hostId,
        hostSessionId,
        namespace: options.namespace,
        startedAtMs,
      })
    }),
  )
