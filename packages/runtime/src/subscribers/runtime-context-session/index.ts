// Public subpath: `@firegrid/runtime/subscribers/runtime-context-session`.
//
// Wave 2 entry point: this file re-exports the runtime-owned codec-session
// command-sink contract from its real home in `./handler.ts`. The contract
// is intentionally narrow:
//
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

export {
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
  type RuntimeContextSessionCommandAccepted,
  type RuntimeContextSessionStartedEvidence,
  type RuntimeContextWorkflowSessionService,
} from "./handler.ts"
