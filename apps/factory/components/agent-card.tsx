'use client'

import { cn } from '@/lib/utils'
import type { Agent, AgentRole } from '@/lib/types'
import { Bot, Brain, Code, Eye, FlaskConical, Loader2, Check, AlertCircle, Pause } from 'lucide-react'
import { Progress } from '@/components/ui/progress'

const roleConfig: Record<AgentRole, { icon: typeof Bot; label: string; color: string }> = {
  planner: { icon: Brain, label: 'Planner', color: 'text-agent-planner' },
  implementer: { icon: Code, label: 'Implementer', color: 'text-agent-implementer' },
  reviewer: { icon: Eye, label: 'Reviewer', color: 'text-agent-reviewer' },
  qa: { icon: FlaskConical, label: 'QA', color: 'text-agent-qa' },
}

const statusConfig = {
  idle: { icon: Pause, label: 'Idle', class: 'text-muted-foreground' },
  thinking: { icon: Loader2, label: 'Thinking', class: 'text-primary animate-spin' },
  working: { icon: Loader2, label: 'Working', class: 'text-primary animate-spin' },
  waiting: { icon: Pause, label: 'Waiting', class: 'text-warning' },
  complete: { icon: Check, label: 'Complete', class: 'text-success' },
  error: { icon: AlertCircle, label: 'Error', class: 'text-destructive' },
}

interface AgentCardProps {
  agent: Agent
  isSelected?: boolean
  onSelect?: () => void
}

export function AgentCard({ agent, isSelected, onSelect }: AgentCardProps) {
  const role = roleConfig[agent.role]
  const status = statusConfig[agent.status]
  const RoleIcon = role.icon
  const StatusIcon = status.icon

  return (
    <button
      onClick={onSelect}
      className={cn(
        'group relative w-full p-4 rounded-lg border transition-all duration-200 text-left',
        'hover:border-primary/50 hover:bg-secondary/50',
        isSelected ? 'border-primary bg-secondary' : 'border-border bg-card'
      )}
    >
      {/* Glow effect when active */}
      {(agent.status === 'thinking' || agent.status === 'working') && (
        <div className={cn(
          'absolute inset-0 rounded-lg opacity-20 blur-xl -z-10',
          agent.role === 'planner' && 'bg-agent-planner',
          agent.role === 'implementer' && 'bg-agent-implementer',
          agent.role === 'reviewer' && 'bg-agent-reviewer',
          agent.role === 'qa' && 'bg-agent-qa',
        )} />
      )}

      <div className="flex items-start gap-3">
        <div className={cn(
          'flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center',
          'bg-secondary border border-border',
          role.color
        )}>
          <RoleIcon className="w-5 h-5" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="font-medium text-foreground truncate">{agent.name}</h3>
              <p className={cn('text-xs', role.color)}>{role.label}</p>
            </div>
            <div className={cn('flex items-center gap-1 text-xs', status.class)}>
              <StatusIcon className="w-3 h-3" />
              <span className="hidden sm:inline">{status.label}</span>
            </div>
          </div>

          {agent.currentTask && (
            <p className="mt-2 text-sm text-muted-foreground line-clamp-2">
              {agent.currentTask}
            </p>
          )}

          {agent.progress !== undefined && agent.status !== 'complete' && (
            <div className="mt-3">
              <Progress 
                value={agent.progress} 
                className={cn(
                  "h-1.5",
                  agent.role === 'planner' && '[&>[data-slot=progress-indicator]]:bg-agent-planner',
                  agent.role === 'implementer' && '[&>[data-slot=progress-indicator]]:bg-agent-implementer',
                  agent.role === 'reviewer' && '[&>[data-slot=progress-indicator]]:bg-agent-reviewer',
                  agent.role === 'qa' && '[&>[data-slot=progress-indicator]]:bg-agent-qa',
                )}
              />
            </div>
          )}
        </div>
      </div>
    </button>
  )
}
