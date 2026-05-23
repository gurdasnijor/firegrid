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
// MUST NOT import the retired workflow body, the retired workflow Layer,
// the retired workflow payload schema, the retired engine-execute helper,
// or the retired workflow-runtime tag — those symbols are deleted (see
// the body+kernel deletion wave PR) and were forbidden across the
// host-sdk boundary anyway by
// `docs/architecture/2026-05-22-runtime-physical-target-tree.md` and the
// host-sdk import gate. This subpath does not re-export those symbols.

export {
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
  type RuntimeContextSessionCommandAccepted,
  type RuntimeContextSessionStartedEvidence,
  type RuntimeContextWorkflowSessionService,
} from "./handler.ts"
