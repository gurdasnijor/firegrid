'use client'

import { cn } from '@/lib/utils'
import type { Agent } from '@/lib/types'
import { useMemo } from 'react'

interface AgentGraphProps {
  agents: Agent[]
}

export function AgentGraph({ agents }: AgentGraphProps) {
  const { root, children } = useMemo(() => {
    const root = agents.find(a => !a.parentId)
    const children = agents.filter(a => a.parentId)
    return { root, children }
  }, [agents])

  if (!root) return null

  const roleColors = {
    planner: 'border-agent-planner bg-agent-planner/20',
    implementer: 'border-agent-implementer bg-agent-implementer/20',
    reviewer: 'border-agent-reviewer bg-agent-reviewer/20',
    qa: 'border-agent-qa bg-agent-qa/20',
  }

  const statusPulse = {
    thinking: 'animate-pulse',
    working: 'animate-pulse',
  }

  return (
    <div className="relative flex flex-col items-center gap-4 py-4">
      {/* Root node (Planner) */}
      <div
        className={cn(
          'relative z-10 px-4 py-2 rounded-lg border-2 transition-all duration-300',
          roleColors[root.role],
          statusPulse[root.status as keyof typeof statusPulse]
        )}
      >
        <span className="text-sm font-medium text-foreground">{root.name}</span>
      </div>

      {/* Connection lines */}
      {children.length > 0 && (
        <div className="relative w-full">
          {/* Vertical line from root */}
          <div className="absolute left-1/2 -top-4 w-0.5 h-4 bg-border" />
          
          {/* Horizontal line connecting children */}
          {children.length > 1 && (
            <div 
              className="absolute top-0 left-1/2 h-0.5 bg-border"
              style={{
                width: `${Math.min(children.length - 1, 2) * 120}px`,
                transform: 'translateX(-50%)',
              }}
            />
          )}

          {/* Child nodes */}
          <div className="flex justify-center gap-8 pt-4">
            {children.map((child, index) => (
              <div key={child.id} className="relative flex flex-col items-center">
                {/* Vertical connector to child */}
                <div className="absolute -top-4 w-0.5 h-4 bg-border" />
                
                <div
                  className={cn(
                    'px-3 py-1.5 rounded-lg border-2 transition-all duration-300',
                    roleColors[child.role],
                    statusPulse[child.status as keyof typeof statusPulse]
                  )}
                >
                  <span className="text-xs font-medium text-foreground">{child.name}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
