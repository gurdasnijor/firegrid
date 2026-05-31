// tf-aago: the client-sdk `FiregridClientOperations` catalog was a
// duplicate of the protocol-owned one. The protocol catalog
// (`@firegrid/protocol/session-facade`, built via `defineFiregridOperation`)
// is canonical and a structural superset — it carries `{inputSchema,
// outputSchema}` plus projection metadata. Re-export it here so existing
// `@firegrid/client-sdk/operations` import paths keep resolving while the
// catalog has a single source of truth.
export {
  FiregridClientOperations,
  type PermissionRespondInput,
  type SessionPromptToolInput,
  type SessionPromptToolOutput,
} from "@firegrid/protocol/session-facade"
