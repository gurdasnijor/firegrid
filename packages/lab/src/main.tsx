import React from "react"
import { createRoot } from "react-dom/client"
import { App } from "./lab/App.tsx"

// durable-agent-runtime-lab.runtime-lab-inspector.PACKAGING.1
// durable-agent-runtime-lab.runtime-lab-inspector.PACKAGING.2
//
// Browser entrypoint. Vite + React + vanilla CSS modules — no UI
// framework dependency. Connects to a Durable Streams endpoint
// resolved in this order:
//
//   1. `?streamUrl=...` query parameter
//   2. `VITE_SUBSTRATE_STREAM_URL` env var
//   3. Default: http://127.0.0.1:4437/substrate/lab
//
// The default matches the host package's read-only embedded
// attach point: `pnpm --filter @durable-agent-substrate/host
// dev:embedded` boots a DurableStreamTestServer on port 4437 with
// stream name "lab" and no Host Program Graph. The lab does not
// import the host package; the only contract between the two is
// the stream URL.

const DEFAULT_DEV_STREAM_URL = "http://127.0.0.1:4437/substrate/lab"

const params = new URLSearchParams(window.location.search)
const queryStreamUrl = params.get("streamUrl") ?? undefined
const envStreamUrl = (import.meta as unknown as { env?: Record<string, string> })
  .env?.["VITE_SUBSTRATE_STREAM_URL"]

const streamUrl = queryStreamUrl ?? envStreamUrl ?? DEFAULT_DEV_STREAM_URL

const root = document.getElementById("root")
if (root === null) {
  throw new Error("lab: missing #root element")
}

createRoot(root).render(
  <React.StrictMode>
    <App streamUrl={streamUrl} />
  </React.StrictMode>,
)
