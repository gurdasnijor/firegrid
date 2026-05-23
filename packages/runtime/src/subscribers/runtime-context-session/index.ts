// Wave 1 forward-target re-export for the RuntimeContext codec-session
// command-sink contract.
//
// Public subpath: `@firegrid/runtime/subscribers/runtime-context-session`.
//
// This file exposes ONLY the runtime-owned command-sink contract:
//   - the capability tag `RuntimeContextWorkflowSession`,
//   - the accepted-command and started-session evidence types,
//   - the service shape.
//
// Host packages implement the live codec sink against this contract. They
// MUST NOT import the workflow body, the workflow Layer, the workflow payload
// schema, `executeRuntimeContextWorkflow`, or the workflow-runtime tag —
// those are runtime-internal substrate and are forbidden across the host-sdk
// boundary by `docs/architecture/2026-05-22-runtime-physical-target-tree.md`
// and the host-sdk import gate. This subpath does not re-export those symbols.
//
// Wave 2 physically moves the implementation under this folder; the public
// subpath stays stable.

export {
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
  type RuntimeContextSessionCommandAccepted,
  type RuntimeContextSessionStartedEvidence,
  type RuntimeContextWorkflowSessionService,
} from "../../workflow-engine/workflows/runtime-context.ts"
