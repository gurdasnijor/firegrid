export const processAttemptId = (
  launchId: string,
  activityAttempt: number,
): string => `${launchId}:activity-attempt:${activityAttempt}`

export const processEventId = (
  launchId: string,
  activityAttempt: number,
  status: string,
): string => `${processAttemptId(launchId, activityAttempt)}:${status}`

export const journalRowId = (
  launchId: string,
  activityAttempt: number,
  stream: string,
  sequence: number,
): string => `${processAttemptId(launchId, activityAttempt)}:${stream}:${sequence}`
