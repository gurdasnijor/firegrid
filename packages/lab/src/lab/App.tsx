import { LabEventStreamPanel } from "./LabEventStreamPanel.tsx"
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
// firegrid-runtime-process.DEV_ENV_INJECTION.5
//
// Lab shell with a typed EventStream workbench and a separate raw
// diagnostic inspector.
//
// The entire surface is reachable through the external Durable
// Streams URL. Typed writes go through the app-facing Firegrid
// client; raw Durable Streams access stays read-only and diagnostic.
// The lab imports neither @firegrid/runtime nor @durable-agent-
// substrate/substrate; the only contract with a running runtime is
// the stream URL.

export interface AppProps {
  readonly streamUrl: string
}

export function App({ streamUrl }: AppProps) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.headerTitle}>Firegrid Lab</span>
        <span className={styles.headerStreamUrl}>{streamUrl}</span>
      </header>
      <main
        className={styles.scenarioRegion}
        aria-label="Typed EventStream workbench"
      >
        <h2>Typed Workbench</h2>
        <p className={styles.note}>
          Emit and observe caller-owned EventStream rows through
          the app-facing Firegrid client.
        </p>
        <p className={styles.note}>
          Canonical workflow: boot the Firegrid runtime with the lab
          as a child:{" "}
          <code>
            firegrid dev -- pnpm --filter @firegrid/lab dev
          </code>
          . The runtime injects <code>VITE_DURABLE_STREAMS_URL</code>
          {" "}so the browser attaches with no manual wiring. Override
          via <code>?streamUrl=...</code> or{" "}
          <code>VITE_DURABLE_STREAMS_URL</code> directly.
        </p>
        <LabEventStreamPanel streamUrl={streamUrl} />
      </main>
      <main
        className={styles.diagnosticRegion}
        aria-label="Raw diagnostics"
      >
        <h2>Diagnostics</h2>
        <p className={styles.note}>
          Read-only raw stream inspector. This panel is deliberately
          separate from typed EventStream controls.
        </p>
        <RawStreamInspector streamUrl={streamUrl} />
      </main>
    </div>
  )
}
