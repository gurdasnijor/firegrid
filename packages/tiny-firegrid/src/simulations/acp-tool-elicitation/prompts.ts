// Curated prompt matrix for the live ACP tool-elicitation sim. One entry = one
// agent turn (one span). Each prompt deliberately targets a tool / subsystem so
// coverage is intentional rather than random.
//
// Prompts are tagged with a `group` and ordered baseline-first. The driver walks
// them in order and fails fast after consecutive provider/timeout failures (see
// driver.ts), so the cheap baseline turns double as a preflight: if the agent or
// provider is unhealthy, the run aborts within a couple of turns instead of
// burning the whole TINY_FIREGRID_TIMEOUT budget. The `group` lands on each
// turn span so the trace can be sliced per concern.
//
// Sizing note: real claude-acp turns run ~7-20s each. A full pass of this matrix
// needs a raised budget (e.g. TINY_FIREGRID_TIMEOUT="300 seconds"); the
// fail-fast walk caps the downside when a provider window goes bad.

/** Coarse concern each prompt targets; surfaces as a per-turn span attribute. */
type ElicitationGroup = "baseline" | "channel" | "child" | "scheduler"

export interface ElicitationPrompt {
  /** Short stable label — surfaces as the per-turn span's prompt_label. */
  readonly label: string
  /** Concern bucket — surfaces as the per-turn span's group, and orders the walk. */
  readonly group: ElicitationGroup
  readonly text: string
}

export const elicitationPrompts: ReadonlyArray<ElicitationPrompt> = [
  // -- baseline: cheap, should always succeed; doubles as a health preflight. ----
  {
    label: "introspection",
    group: "baseline",
    text: "List every tool you have available, with a one-line purpose each.",
  },
  {
    label: "sleep",
    group: "baseline",
    text: "Use your sleep tool to durably suspend for 2 seconds, then tell me you woke up.",
  },
  {
    label: "known_lifecycle_wait",
    group: "baseline",
    text:
      "Use wait_for on channel session.self.lifecycle with timeoutMs 3000 and no match. " +
      "Report the row received or the timeout exactly.",
  },
  {
    label: "permission_pressure_sleep",
    group: "baseline",
    text:
      "Call sleep three times in a row: 250ms, 250ms, and 250ms. Report after all three complete.",
  },
  // -- channel: wait_for / wait_for_any / send, including known-negative channels. -
  {
    label: "wait_for",
    group: "channel",
    text:
      "Use wait_for to block on a session.self.checkpoint event with a 5 second timeout, and " +
      "report the row you receive or the timeout.",
  },
  {
    label: "send",
    group: "channel",
    text:
      "Use the send tool to append the payload {\"hello\":\"firegrid\"} to an egress channel of " +
      "your choosing, and report the exact result or error.",
  },
  {
    label: "wait_for_any_mixed",
    group: "channel",
    text:
      "Use wait_for_any with two channels: session.self.checkpoint and factory.events. " +
      "Use a 3000ms timeout. Report whether it timed out, matched, or failed, including the exact error.",
  },
  {
    label: "unknown_channel_explicit",
    group: "channel",
    text:
      "Use wait_for on channel factory.events with match {\"eventType\":\"factory.run.approved\"} " +
      "and timeoutMs 3000. Report the exact result or error.",
  },
  // -- child: session_new / session_prompt / session_cancel + the output-wait gap. -
  {
    label: "child-session",
    group: "child",
    text:
      "Use session_new to spawn a child session, then use session_prompt to ask that child to " +
      "reply with the single word \"pong\", then report exactly what happened.",
  },
  {
    label: "child_startup_bad_agent",
    group: "child",
    text:
      "Call session_new with agentKind exactly \"firegrid-nonexistent-executable-xyzzy\" " +
      "and prompt \"hello\". Report the returned session status and any error exactly.",
  },
  {
    label: "child_handle_only",
    group: "child",
    text:
      "Use session_new to spawn a child session with prompt \"reply with child-ready\". " +
      "Do not prompt it again. Report only the returned sessionId, contextId, status, and metadata.",
  },
  {
    label: "child_prompt_twice",
    group: "child",
    text:
      "Use session_new to spawn a child session, then call session_prompt twice on that same child: " +
      "first with \"first\", then with \"second\". Report each session_prompt result exactly.",
  },
  {
    label: "child_cancel",
    group: "child",
    text:
      "Use session_new to spawn a child session, then immediately use session_cancel on that child. " +
      "Report the session_new status and session_cancel result exactly.",
  },
  {
    label: "child_output_single_probe",
    group: "child",
    text:
      "Use session_new to spawn a child session, then session_prompt asking it to reply \"pong\". " +
      "Then try exactly one wait_for on channel session.agent_output with timeoutMs 3000. " +
      "Report the exact result or error. Do not guess any other channel names.",
  },
  // -- scheduler: schedule_me (overdue fire-and-forget; non-blocking post-#637). ----
  {
    label: "schedule_me_overdue",
    group: "scheduler",
    text:
      "Use schedule_me with when exactly 0 and prompt \"scheduled overdue fired\". " +
      "Report the tool result immediately and then continue normally.",
  },
]
