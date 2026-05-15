'use client'

import { cn } from '@/lib/utils'
import type { FactoryRun } from '@/lib/types'
import { Check, Circle, Loader2 } from 'lucide-react'

const phases = [
  { key: 'planning', label: 'Planning' },
  { key: 'implementing', label: 'Implementing' },
  { key: 'reviewing', label: 'Reviewing' },
  { key: 'qa', label: 'QA' },
  { key: 'complete', label: 'Complete' },
] as const

interface ProgressTrackerProps {
  run: FactoryRun | null
}

export function ProgressTracker({ run }: ProgressTrackerProps) {
  const currentIndex = run 
    ? phases.findIndex(p => p.key === run.status)
    : -1

  return (
    <div className="flex items-center justify-between gap-2">
      {phases.map((phase, index) => {
        const isComplete = currentIndex > index || run?.status === 'complete'
        const isCurrent = currentIndex === index && run?.status !== 'error'
        const isError = run?.status === 'error' && currentIndex === index
        
        return (
          <div key={phase.key} className="flex items-center gap-2 flex-1">
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center transition-all duration-300',
                  'border-2',
                  isComplete && 'bg-success border-success',
                  isCurrent && 'border-primary bg-primary/10',
                  isError && 'border-destructive bg-destructive/10',
                  !isComplete && !isCurrent && !isError && 'border-border bg-card'
                )}
              >
                {isComplete ? (
                  <Check className="w-4 h-4 text-background" />
                ) : isCurrent ? (
                  <Loader2 className="w-4 h-4 text-primary animate-spin" />
                ) : isError ? (
                  <Circle className="w-2 h-2 fill-destructive text-destructive" />
                ) : (
                  <Circle className="w-2 h-2 fill-muted-foreground/30 text-muted-foreground/30" />
                )}
              </div>
              <span
                className={cn(
                  'text-xs font-medium transition-colors whitespace-nowrap',
                  isComplete && 'text-success',
                  isCurrent && 'text-primary',
                  isError && 'text-destructive',
                  !isComplete && !isCurrent && !isError && 'text-muted-foreground'
                )}
              >
                {phase.label}
              </span>
            </div>
            
            {index < phases.length - 1 && (
              <div
                className={cn(
                  'flex-1 h-0.5 rounded transition-colors duration-300',
                  currentIndex > index ? 'bg-success' : 'bg-border'
                )}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
