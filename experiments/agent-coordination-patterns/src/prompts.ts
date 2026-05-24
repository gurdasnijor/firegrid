import type { ExperimentArm } from "./types.ts"

export const promptForArm = (
  arm: ExperimentArm,
  taskPacket: string,
): string => {
  const finalArtifactInstructions = [
    "Important tool boundary:",
    "- Do not use shell, filesystem, terminal, execute, or repository-inspection tools.",
    "- The task packet contains the materials needed for this run.",
    "- Use only Firegrid session tools and Firegrid channel tools.",
    "",
    "When the task is complete, publish the final artifact with the Firegrid send tool:",
    "- channel: coordination.final",
    "- payload: a JSON object, not a JSON string",
    "- include kind:\"final\", title, body, status:\"complete\", and any relevant workId fields",
    "- keep body under 1,200 characters",
    "- make the send tool call before writing any prose summary",
    "- after the send tool returns success, stop; do not retry or expand the answer",
    "The experiment runner will treat the arm as incomplete unless coordination.final receives that artifact.",
  ].join("\n")

  switch (arm) {
    case "single":
      return [
        // agent-coordination-patterns-experiment.ARMS.5
        "You are the only participant in this experiment arm.",
        "Own the whole task end to end.",
        "Do not spawn child sessions. You may use wait_for / wait_for_any to read inbound coordination board rows needed by the task, but do not write coordination board rows except coordination.final.",
        "",
        finalArtifactInstructions,
        "",
        taskPacket,
      ].join("\n")

    case "central":
      return [
        // agent-coordination-patterns-experiment.ARMS.3
        // agent-coordination-patterns-experiment.ARMS.6
        "You are the central orchestrator in this experiment arm.",
        "You must delegate before producing the final artifact, even when the task looks small. This arm intentionally measures orchestration overhead.",
        "Delegation must use the Firegrid agent tools:",
        "- use session_new to create child sessions;",
        "- use session_prompt to send child tasks;",
        "- use wait_for on channel session.agent_output with match.sessionId and match.afterSequence to observe child replies.",
        "- create at least two child sessions with different assignments;",
        "- do not publish coordination.final until at least one child reply has been observed.",
        "",
        "Your final answer must summarize which child sessions you created, what they reported, and how their reports affected your conclusion.",
        "",
        finalArtifactInstructions,
        "",
        taskPacket,
      ].join("\n")

    case "choreography":
      return [
        // agent-coordination-patterns-experiment.ARMS.4
        // agent-coordination-patterns-experiment.ARMS.7
        "You are a peer participant in the choreography experiment arm.",
        "There is no central manager. Watch the shared coordination board, claim useful work, publish findings, and react to peer findings.",
        "Before publishing coordination.final, publish at least one coordination.claims row and one coordination.findings or coordination.reviews row.",
        "If another peer already produced a final artifact, still publish your finding/review rows; the runner measures board behavior, not just the first final.",
        "",
        "Required board channels:",
        "- coordination.work",
        "- coordination.claims",
        "- coordination.findings",
        "- coordination.questions",
        "- coordination.reviews",
        "- coordination.final",
        "",
        "Use wait_for_any to watch board channels, send to publish board rows, and session.agent_output only when observing another session's output is part of your coordination work.",
        "For every send to a coordination.* channel, payload must be a JSON object, not a JSON string.",
        "",
        finalArtifactInstructions,
        "",
        taskPacket,
      ].join("\n")
  }
}
