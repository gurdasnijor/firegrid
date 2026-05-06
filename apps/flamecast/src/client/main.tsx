import { StrictMode, useEffect, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import {
  createFlamecastClient,
  sessionDetailFromEvents,
  sessionsFromEvents,
  type FlamecastClient,
  type SessionDetail,
  type SessionEvent,
  type SessionSummary,
} from "./firegrid.ts"
import { defaultTopologyPath, type FlamecastTopology } from "../shared/topology.ts"
import "./styles.css"

const time = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso))

const loadTopology = async (): Promise<FlamecastTopology> => {
  const response = await fetch(defaultTopologyPath, { cache: "no-store" })
  if (!response.ok) {
    return await Promise.reject(
      new Error("Start `pnpm --filter @firegrid/flamecast runtime` first."),
    )
  }
  return await response.json() as FlamecastTopology
}

const eventText = (event: SessionEvent): string => {
  if (event.type === "user_message" || event.type === "assistant_message") {
    return event.text
  }
  if (event.type === "turn_started") {
    return `${event.provider} / ${event.model}`
  }
  if (event.type === "turn_complete") return event.summary
  return event.message
}

function Sidebar(props: {
  readonly sessions: readonly SessionSummary[]
  readonly selectedId: string | undefined
  readonly onSelect: (sessionId: string) => void
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/clawd.svg" alt="" />
        <div>
          <h1>Flamecast</h1>
          <p>Firegrid local runtime</p>
        </div>
      </div>
      <div className="session-list">
        {props.sessions.length === 0 ? (
          <p className="empty">Start a local session.</p>
        ) : props.sessions.map((session) => (
          <button
            className={session.sessionId === props.selectedId ? "selected" : ""}
            key={session.sessionId}
            onClick={() => props.onSelect(session.sessionId)}
            type="button"
          >
            <span>{session.title}</span>
            <small>{session.status} · {session.turnCount} turns</small>
          </button>
        ))}
      </div>
      <div className="provider-strip">
        <img src="/openai.svg" alt="" />
        <img src="/cursor.svg" alt="" />
        <span>local deterministic adapter</span>
      </div>
    </aside>
  )
}

function Timeline(props: { readonly detail: SessionDetail | undefined }) {
  if (props.detail === undefined) {
    return <section className="placeholder">No session selected.</section>
  }
  return (
    <section className="timeline">
      <header className="detail-head">
        <div>
          <p className="eyebrow">Firegrid durable timeline</p>
          <h2>{props.detail.summary.title}</h2>
        </div>
        <span className="runtime-pill">{props.detail.summary.status}</span>
      </header>
      <div className="events">
        {props.detail.events.map((event) => (
          <article className={`event event-${event.type}`} key={event.eventId}>
            <div className="event-meta">
              <span>{event.type.replaceAll("_", " ")}</span>
              <time>{time(event.at)}</time>
            </div>
            <p>{eventText(event)}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function Composer(props: {
  readonly client: FlamecastClient | undefined
  readonly detail: SessionDetail | undefined
  readonly onSession: (sessionId: string) => void
}) {
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (props.client === undefined) return
    const trimmed = message.trim()
    if (trimmed.length === 0) return
    setBusy(true)
    try {
      const baseInput = {
        message: trimmed,
        ordinal: (props.detail?.summary.turnCount ?? 0) + 1,
      }
      const result = await props.client.sendTurn(
        props.detail === undefined
          ? baseInput
          : { ...baseInput, sessionId: props.detail.summary.sessionId },
      )
      props.onSession(result.sessionId)
      setMessage("")
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <textarea
        onChange={(event) => setMessage(event.currentTarget.value)}
        placeholder="Send a prompt to the local Firegrid runtime..."
        rows={3}
        value={message}
      />
      <button disabled={busy || props.client === undefined} type="submit">
        {props.detail === undefined ? "Start session" : "Send follow-up"}
      </button>
    </form>
  )
}

function App() {
  const [topology, setTopology] = useState<FlamecastTopology | undefined>()
  const [client, setClient] = useState<FlamecastClient | undefined>()
  const [events, setEvents] = useState<readonly SessionEvent[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let stop: (() => void) | undefined
    void loadTopology().then((loaded) => {
      setTopology(loaded)
      const next = createFlamecastClient({
        streamUrl: loaded.streamUrl,
        clientId: "flamecast-browser",
      })
      setClient(next)
      stop = next.watchEvents(
        (event) => setEvents((current) => [...current, event]),
        (cause) => setError(String(cause)),
      )
    }).catch((cause: unknown) => setError(String(cause)))
    return () => stop?.()
  }, [])

  const sessions = useMemo(() => sessionsFromEvents(events), [events])
  const detail = selectedId === undefined
    ? undefined
    : sessionDetailFromEvents(events, selectedId)

  return (
    <div className="shell">
      <Sidebar
        onSelect={setSelectedId}
        selectedId={selectedId}
        sessions={sessions}
      />
      <main>
        <header className="topbar">
          <span className="status-dot" />
          <span>{topology?.runtimeId ?? "runtime not connected"}</span>
          {error && <span className="error">{error}</span>}
        </header>
        <Timeline detail={detail} />
        <Composer
          client={client}
          detail={detail}
          onSession={setSelectedId}
        />
      </main>
    </div>
  )
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
