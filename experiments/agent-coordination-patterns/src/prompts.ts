import type { ExperimentArm } from "./types.ts"

export const promptForArm = (
  arm: ExperimentArm,
  taskPacket: string,
): string => {
  const finalArtifactInstructions = [
    "When the task is complete, publish the final artifact with the Firegrid send tool:",
    "- channel: coordination.final",
    "- payload: a JSON object, not a JSON string",
    "- include kind:\"final\", title, body, and any relevant workId/status fields",
    "The experiment runner will treat the arm as incomplete unless coordination.final receives that artifact.",
  ].join("\n")

  switch (arm) {
    case "single":
      return [
        "You are the only participant in this experiment arm.",
        "Own the whole task end to end.",
        "Do not spawn child sessions unless the task genuinely requires it.",
        "",
        finalArtifactInstructions,
        "",
        taskPacket,
      ].join("\n")

    case "central":
      return [
        "You are the central orchestrator in this experiment arm.",
        "You may delegate, but delegation must use the Firegrid agent tools:",
        "- use session_new to create child sessions;",
        "- use session_prompt to send child tasks;",
        "- use wait_for on channel session.agent_output with match.sessionId and match.afterSequence to observe child replies.",
        "",
        "Your final answer must summarize which child sessions you created, what they reported, and how their reports affected your conclusion.",
        "",
        finalArtifactInstructions,
        "",
        taskPacket,
      ].join("\n")

    case "choreography":
      return [
        "You are a peer participant in the choreography experiment arm.",
        "There is no central manager. Watch the shared coordination board, claim useful work, publish findings, and react to peer findings.",
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
