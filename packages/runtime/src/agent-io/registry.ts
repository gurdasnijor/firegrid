/**
 * Static codec registry. Codecs are TS modules compiled into the
 * runtime host; this registry is just a lookup-by-kind so the workflow
 * body can resolve a codec from the runtime context's declared
 * `agentKind` field.
 *
 * Registration is intentionally static — adding a codec is a PR
 * (`firegrid-platform-invariants.BOUNDARY.4` keeps Firegrid free of
 * dynamic provider registries).
 */

import { Option } from "effect"
import type { AgentCodec } from "./codec.ts"

export interface CodecRegistry {
  readonly get: (kind: string) => Option.Option<AgentCodec>
  readonly has: (kind: string) => boolean
  readonly kinds: ReadonlyArray<string>
}

export interface CodecRegistryConflict {
  readonly kind: string
  readonly previous: AgentCodec
  readonly next: AgentCodec
}

export interface MakeCodecRegistryResult {
  readonly registry: CodecRegistry
  readonly conflicts: ReadonlyArray<CodecRegistryConflict>
}

/**
 * Construct a `CodecRegistry` from a tuple of codecs.
 *
 * Conflicts (more than one codec claiming the same kind) are returned
 * as a typed result rather than thrown — Firegrid's effect-quality
 * ratchet discourages production-source `throw`s, and a conflict at
 * codec wiring is a deployment misconfiguration that callers should
 * surface explicitly (log, fail-fast, or fall back). On conflict the
 * registry retains the first-registered codec for that kind.
 */
export const makeCodecRegistry = (
  codecs: ReadonlyArray<AgentCodec>,
): MakeCodecRegistryResult => {
  const map = new Map<string, AgentCodec>()
  const conflicts: Array<CodecRegistryConflict> = []
  for (const codec of codecs) {
    const previous = map.get(codec.kind)
    if (previous !== undefined) {
      conflicts.push({ kind: codec.kind, previous, next: codec })
      continue
    }
    map.set(codec.kind, codec)
  }
  return {
    registry: {
      get: (kind) => Option.fromNullable(map.get(kind)),
      has: (kind) => map.has(kind),
      kinds: Array.from(map.keys()),
    },
    conflicts,
  }
}
