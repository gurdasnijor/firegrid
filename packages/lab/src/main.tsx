import React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./lab/App.tsx"

// durable-agent-runtime-lab.runtime-lab-inspector.PACKAGING.1
// durable-agent-runtime-lab.runtime-lab-inspector.PACKAGING.2
//
// Browser entrypoint. Vite + React + vanilla CSS modules — no UI
// framework dependency. Connects to a Durable Streams endpoint
// supplied via a `?streamUrl=...` query parameter or the
// VITE_SUBSTRATE_STREAM_URL env var. The lab is read-only this
// slice; there is no default that points at an embedded host
// process the lab itself owns.

const params = new URLSearchParams(window.location.search)
const queryStreamUrl = params.get("streamUrl") ?? undefined
const envStreamUrl = (import.meta as unknown as { env?: Record<string, string> })
  .env?.["VITE_SUBSTRATE_STREAM_URL"]

const streamUrl = queryStreamUrl ?? envStreamUrl

const root = document.getElementById("root")
if (root === null) {
  throw new Error("lab: missing #root element")
}

if (streamUrl === undefined || streamUrl.length === 0) {
  createRoot(root).render(
    <React.StrictMode>
      <main style={{ padding: "16px", fontFamily: "monospace" }}>
        <h1>Durable Agent Substrate Lab</h1>
        <p>
          No stream URL configured. Provide{" "}
          <code>?streamUrl=&lt;durable-streams-url&gt;</code> in the
          query string, or set <code>VITE_SUBSTRATE_STREAM_URL</code>{" "}
          when running the dev server.
        </p>
      </main>
    </React.StrictMode>,
  )
} else {
  createRoot(root).render(
    <React.StrictMode>
      <App streamUrl={streamUrl} />
    </React.StrictMode>,
  )
}
