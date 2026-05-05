import { RawStreamInspector } from "./RawStreamInspector.tsx"
import styles from "./styles.module.css"

// durable-agent-runtime-lab.runtime-lab-inspector.PACKAGING.1
// durable-agent-runtime-lab.runtime-lab-inspector.PACKAGING.2
// durable-agent-runtime-lab.runtime-lab-inspector.INSPECTION_SURFACE.4
// durable-agent-runtime-lab.runtime-lab-inspector.WRITE_BOUNDARY.1
// durable-agent-runtime-lab.runtime-lab-inspector.WRITE_BOUNDARY.2
// durable-agent-runtime-lab.runtime-lab-inspector.NO_PRIVILEGED_LAB.1
// durable-agent-runtime-lab.runtime-lab-inspector.NO_PRIVILEGED_LAB.2
// launchable-substrate-host.LAB_INSPECTOR.6
// launchable-substrate-host.LAB_INSPECTOR.8
// launchable-substrate-host.LAB_INSPECTOR.9
//
// Lab shell — read-only inspector.
//
// This slice intentionally ships only the inspection surface. There
// are no scenario controls and no write buttons: the lab does not
// act as an application runtime. The substrate client surface today
// exposes a low-level `work.declare` capability whose semantic role
// (named-operation invocation, Restate-style) is not yet decided;
// surfacing that as a button would validate the wrong contract.
// A future runtime-runner / invocation-contract slice will add
// scenario controls; until then, the lab is a workbench for
// observing durable streams.
//
// The entire surface is reachable through the external Durable
// Streams client (read-only) and renders structured JSON. There is
// no host-package import (the @durable-agent-substrate/lab/src
// surface is ESLint-bound to client-only) and no privileged writer
// path.

export interface AppProps {
  readonly streamUrl: string
}

export function App({ streamUrl }: AppProps) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.headerTitle}>
          Durable Agent Substrate Lab
        </span>
        <span className={styles.headerStreamUrl}>{streamUrl}</span>
      </header>
      <main
        className={styles.diagnosticRegion}
        aria-label="Diagnostics"
      >
        <h2>Diagnostics</h2>
        <p className={styles.note}>
          Read-only inspector for a Durable Streams endpoint. No
          scenario controls and no writer surface in this slice —
          a future runtime-runner / invocation-contract slice will
          add example-program controls that go through the
          substrate client.
        </p>
        <p className={styles.note}>
          Default attach point is{" "}
          <code>http://127.0.0.1:4437/substrate/lab</code>, served
          by{" "}
          <code>
            pnpm --filter @durable-agent-substrate/host dev:embedded
          </code>
          . Override via <code>?streamUrl=...</code> or{" "}
          <code>VITE_SUBSTRATE_STREAM_URL</code>.
        </p>
        <RawStreamInspector streamUrl={streamUrl} />
      </main>
    </div>
  )
}
