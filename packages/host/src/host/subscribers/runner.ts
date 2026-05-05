import {
  openSubstrateDb,
  snapshotFromDb,
  type CompletionKind,
  type CompletionValue,
  type SubscriberError,
} from "@durable-agent-substrate/substrate"
import { Cause, Clock, Duration, Effect, Exit } from "effect"
import {
  redactSubscriberError,
  type SubscriberKind,
  type SubscriberLivenessHandle,
} from "./liveness.js"

// launchable-substrate-host.HOST_PROCESS.3
// launchable-substrate-host.HOST_PROCESS.3-note
// launchable-substrate-host.AUTHORITY_BOUNDARY.2
// effect-native-api.EFFECT_SERVICES.9
//
// Generic host-managed subscriber runner. Long-lived StreamDB is held
// only for two host-local responsibilities:
//
//   (a) subscription-edge wakes — `db.collections.completions.subscribeChanges`
//       fires latch.unsafeOpen() when a relevant durable change lands;
//   (b) next-due observation — `snapshotFromDb(db)` lets the runner pick the
//       smallest pending dueAtMs for this kind so the wait races against an
//       Effect.sleep deadline.
//
// Terminalization stays in the existing single-shot subscriber Effects
// (`runTimerSubscriber` / `runScheduledWorkSubscriber`). Each scan
// re-invokes the supplied `runScan` Effect which performs its own
// no-gap rebuildProjection + append. This is option (ii) of the v2
// pre-implementation packet: substrate is left untouched, at the cost
// of a per-scan rebuild/preload.
//
// Wake coalescing: an `Effect.Latch` is opened by the edge handler and
// by the deadline branch. If a wake arrives during a scan, the next
// `latch.await` returns immediately and a single follow-up scan runs.
// Multiple wakes during a single scan still collapse to exactly one
// follow-up scan. See SDD_LAUNCHABLE_SUBSTRATE_HOST_AND_LAB.md
// "Host-Managed Subscriber Programs" for the canonical statement.

export interface SubscriberRunnerInput {
  readonly kind: SubscriberKind
  readonly streamUrl: string
  readonly contentType: string
  readonly liveness: SubscriberLivenessHandle
  readonly runScan: Effect.Effect<unknown, SubscriberError>
}

const completionKindOf = (kind: SubscriberKind): CompletionKind =>
  kind === "timer" ? "timer" : "scheduled_work"

const dueAtFor = (
  kind: SubscriberKind,
  completion: CompletionValue,
): number | undefined => {
  if (completion.state !== "pending") return undefined
  if (completion.kind !== completionKindOf(kind)) return undefined
  const data = completion.data as
    | { readonly dueAtMs?: unknown; readonly whenMs?: unknown }
    | undefined
  if (data === undefined) return undefined
  const candidate = kind === "timer" ? data.dueAtMs : data.whenMs
  return typeof candidate === "number" ? candidate : undefined
}

const minPendingDueAtMs = (
  kind: SubscriberKind,
  completions: ReadonlyMap<string, CompletionValue>,
): number | undefined => {
  let min: number | undefined
  for (const completion of completions.values()) {
    const dueAt = dueAtFor(kind, completion)
    if (dueAt === undefined) continue
    if (min === undefined || dueAt < min) min = dueAt
  }
  return min
}

// Acquire the long-lived StreamDB and ensure it is closed on scope
// finalization. We do NOT pass `includeInitialState: true` to
// subscribeChanges; the startup catch-up scan runs explicitly via
// `runScan` after preload, keeping a single no-gap acquire path.
const acquireDb = (streamUrl: string, contentType: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const db = openSubstrateDb({ url: streamUrl, contentType })
        await db.preload()
        return db
      },
      catch: (cause) => cause,
    }),
    (db) => Effect.sync(() => db.close()),
  )

export const runSubscriberProgram = (
  input: SubscriberRunnerInput,
): Effect.Effect<void, never, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const latch = yield* Effect.makeLatch(false)

      // Acquire long-lived StreamDB. Failures are recorded on
      // liveness as a redacted summary; the runner fiber then exits
      // (no auto-respawn this slice — see v2 packet §8C).
      const dbResult = yield* Effect.either(
        acquireDb(input.streamUrl, input.contentType),
      )
      if (dbResult._tag === "Left") {
        yield* input.liveness.recordError(
          `StreamDbAcquireError ${redactSubscriberError(dbResult.left)}`,
        )
        return
      }
      const db = dbResult.right

      // Subscription-edge wake: any completions change opens the
      // latch. The handler runs in the tanstack-db sync context and
      // must not allocate Effect machinery, so we use unsafeOpen.
      // Unsubscribe is wired through Effect.addFinalizer so it always
      // runs on scope close (interruption included).
      const subscription = db.collections.completions.subscribeChanges(
        () => latch.unsafeOpen(),
      )
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => subscription.unsubscribe()),
      )

      const runOneScan = Effect.gen(function* () {
        yield* input.liveness.setRunning(true)
        const result = yield* Effect.either(input.runScan)
        yield* input.liveness.setRunning(false)
        if (result._tag === "Left") {
          yield* input.liveness.recordError(
            redactSubscriberError(result.left),
          )
          return Exit.fail(result.left)
        }
        return Exit.succeed(undefined)
      })

      // Loop:
      //   1. run a scan (startup catch-up on first iteration; then
      //      one follow-up per coalesced wake);
      //   2. compute nextDueAtMs from the live snapshot;
      //   3. race latch.await against Effect.sleep(deadlineMs);
      //   4. close the latch (re-arm) and continue.
      //
      // Scope interruption propagates through latch.await /
      // Effect.sleep automatically (Effect.scoped finalization).
      const loop: Effect.Effect<void, never, never> = Effect.gen(function* () {
        while (true) {
          const scan = yield* runOneScan
          if (Exit.isFailure(scan)) {
            // Per v2 §8C: typed scan failure stops the runner without
            // respawn. The error is already recorded on liveness.
            return
          }
          const snapshot = snapshotFromDb(db)
          const nowMs = yield* Clock.currentTimeMillis
          const nextDueAtMs = minPendingDueAtMs(
            input.kind,
            snapshot.completions,
          )
          // If the latch was opened during the scan, await returns
          // immediately and the next iteration becomes the
          // exactly-one follow-up scan.
          const wakeRace =
            nextDueAtMs === undefined
              ? latch.await
              : Effect.race(
                  latch.await,
                  Effect.sleep(
                    Duration.millis(Math.max(0, nextDueAtMs - nowMs)),
                  ),
                )
          yield* wakeRace
          yield* latch.close
        }
      })

      // Catch interruption defects so the public runner returns void
      // on scope teardown rather than failing the host layer scope.
      yield* Effect.catchAllCause(loop, (cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.void
          : Effect.gen(function* () {
              yield* input.liveness.recordError(
                redactSubscriberError(Cause.squash(cause)),
              )
            }),
      )
    }),
  )
