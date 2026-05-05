import { Context, Effect, Layer, Ref } from "effect"

// Package-internal subscriber liveness.
//
// launchable-substrate-host.HOST_PROCESS.6-note (deferred to a later
// diagnostics slice) — this slice intentionally does NOT export the
// service from the host root, does NOT expose HTTP routes, and does
// NOT carry counters, timestamps, resolved ids, cursor/progress, or
// terminalization summaries. Liveness is host-local ephemeral
// process state and is not durable subscriber progress authority.

export type SubscriberKind = "timer" | "scheduled_work"

export interface SubscriberLivenessSnapshot {
  readonly kind: SubscriberKind
  readonly enabled: boolean
  readonly running: boolean
  readonly lastErrorSummary?: string
}

export interface SubscriberLivenessService {
  readonly snapshot: () => Effect.Effect<ReadonlyArray<SubscriberLivenessSnapshot>>
}

export class SubscriberLiveness extends Context.Tag(
  "substrate/host/SubscriberLiveness",
)<SubscriberLiveness, SubscriberLivenessService>() {}

// Internal record kept by the runner. Optional fields stay absent
// rather than carrying default values so the structural test in
// __tests__/subscribers/liveness.test.ts can assert "no progress
// fields" against the public snapshot shape.
interface LivenessEntry {
  readonly enabled: boolean
  readonly running: boolean
  readonly lastErrorSummary?: string
}

type LivenessState = {
  readonly [K in SubscriberKind]?: LivenessEntry
}

export interface SubscriberLivenessHandle {
  readonly setRunning: (running: boolean) => Effect.Effect<void>
  readonly recordError: (summary: string) => Effect.Effect<void>
}

export interface SubscriberLivenessInternal extends SubscriberLivenessService {
  readonly handle: (kind: SubscriberKind) => SubscriberLivenessHandle
}

const buildInternal = (
  ref: Ref.Ref<LivenessState>,
): SubscriberLivenessInternal => {
  const snapshot: SubscriberLivenessService["snapshot"] = () =>
    Effect.map(Ref.get(ref), (state) => {
      const out: Array<SubscriberLivenessSnapshot> = []
      for (const kind of ["timer", "scheduled_work"] as const) {
        const entry = state[kind]
        if (entry === undefined) continue
        out.push({
          kind,
          enabled: entry.enabled,
          running: entry.running,
          ...(entry.lastErrorSummary !== undefined
            ? { lastErrorSummary: entry.lastErrorSummary }
            : {}),
        })
      }
      return out
    })

  const handle = (kind: SubscriberKind): SubscriberLivenessHandle => ({
    setRunning: (running) =>
      Ref.update(ref, (state) => {
        const prev = state[kind]
        if (prev === undefined) return state
        return { ...state, [kind]: { ...prev, running } }
      }),
    recordError: (summary) =>
      Ref.update(ref, (state) => {
        const prev = state[kind]
        if (prev === undefined) return state
        return { ...state, [kind]: { ...prev, lastErrorSummary: summary } }
      }),
  })

  return { snapshot, handle }
}

// Build the liveness Ref from the set of enabled kinds, then expose
// (a) the public Service via SubscriberLiveness and (b) the
// package-internal handle factory used by the runner. Both views
// share the same Ref.
export const makeSubscriberLiveness = (
  enabled: ReadonlyArray<SubscriberKind>,
): Effect.Effect<SubscriberLivenessInternal> =>
  Effect.gen(function* () {
    const initial: LivenessState = {}
    const seeded = enabled.reduce<LivenessState>(
      (acc, kind) => ({ ...acc, [kind]: { enabled: true, running: false } }),
      initial,
    )
    const ref = yield* Ref.make<LivenessState>(seeded)
    return buildInternal(ref)
  })

export const SubscriberLivenessLayerFrom = (
  internal: SubscriberLivenessInternal,
): Layer.Layer<SubscriberLiveness> =>
  Layer.succeed(SubscriberLiveness, {
    snapshot: internal.snapshot,
  })

// Redact substrate/SubscriberError into a non-secret one-line summary.
// Only the _tag plus the typed safe fields (reason, completionId) leak
// out; the underlying `cause` (which may carry stream/transport
// internals or auth headers) is intentionally dropped.
export const redactSubscriberError = (error: unknown): string => {
  if (error === null || typeof error !== "object") return "UnknownError"
  const tag = (error as { readonly _tag?: unknown })._tag
  const tagStr = typeof tag === "string" ? tag : "UnknownError"
  const completionId = (error as { readonly completionId?: unknown })
    .completionId
  const reason = (error as { readonly reason?: unknown }).reason
  const parts: Array<string> = [tagStr]
  if (typeof completionId === "string") parts.push(`completionId=${completionId}`)
  if (typeof reason === "string") parts.push(`reason=${reason}`)
  return parts.join(" ")
}
