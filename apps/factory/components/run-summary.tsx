'use client'

import { cn } from '@/lib/utils'
import type { FactoryRun } from '@/lib/types'
import { Clock, GitPullRequest, ExternalLink, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface RunSummaryProps {
  run: FactoryRun
}

export function RunSummary({ run }: RunSummaryProps) {
  const duration = run.completedAt 
    ? Math.round((run.completedAt.getTime() - run.startedAt.getTime()) / 1000)
    : Math.round((Date.now() - run.startedAt.getTime()) / 1000)

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}m ${secs}s`
  }

  const isComplete = run.status === 'complete'
  const isError = run.status === 'error'

  return (
    <div className={cn(
      'rounded-xl border p-4 transition-all duration-300',
      isComplete && 'border-success/50 bg-success/5',
      isError && 'border-destructive/50 bg-destructive/5',
      !isComplete && !isError && 'border-border bg-card'
    )}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            {isComplete && <CheckCircle2 className="w-5 h-5 text-success" />}
            {isError && <XCircle className="w-5 h-5 text-destructive" />}
            {!isComplete && !isError && <Loader2 className="w-5 h-5 text-primary animate-spin" />}
            <h3 className="font-medium text-foreground">
              {isComplete ? 'Run Complete' : isError ? 'Run Failed' : 'In Progress'}
            </h3>
          </div>
          
          <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
            {run.prompt}
          </p>

          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDuration(duration)}
            </span>
            <span className="flex items-center gap-1">
              {run.agents.length} agent{run.agents.length !== 1 && 's'}
            </span>
            <span className="flex items-center gap-1">
              {run.messages.length} message{run.messages.length !== 1 && 's'}
            </span>
          </div>
        </div>

        {run.prUrl && (
          <Button variant="outline" size="sm" className="gap-2 shrink-0" asChild>
            <a href={run.prUrl} target="_blank" rel="noopener noreferrer">
              <GitPullRequest className="w-4 h-4" />
              View PR
              <ExternalLink className="w-3 h-3" />
            </a>
          </Button>
        )}
      </div>
    </div>
  )
}
