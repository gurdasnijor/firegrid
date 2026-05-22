// Curated prompt matrix for the live ACP tool-elicitation sim. One entry = one
// agent turn (one span). Each prompt deliberately targets a tool / subsystem so
// coverage is intentional rather than random.
//
// Sizing note: real claude-acp turns run ~7-20s each, and the tiny-firegrid
// runner's default timeout is 90s. This default list is sized to fit; raise
// TINY_FIREGRID_TIMEOUT (e.g. "300 seconds") if you add more.
//
// `schedule_me` is intentionally omitted: it blocks the calling turn until the
// scheduled time and times out the edge (tf-uoga / #632; fix in PR #637).
// Re-add a SHORT one to verify once #637 lands:
//   { label: "schedule_me", text: "use schedule_me to schedule a prompt to
//     yourself ~15 seconds from now that says 'scheduled fired'" }

export interface ElicitationPrompt {
  /** Short stable label — surfaces as the per-turn span's prompt_label. */
  readonly label: string
  readonly text: string
}

export const elicitationPrompts: ReadonlyArray<ElicitationPrompt> = [
  {
    label: "introspection",
    text: "List every tool you have available, with a one-line purpose each.",
  },
  {
    label: "sleep",
    text: "Use your sleep tool to durably suspend for 2 seconds, then tell me you woke up.",
  },
  {
    label: "child-session",
    text:
      "Use session_new to spawn a child session, then use session_prompt to ask that child to " +
      "reply with the single word \"pong\", then report exactly what happened.",
  },
  {
    label: "wait_for",
    text:
      "Use wait_for to block on a session.self.checkpoint event with a 5 second timeout, and " +
      "report the row you receive or the timeout.",
  },
  {
    label: "send",
    text:
      "Use the send tool to append the payload {\"hello\":\"firegrid\"} to an egress channel of " +
      "your choosing, and report the exact result or error.",
  },
]
