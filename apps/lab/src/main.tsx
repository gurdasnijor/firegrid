import React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./lab/App.tsx"

// firegrid-architecture-boundary.DEPENDENCY_GRAPH.4
// firegrid-runtime-process.DEV_ENV_INJECTION.7
//
// Browser entrypoint. Vite + React + vanilla CSS modules — no UI
// framework dependency. Connects to a Durable Streams endpoint
// resolved in this order:
//
//   1. `?streamUrl=...` query parameter
//   2. `VITE_DURABLE_STREAMS_URL` env var owned by the Vite process
//
// There is no fixed-port default. If neither source is present the
// lab renders an empty-state pointing at the attached workflow.
// The lab does not import the runtime or substrate packages; the
// only contract with a running runtime is the stream URL.

const params = new URLSearchParams(window.location.search)
const queryStreamUrl = params.get("streamUrl") ?? undefined
const envStreamUrl = (
  import.meta as unknown as { env?: Record<string, string> }
).env?.["VITE_DURABLE_STREAMS_URL"]

const streamUrl =
  queryStreamUrl !== undefined && queryStreamUrl.length > 0
    ? queryStreamUrl
    : envStreamUrl
const streamUrlSource =
  queryStreamUrl !== undefined && queryStreamUrl.length > 0
    ? "query"
    : streamUrl !== undefined && streamUrl.length > 0
      ? "vite-env"
      : undefined

const root = document.getElementById("root")
if (root === null) {
  throw new Error("lab: missing #root element")
}

if (streamUrl === undefined || streamUrl.length === 0) {
  createRoot(root).render(
    <React.StrictMode>
      <main
        style={{
          padding: "16px",
          fontFamily: "ui-monospace, monospace",
          maxWidth: "640px",
        }}
      >
        <h1>Firegrid Lab</h1>
        <p>
          No Durable Streams URL configured. Run Durable Streams
          separately and start Vite with the stream URL:
        </p>
        <pre
          style={{
            background: "#1e293b",
            color: "#e2e8f0",
            padding: "12px",
            borderRadius: "6px",
            overflowX: "auto",
          }}
        >
          VITE_DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid pnpm dev:lab
        </pre>
        <p>
          Or override directly: pass <code>?streamUrl=...</code> in
          the query string, or set{" "}
          <code>VITE_DURABLE_STREAMS_URL</code> when starting Vite.
        </p>
      </main>
    </React.StrictMode>,
  )
} else {
  createRoot(root).render(
    <React.StrictMode>
      <App streamUrl={streamUrl} streamUrlSource={streamUrlSource} />
    </React.StrictMode>,
  )
}
