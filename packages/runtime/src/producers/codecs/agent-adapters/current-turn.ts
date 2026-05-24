import { Context } from "effect"

export interface AgentTurn {
  readonly turnId: string
  readonly contextId?: string
}

// firegrid-effect-ai-native-agents.CURRENT_TURN.1
// firegrid-effect-ai-native-agents.CURRENT_TURN.2
export class CurrentAgentTurn extends Context.Tag(
  "firegrid/agent-adapters/CurrentAgentTurn",
)<CurrentAgentTurn, AgentTurn>() {}
