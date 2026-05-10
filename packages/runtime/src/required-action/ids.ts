export const requiredActionRequestedRowId = (
  requiredActionId: string,
): string =>
  `required-action:${requiredActionId}:requested`

export const requiredActionResolvedRowId = (
  requiredActionId: string,
): string =>
  `required-action:${requiredActionId}:resolved`
