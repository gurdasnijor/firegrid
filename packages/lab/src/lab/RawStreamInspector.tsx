import { DurableStream, type JsonBatch } from "@durable-streams/client"
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
// that the runtime emits records on; this hook subscribes via an
// async iterator with backoff handled inside the client.
//
// This component intentionally has no writer controls. Application
// and lab UI writes flow exclusively through the substrate client.

export interface RawStreamInspectorProps {
  readonly streamUrl: string
}

interface RawRecord {
  readonly seq: number
  readonly value: unknown
  readonly raw: string
}

export function RawStreamInspector({ streamUrl }: RawStreamInspectorProps) {
  const [records, setRecords] = useState<ReadonlyArray<RawRecord>>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [phase, setPhase] = useState<"connecting" | "live" | "error">(
    "connecting",
  )

  useEffect(() => {
    let cancelled = false
    setRecords([])
    setError(undefined)
    setPhase("connecting")

    const run = async () => {
      try {
        const handle = await DurableStream.connect({ url: streamUrl })
        const session = await handle.stream({ offset: "-1", live: true })
        if (cancelled) return
        setPhase("live")
        let nextSeq = 0
        for await (const batch of session.jsonStream() as AsyncIterable<
          JsonBatch
        >) {
          if (cancelled) return
          for (const item of batch.items) {
            const seq = nextSeq
            nextSeq += 1
            const raw =
              typeof item === "string" ? item : JSON.stringify(item)
            setRecords((prev) => {
              const next = prev.slice()
              next.push({ seq, value: item, raw })
              if (next.length > 200) next.shift()
              return next
            })
          }
        }
      } catch (cause) {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setPhase("error")
      }
    }
    void run()

    return () => {
      cancelled = true
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
