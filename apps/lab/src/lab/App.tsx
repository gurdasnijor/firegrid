import { LabEventStreamPanel } from "./LabEventStreamPanel.tsx"
import { LabOperationPanel } from "./LabOperationPanel.tsx"
import { RawStreamInspector } from "./RawStreamInspector.tsx"
import styles from "./styles.module.css"

// durable-agent-runtime-lab.runtime-lab-inspector.PACKAGING.1
// durable-agent-runtime-lab.runtime-lab-inspector.PACKAGING.2
// durable-agent-runtime-lab.runtime-lab-inspector.INSPECTION_SURFACE.4
// durable-agent-runtime-lab.runtime-lab-inspector.WRITE_BOUNDARY.1
// durable-agent-runtime-lab.runtime-lab-inspector.WRITE_BOUNDARY.2
// durable-agent-runtime-lab.runtime-lab-inspector.NO_PRIVILEGED_LAB.1
// durable-agent-runtime-lab.runtime-lab-inspector.NO_PRIVILEGED_LAB.2
// firegrid-architecture-boundary.DEPENDENCY_GRAPH.4
// firegrid-runtime-process.DEV_ENV_INJECTION.7
// firegrid-client-api.LAB_COMPATIBILITY.5
//
// Lab shell with a typed EventStream workbench and a separate raw
// diagnostic inspector.
//
// The entire surface is reachable through the external Durable
// Streams URL. Typed writes go through the app-facing Firegrid
// client; raw Durable Streams access stays read-only and diagnostic.
// The lab imports neither the runtime package nor the substrate
// package; the only contract with a running runtime is the stream URL.

interface AppProps {
  readonly streamUrl: string
  readonly streamUrlSource: "query" | "vite-env" | undefined
}

const streamSourceLabel = (source: AppProps["streamUrlSource"]): string =>
  source === "query" ? "query override" : "Vite environment"

export function App({ streamUrl, streamUrlSource }: AppProps) {
  const sourceLabel = streamSourceLabel(streamUrlSource)

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div>
          <span className={styles.headerTitle}>Firegrid Lab</span>
          <span className={styles.headerSubtitle}>
            Production client readiness surface
          </span>
        </div>
        <div className={styles.headerConnection}>
          <span className={styles.statusPill}>attached stream</span>
          <span className={styles.headerStreamSource}>
            stream source: {sourceLabel}
          </span>
          <span className={styles.headerStreamUrl}>{streamUrl}</span>
        </div>
      </header>
      <main
        className={styles.scenarioRegion}
        aria-label="Typed EventStream workbench"
      >
        <div className={styles.sectionHeading}>
          <span className={styles.sectionEyebrow}>App-facing client</span>
          <h2>Typed Workbench</h2>
        </div>
        <p className={styles.note}>
          Send typed operation intents and emit caller-owned
          EventStream rows through the app-local LabClient seam backed
          by the production Firegrid client.
        </p>
        <div className={styles.boundaryList} aria-label="Typed client boundary">
          <span>uses LabClient seam</span>
          <span>external stream URL only</span>
          <span>no runtime authority</span>
        </div>
        <p className={styles.note}>
          Canonical workflow: run Durable Streams separately and
          start the lab with an explicit stream URL:{" "}
          <code>
            VITE_DURABLE_STREAMS_URL=http://localhost:4437/v1/stream/firegrid pnpm dev:lab
          </code>
          . Override via <code>?streamUrl=...</code> or{" "}
          <code>VITE_DURABLE_STREAMS_URL</code> directly.
        </p>
        <LabOperationPanel streamUrl={streamUrl} />
        <LabEventStreamPanel streamUrl={streamUrl} />
      </main>
      <main
        className={styles.diagnosticRegion}
        aria-label="Raw diagnostics"
      >
        <div className={styles.sectionHeading}>
          <span className={styles.sectionEyebrow}>Read-only diagnostics</span>
          <h2>Raw Stream Inspector</h2>
        </div>
        <p className={styles.note}>
          Read-only raw stream inspector. This panel is deliberately
          separate from typed EventStream controls and is not a client
          write API.
        </p>
        <RawStreamInspector streamUrl={streamUrl} />
      </main>
    </div>
  )
}
