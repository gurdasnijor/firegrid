// tf-aago: the client-sdk `FiregridClientOperations` catalog was a
// duplicate of the protocol-owned one. The protocol catalog
// (`@firegrid/protocol/session-facade`, built from plain schema groups)
// is canonical and a structural superset — it carries `{input,
// output}` groups whose input schemas carry projection metadata. Re-export
// it here so existing `@firegrid/client-sdk/operations` import paths keep
// resolving while the catalog has a single source of truth.
export {
  FiregridClientOperations,
  type PermissionRespondInput,
  type SessionCancelToolInput,
  type SessionCancelToolOutput,
  type SessionCloseToolInput,
  type SessionCloseToolOutput,
  type SessionPromptToolInput,
  type SessionPromptToolOutput,
} from "@firegrid/protocol/session-facade"
