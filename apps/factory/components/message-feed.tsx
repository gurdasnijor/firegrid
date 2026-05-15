'use client'

import { cn } from '@/lib/utils'
import type { Message, AgentRole } from '@/lib/types'
import { useEffect, useRef } from 'react'
import { Brain, Code, Eye, FlaskConical, ArrowRight, Lightbulb, Play, CheckCircle2, HelpCircle, ThumbsUp } from 'lucide-react'

const roleConfig: Record<AgentRole, { icon: typeof Brain; color: string; bgColor: string }> = {
  planner: { icon: Brain, color: 'text-agent-planner', bgColor: 'bg-agent-planner/10' },
  implementer: { icon: Code, color: 'text-agent-implementer', bgColor: 'bg-agent-implementer/10' },
  reviewer: { icon: Eye, color: 'text-agent-reviewer', bgColor: 'bg-agent-reviewer/10' },
  qa: { icon: FlaskConical, color: 'text-agent-qa', bgColor: 'bg-agent-qa/10' },
}

const typeConfig = {
  thought: { icon: Lightbulb, label: 'Thinking' },
  action: { icon: Play, label: 'Action' },
  result: { icon: CheckCircle2, label: 'Result' },
  request: { icon: HelpCircle, label: 'Request' },
  approval: { icon: ThumbsUp, label: 'Approved' },
}

interface MessageItemProps {
  message: Message
  agentName: string
}

function MessageItem({ message, agentName }: MessageItemProps) {
  const role = roleConfig[message.agentRole]
  const type = typeConfig[message.type]
  const RoleIcon = role.icon
  const TypeIcon = type.icon

  return (
    <div className={cn(
      'group relative flex gap-3 p-3 rounded-lg transition-colors',
      'hover:bg-secondary/50',
      role.bgColor
    )}>
      {/* Avatar */}
      <div className={cn(
        'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
        'bg-background border border-border',
        role.color
      )}>
        <RoleIcon className="w-4 h-4" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={cn('font-medium text-sm', role.color)}>
            {agentName}
          </span>
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <TypeIcon className="w-3 h-3" />
            {type.label}
          </span>
          <span className="text-xs text-muted-foreground ml-auto">
            {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        </div>
        <p className="text-sm text-foreground leading-relaxed">
          {message.content}
        </p>
        {message.targetAgentId && (
          <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowRight className="w-3 h-3" />
            <span>Delegating to child agent</span>
          </div>
        )}
      </div>
    </div>
  )
}

interface MessageFeedProps {
  messages: Message[]
  agentNames: Record<string, string>
}

export function MessageFeed({ messages, agentNames }: MessageFeedProps) {
  const feedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight
    }
  }, [messages])

  return (
    <div 
      ref={feedRef}
      className="flex-1 overflow-y-auto space-y-2 pr-2 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
    >
      {messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
          <Brain className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm">Agent messages will appear here</p>
        </div>
      ) : (
        messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            agentName={agentNames[message.agentId] || 'Unknown'}
          />
        ))
      )}
    </div>
  )
}
