'use client'

import { cn } from '@/lib/utils'

interface LiveIndicatorProps {
  isLive: boolean
  className?: string
}

export function LiveIndicator({ isLive, className }: LiveIndicatorProps) {
  if (!isLive) return null

  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', className)}>
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
      </span>
      <span className="text-success font-medium">Live</span>
    </span>
  )
}
