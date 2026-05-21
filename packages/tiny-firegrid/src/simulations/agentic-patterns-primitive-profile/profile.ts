export const agenticPatternsPrimitiveToolNames = [
  // agentic-patterns-primitive-profile.SUBSTRATE_BOUNDARY.2
  "call",
  "send",
  "wait_for",
  "wait_for_any",
] as const

export const agenticPatternsForbiddenToolNames = [
  "execute",
  "schedule_me",
  "session_cancel",
  "session_close",
  "session_new",
  "session_prompt",
  "sleep",
  "spawn",
  "spawn_all",
] as const

export const agenticPatternsExternalKey = (runId: string) => ({
  source: "tiny-firegrid.agentic-patterns",
  id: runId,
})
