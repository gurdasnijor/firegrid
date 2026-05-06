import { Effect, Fiber, Stream } from "effect"
import { useEffect, useMemo, useState } from "react"
import { createLabClient } from "./LabClient.ts"
import { makeLabEvent, type LabEvent } from "./lab-events.ts"
import styles from "./styles.module.css"

// runtime-lab-inspector.INSPECTION_SURFACE.3
// runtime-lab-inspector.INSPECTION_SURFACE.4
// runtime-lab-inspector.LIVE_FOLLOW.1
// runtime-lab-inspector.LIVE_FOLLOW.3
// runtime-lab-inspector.WRITE_BOUNDARY.1
// runtime-lab-inspector.NO_PRIVILEGED_LAB.1
// runtime-lab-inspector.NO_PRIVILEGED_LAB.2
// launchable-substrate-host.LAB_INSPECTOR.1
// launchable-substrate-host.LAB_INSPECTOR.2
// launchable-substrate-host.LAB_INSPECTOR.6
// launchable-substrate-host.LAB_INSPECTOR.7
// firegrid-client-api.LAB_COMPATIBILITY.4
//
// Typed EventStream workbench. It writes through EventStreamClient.emit
// and follows decoded events through EventStreamClient.events. Raw
// Durable Streams inspection remains in RawStreamInspector.

interface LabEventStreamPanelProps {
  readonly streamUrl: string
}

const summarizeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export function LabEventStreamPanel({
  streamUrl,
}: LabEventStreamPanelProps) {
  const [message, setMessage] = useState("hello from lab")
  const [count, setCount] = useState(1)
  const [phase, setPhase] = useState<"connecting" | "live" | "error">(
    "connecting",
  )
  const [emitStatus, setEmitStatus] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [events, setEvents] = useState<ReadonlyArray<LabEvent>>([])
  const labClient = useMemo(
    () => createLabClient({ streamUrl }),
    [streamUrl],
  )

  useEffect(() => {
    setEvents([])
    setError(undefined)
    setPhase("connecting")

    // React effect boundary: start the EventStream follow fiber and
    // interrupt it from the cleanup callback below.
    // eslint-disable-next-line no-restricted-syntax
    const fiber = Effect.runFork(
      Effect.sync(() => {
        setPhase("live")
      }).pipe(
        Effect.zipRight(
          labClient.typedEvents.events().pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                setEvents((prev) => {
                  const next = [...prev, event]
                  if (next.length > 80) next.shift()
                  return next
                })
              }),
            ),
          ),
        ),
        Effect.catchAll((cause) =>
          Effect.sync(() => {
            setPhase("error")
            setError(summarizeError(cause))
          }),
        ),
      ),
    )

    return () => {
      // eslint-disable-next-line no-restricted-syntax
      void Effect.runPromise(Fiber.interrupt(fiber))
    }
  }, [labClient])

  const onEmit = () => {
    const event = makeLabEvent({ message, count })
    setEmitStatus("emitting")
    // React event-handler boundary: bridge the Effect-native client
    // call into the browser click handler.
    // eslint-disable-next-line no-restricted-syntax
    void Effect.runPromiseExit(
      labClient.typedEvents.emit(event),
    ).then((exit) => {
      if (exit._tag === "Success") {
        setEmitStatus(`emitted ${event.id}`)
        setCount((value) => value + 1)
      } else {
        setEmitStatus("emit failed")
        setError(String(exit.cause))
      }
    })
  }

  return (
    <section
      className={styles.typedPanel}
      aria-label="Typed EventStream workbench"
    >
      <div className={styles.panel}>
        <h3>Typed EventStream</h3>
        <p className={styles.note}>
          Uses the app-facing EventStream client. Events are decoded
          through a lab-local EventStream descriptor before rendering.
        </p>
        <label className={styles.label}>
          Message
          <input
            className={styles.input}
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
          />
        </label>
        <label className={styles.label}>
          Count
          <input
            className={styles.input}
            type="number"
            value={count}
            onChange={(event) =>
              setCount(Number.parseInt(event.currentTarget.value, 10) || 0)
            }
          />
        </label>
        <button
          className={styles.button}
          type="button"
          onClick={onEmit}
          disabled={message.trim().length === 0}
        >
          Emit typed event
        </button>
        {emitStatus !== undefined ? (
          <div className={styles.note}>{emitStatus}</div>
        ) : null}
      </div>

      <div className={styles.panel}>
        <h3>Decoded Events</h3>
        <div className={styles.note}>
          {phase === "live"
            ? `stream live (${events.length} decoded events)`
            : phase === "connecting"
              ? "connecting..."
              : `error: ${error ?? "unknown"}`}
        </div>
        {events.length === 0 ? (
          <span className={styles.empty}>no typed events yet</span>
        ) : (
          <ol className={styles.records}>
            {events.map((event) => (
              <li key={event.id}>
                <strong>{event.message}</strong>
                <pre className={styles.json}>
                  {JSON.stringify(event, null, 2)}
                </pre>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}
