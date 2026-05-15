import type { Agent, Message, FactoryRun, AgentRole } from './types'

const agentNames: Record<AgentRole, string[]> = {
  planner: ['Atlas', 'Nexus', 'Architect'],
  implementer: ['Forge', 'Builder', 'Craft'],
  reviewer: ['Sentinel', 'Guardian', 'Oracle'],
  qa: ['Validator', 'Tester', 'Prover'],
}

export function generateAgentName(role: AgentRole): string {
  const names = agentNames[role]
  return names[Math.floor(Math.random() * names.length)]
}

export function createInitialRun(prompt: string): FactoryRun {
  const plannerAgent: Agent = {
    id: `agent-${Date.now()}-planner`,
    role: 'planner',
    name: generateAgentName('planner'),
    status: 'thinking',
    currentTask: 'Analyzing request and creating implementation plan',
    createdAt: new Date(),
  }

  return {
    id: `run-${Date.now()}`,
    prompt,
    status: 'planning',
    agents: [plannerAgent],
    messages: [
      {
        id: `msg-${Date.now()}`,
        agentId: plannerAgent.id,
        agentRole: 'planner',
        content: `Received task: "${prompt}". Beginning analysis...`,
        type: 'thought',
        timestamp: new Date(),
      },
    ],
    startedAt: new Date(),
  }
}

// Simulation data for demo
export const mockMessages: Partial<Message>[] = [
  {
    content: 'Analyzing the codebase structure and identifying key integration points...',
    type: 'thought',
  },
  {
    content: 'Found 3 areas requiring modification. Creating implementation plan.',
    type: 'action',
  },
  {
    content: 'Plan approved. Spawning implementer agent for code changes.',
    type: 'result',
  },
  {
    content: 'Starting implementation of authentication module updates.',
    type: 'thought',
  },
  {
    content: 'Modified `auth.ts` - Added session validation middleware.',
    type: 'action',
  },
  {
    content: 'Updated `api/routes.ts` - Integrated new auth checks.',
    type: 'action',
  },
  {
    content: 'Implementation complete. Requesting code review.',
    type: 'request',
  },
  {
    content: 'Reviewing changes in 3 files. Checking for security patterns.',
    type: 'thought',
  },
  {
    content: 'Code review passed. Approving for QA.',
    type: 'approval',
  },
  {
    content: 'Running test suite against modified modules.',
    type: 'action',
  },
  {
    content: 'All 24 tests passed. No regressions detected.',
    type: 'result',
  },
]

export const mockTasks = [
  'Reviewing existing authentication patterns',
  'Mapping data flow through the application',
  'Identifying security requirements',
  'Creating branch: factory/auth-improvements',
  'Modifying authentication middleware',
  'Updating API route handlers',
  'Adding session validation',
  'Writing integration tests',
  'Running security scan',
  'Preparing pull request',
]
