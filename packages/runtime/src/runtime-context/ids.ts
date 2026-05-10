export const runId = (
  contextId: string,
  activityAttempt: number,
): string => `${contextId}:activity-attempt:${activityAttempt}`

export const runEventId = (
  contextId: string,
  activityAttempt: number,
  status: string,
): string => `${runId(contextId, activityAttempt)}:${status}`

export const outputRowId = (
  contextId: string,
  activityAttempt: number,
  target: string,
  sequence: number,
): string => `${runId(contextId, activityAttempt)}:${target}:${sequence}`
