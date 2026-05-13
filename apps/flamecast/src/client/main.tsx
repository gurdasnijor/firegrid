import { StrictMode, useEffect, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { eq } from "@tanstack/db"
import {
  Firegrid,
  FiregridConfig,
  FiregridDurableTablesLive,
  FiregridLive,
  FiregridRuntimeTables,
  firegridRuntimeTableTags,
  local,
  type FiregridService,
  type RuntimeContextSnapshot,
} from "@firegrid/client/firegrid"
import {
  DurableTableProvider,
  useDurableLiveQuery,
  useDurableTable,
} from "effect-durable-operators/react"
import { Effect, Fiber, Layer } from "effect"
import {
  flamecastToyAgentSource,
  flamecastToyCreatedBy,
} from "../shared/agent.ts"
import type { ToySessionView, ToyRuntimeStatus } from "../shared/toy.ts"
import "./styles.css"

const durableStreamsBaseUrl =
  import.meta.env["VITE_DURABLE_STREAMS_BASE_URL"] ?? "http://127.0.0.1:8080"
const runtimeNamespace =
  import.meta.env["VITE_FIREGRID_RUNTIME_NAMESPACE"] ?? "flamecast-toy-local"

const firegridConfig = {
  durableStreamsBaseUrl,
  namespace: runtimeNamespace,
}

const FiregridBrowserConfigLive = Layer.succeed(FiregridConfig, firegridConfig)

const FiregridBrowserLive = FiregridLive.pipe(
  Layer.provide(FiregridBrowserConfigLive),
)

const FiregridBrowserTablesLive = FiregridDurableTablesLive.pipe(
  Layer.provide(FiregridBrowserConfigLive),
)

const runtime = local.jsonl({
  argv: [
    "/usr/bin/env",
    "node",
    "--input-type=module",
    "-e",
    flamecastToyAgentSource,
  ],
})

const useFiregrid = () => {
  const [firegrid, setFiregrid] = useState<FiregridService | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    // eslint-disable-next-line no-restricted-syntax
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Firegrid
          yield* Effect.sync(() => setFiregrid(service))
          yield* Effect.never
        }).pipe(
          Effect.provide(FiregridBrowserLive),
          Effect.catchAll(cause =>
            Effect.sync(() =>
              setError(cause instanceof Error ? cause.message : String(cause)),
            ),
          ),
        ),
      ),
    )
    return () => {
      // eslint-disable-next-line no-restricted-syntax
      void Effect.runPromise(Fiber.interrupt(fiber))
    }
  }, [])

  return { firegrid, error }
}

const statusFor = (
  runs: RuntimeContextSnapshot["runs"],
): ToyRuntimeStatus => {
  const latest = [...runs].sort((left, right) => left.at.localeCompare(right.at)).at(-1)
  return latest?.status ?? "created"
}

const promptFromSnapshot = (
  snapshot: RuntimeContextSnapshot,
): string =>
  snapshot.context?.createdBy === flamecastToyCreatedBy
    ? "Flamecast stdio prompt"
    : "Runtime context"

const snapshotToSessionView = (
  snapshot: RuntimeContextSnapshot,
): ToySessionView => ({
  contextId: snapshot.contextId,
  prompt: promptFromSnapshot(snapshot),
  status: statusFor(snapshot.runs),
  eventCount: snapshot.events.length + snapshot.logs.length,
})

function ProviderStrip() {
  const providers = [
    ["claude-code", "/claude-code.svg"],
    ["cursor", "/cursor.svg"],
    ["openai", "/openai.svg"],
    ["devin", "/devin.png"],
    ["openhands", "/openhands.svg"],
    ["jules", "/jules.svg"],
  ] as const
  return (
    <div className="provider-strip" aria-label="available provider badges">
      {providers.map(([name, src]) => (
        <img key={name} src={src} alt="" />
      ))}
    </div>
  )
}

function SessionList(props: {
  readonly selectedId: string | undefined
  readonly onSelect: (contextId: string) => void
}) {
  const control = useDurableTable(FiregridRuntimeTables.ControlPlane)
  // flamecast-toy-stdio-agents.REACTIVE_UI.1
  const contexts = useDurableLiveQuery((q) =>
    q.from({ contexts: control.contexts.collection })
      .where(({ contexts }) => eq(contexts.createdBy, flamecastToyCreatedBy)),
  [control])
  const rows = (contexts.data ?? [])
  return (
    <nav className="session-list" aria-label="toy sessions">
      {rows.length === 0 ? (
        <p className="empty">No local stdio runs yet.</p>
      ) : rows.map(context => (
        <button
          className={context.contextId === props.selectedId ? "selected" : ""}
          key={context.contextId}
          onClick={() => props.onSelect(context.contextId)}
          type="button"
        >
          <span>{context.contextId}</span>
          <small>{context.createdAt}</small>
        </button>
      ))}
    </nav>
  )
}

function Timeline(props: {
  readonly contextId: string | undefined
  readonly snapshot: RuntimeContextSnapshot | undefined
}) {
  if (props.contextId === undefined) {
    return (
      <section className="timeline placeholder">
        <img src="/clawd-sprite.png" alt="" />
        <p>Submit a prompt to launch a local stdio agent through Firegrid.</p>
      </section>
    )
  }

  const view = props.snapshot === undefined
    ? undefined
    : snapshotToSessionView(props.snapshot)

  return (
    <section className="timeline">
      <header className="timeline-head">
        <div>
          <p>runtime context</p>
          <h2>{props.contextId}</h2>
        </div>
        <span className={`status status-${view?.status ?? "created"}`}>
          {view?.status ?? "created"}
        </span>
      </header>
      <div className="prompt-card">
        <span>snapshot</span>
        <p>{view?.eventCount ?? 0} output rows observed through Firegrid.</p>
      </div>
      <TimelineOutput contextId={props.contextId} />
    </section>
  )
}

function TimelineOutput(props: {
  readonly contextId: string
}) {
  const output = useDurableTable(FiregridRuntimeTables.Output)
  // flamecast-toy-stdio-agents.LOCAL_AGENT.3
  // flamecast-toy-stdio-agents.REACTIVE_UI.1
  const events = useDurableLiveQuery((q) =>
    q.from({ events: output.events.collection })
      .where(({ events }) => eq(events.contextId, props.contextId)),
  [output, props.contextId])
  // flamecast-toy-stdio-agents.LOCAL_AGENT.3
  // flamecast-toy-stdio-agents.REACTIVE_UI.1
  const logs = useDurableLiveQuery((q) =>
    q.from({ logs: output.logs.collection })
      .where(({ logs }) => eq(logs.contextId, props.contextId)),
  [output, props.contextId])
  const eventRows = (events.data ?? [])
    .sort((left, right) => left.sequence - right.sequence)
  const logRows = (logs.data ?? [])
    .sort((left, right) => left.sequence - right.sequence)

  return (
    <div className="messages">
      {eventRows.map(row => (
        <article className="message message-assistant" key={row.sequence}>
          <span>stdout</span>
          <p>{row.raw}</p>
        </article>
      ))}
      {logRows.map(row => (
        <article className="message message-log" key={row.sequence}>
          <span>stderr</span>
          <p>{row.raw}</p>
        </article>
      ))}
      {eventRows.length === 0 && logRows.length === 0 && (
        <p className="empty">Waiting for RuntimeOutputTable rows...</p>
      )}
    </div>
  )
}

function Composer(props: {
  readonly firegrid: FiregridService
  readonly onLaunched: (contextId: string, snapshot: RuntimeContextSnapshot) => void
}) {
  const [prompt, setPrompt] = useState("Summarize why durable stdin matters.")
  const [busy, setBusy] = useState(false)
  const disabled = busy || prompt.trim().length === 0

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        if (disabled) return
        setBusy(true)
        const trimmed = prompt.trim()
        // eslint-disable-next-line no-restricted-syntax
        void Effect.runPromise(
          Effect.gen(function* () {
            const handle = yield* props.firegrid.launch({
              // flamecast-toy-stdio-agents.LOCAL_AGENT.1
              requestedBy: flamecastToyCreatedBy,
              runtime,
            })
            yield* props.firegrid.prompt({
              // flamecast-toy-stdio-agents.LOCAL_AGENT.2
              contextId: handle.contextId,
              payload: { type: "text", text: trimmed },
              idempotencyKey: `${handle.contextId}:initial`,
            })
            // flamecast-toy-stdio-agents.LOCAL_AGENT.3
            const snapshot = yield* props.firegrid.open(handle.contextId).snapshot
            return { contextId: handle.contextId, snapshot }
          }),
        )
          .then(({ contextId, snapshot }) => props.onLaunched(contextId, snapshot))
          .finally(() => setBusy(false))
      }}
    >
      <textarea
        onChange={event => setPrompt(event.currentTarget.value)}
        rows={3}
        value={prompt}
      />
      <button disabled={disabled} type="submit">
        Launch stdio agent
      </button>
    </form>
  )
}

function FiregridApp(props: { readonly firegrid: FiregridService }) {
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [snapshot, setSnapshot] = useState<RuntimeContextSnapshot | undefined>()

  useEffect(() => {
    if (selectedId === undefined) return
    // eslint-disable-next-line no-restricted-syntax
    void Effect.runPromise(props.firegrid.open(selectedId).snapshot)
      .then(setSnapshot)
  }, [props.firegrid, selectedId])

  const activeSnapshot = useMemo(
    () => snapshot?.contextId === selectedId ? snapshot : undefined,
    [selectedId, snapshot],
  )

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/clawd.svg" alt="" />
          <div>
            <h1>Flamecast</h1>
            <p>Firegrid local stdio toy</p>
          </div>
        </div>
        <SessionList
          onSelect={setSelectedId}
          selectedId={selectedId}
        />
        <ProviderStrip />
      </aside>
      <main>
        <header className="topbar">
          <span className="live-dot" />
          <span>Firegrid client · DurableTable · TanStack live query</span>
        </header>
        <Timeline
          contextId={selectedId}
          snapshot={activeSnapshot}
        />
        <Composer
          firegrid={props.firegrid}
          onLaunched={(contextId, nextSnapshot) => {
            setSelectedId(contextId)
            setSnapshot(nextSnapshot)
          }}
        />
      </main>
    </div>
  )
}

function App() {
  const { firegrid, error } = useFiregrid()
  if (error !== undefined) return <p className="error">{error}</p>
  if (firegrid === undefined) return <p className="empty">Connecting to Firegrid...</p>
  return (
    <DurableTableProvider
      fallback={<p className="empty">Connecting to durable tables...</p>}
      layer={FiregridBrowserTablesLive}
      tables={firegridRuntimeTableTags}
    >
      <FiregridApp firegrid={firegrid} />
    </DurableTableProvider>
  )
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
