import {
  DurableStream,
  type StreamResponse,
} from "@durable-streams/client"
import { Data, Effect, Fiber, Stream, type Scope } from "effect"
import { useEffect, useState } from "react"
import styles from "./styles.module.css"

// launchable-substrate-host.LAB_INSPECTOR.2
// launchable-substrate-host.LAB_INSPECTOR.4
// launchable-substrate-host.LAB_INSPECTOR.7
//
// Raw stream inspector — read-only diagnostic panel. Catches up
// from the start of the stream and switches to live follow via the
// external @durable-streams/client. There is no fixed-interval
// polling: the durable streams client drives a streaming session
// that the runtime emits records on; this hook subscribes via a
// scoped Effect Stream bridge with backoff handled inside the client.
//
// This component intentionally has no writer controls. Application
// and lab UI writes flow exclusively through the substrate client.

interface RawStreamInspectorProps {
  readonly streamUrl: string
}

interface RawRecord {
  readonly seq: number
  readonly value: unknown
  readonly raw: string
}

class RawStreamInspectorSessionError extends Data.TaggedError(
  "firegrid/RawStreamInspectorSessionError",
)<{
  readonly streamUrl: string
  readonly cause: unknown
}> {}

const summarizeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const acquireRawSession = (
  streamUrl: string,
): Effect.Effect<
  StreamResponse<unknown>,
  RawStreamInspectorSessionError,
  Scope.Scope
> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const handle = await DurableStream.connect({ url: streamUrl })
        return await handle.stream<unknown>({ offset: "-1", live: true })
      },
      catch: (cause) =>
        new RawStreamInspectorSessionError({ streamUrl, cause }),
    }),
    (response) => Effect.sync(() => response.cancel()),
  )

// launchable-substrate-host.LAB_INSPECTOR.2
// launchable-substrate-host.LAB_INSPECTOR.4
const rawRecords = (
  response: StreamResponse<unknown>,
): Stream.Stream<RawRecord> => {
  let nextSeq = 0
  return Stream.asyncScoped<RawRecord>(
    (emit) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          response.subscribeJson<unknown>(async (batch) => {
            for (const item of batch.items) {
              const seq = nextSeq
              nextSeq += 1
              const raw =
                typeof item === "string" ? item : JSON.stringify(item)
              await emit.single({ seq, value: item, raw })
            }
          }),
        ),
        (unsubscribe) => Effect.sync(() => unsubscribe()),
      ),
    { bufferSize: 64, strategy: "suspend" },
  )
}

export function RawStreamInspector({ streamUrl }: RawStreamInspectorProps) {
  const [records, setRecords] = useState<ReadonlyArray<RawRecord>>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [phase, setPhase] = useState<"connecting" | "live" | "error">(
    "connecting",
  )

  useEffect(() => {
    setRecords([])
    setError(undefined)
    setPhase("connecting")

    // React effect boundary: start the raw Durable Streams follow
    // fiber and interrupt it from cleanup so Scope finalization
    // cancels the live session.
    // eslint-disable-next-line no-restricted-syntax
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const response = yield* acquireRawSession(streamUrl)
          yield* Effect.sync(() => {
            setPhase("live")
          })
          yield* rawRecords(response).pipe(
            Stream.runForEach((record) =>
              Effect.sync(() => {
                setRecords((prev) => {
                  const next = prev.slice()
                  next.push(record)
                  if (next.length > 200) next.shift()
                  return next
                })
              }),
            ),
          )
        }),
      ).pipe(
        Effect.catchAll((cause) =>
          Effect.sync(() => {
            setError(summarizeError(cause))
            setPhase("error")
          }),
        ),
      ),
    )

    return () => {
      // eslint-disable-next-line no-restricted-syntax
      void Effect.runPromise(Fiber.interrupt(fiber))
    }
  }, [streamUrl])

  return (
    <>
      <div className={styles.panel}>
        <h3>Stream</h3>
        <div className={styles.note}>
          {phase === "live"
            ? `live following ${records.length} records (catchup + live; no fixed-interval polling)`
            : phase === "connecting"
              ? "connecting…"
              : `error: ${error ?? "unknown"}`}
        </div>
      </div>
      <div className={styles.panel}>
        <h3>Records</h3>
        {records.length === 0 ? (
          <span className={styles.empty}>
            no records yet — declare a run from the scenario panel.
          </span>
        ) : (
          <ol className={styles.records}>
            {records.map((record) => (
              <li key={record.seq}>
                <strong>#{record.seq}</strong>
                <pre className={styles.json}>
                  {typeof record.value === "string"
                    ? record.raw
                    : JSON.stringify(record.value, null, 2)}
                </pre>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  )
}
