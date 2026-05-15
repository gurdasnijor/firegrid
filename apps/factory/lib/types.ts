export type AgentRole = 'planner' | 'implementer' | 'reviewer' | 'qa'

export type AgentStatus = 'idle' | 'thinking' | 'working' | 'waiting' | 'complete' | 'error'

export interface Agent {
  id: string
  role: AgentRole
  name: string
  status: AgentStatus
  currentTask?: string
  progress?: number
  parentId?: string
  createdAt: Date
}

export interface Message {
  id: string
  agentId: string
  agentRole: AgentRole
  content: string
  type: 'thought' | 'action' | 'result' | 'request' | 'approval'
  timestamp: Date
  targetAgentId?: string
}

export interface FactoryRun {
  id: string
  prompt: string
  status: 'pending' | 'planning' | 'implementing' | 'reviewing' | 'qa' | 'complete' | 'error'
  agents: Agent[]
  messages: Message[]
  startedAt: Date
  completedAt?: Date
  linearIssueId?: string
  prUrl?: string
}
