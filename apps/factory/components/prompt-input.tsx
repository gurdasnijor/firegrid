'use client'

import { useState, KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Send, Sparkles, Square } from 'lucide-react'

interface PromptInputProps {
  onSubmit: (prompt: string) => void
  onStop?: () => void
  isRunning?: boolean
  disabled?: boolean
}

export function PromptInput({ onSubmit, onStop, isRunning, disabled }: PromptInputProps) {
  const [value, setValue] = useState('')

  const handleSubmit = () => {
    if (!value.trim() || disabled) return
    onSubmit(value.trim())
    setValue('')
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="relative">
      <div className={cn(
        'relative rounded-xl border bg-card transition-all duration-200',
        'focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/20',
        disabled && 'opacity-50'
      )}>
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe what you want to build or fix..."
          disabled={disabled || isRunning}
          className={cn(
            'min-h-[100px] max-h-[200px] resize-none border-0 bg-transparent',
            'focus-visible:ring-0 focus-visible:ring-offset-0',
            'placeholder:text-muted-foreground/60',
            'pr-24'
          )}
        />
        
        <div className="absolute bottom-3 right-3 flex items-center gap-2">
          {isRunning ? (
            <Button
              onClick={onStop}
              variant="destructive"
              size="sm"
              className="gap-2"
            >
              <Square className="w-3 h-3 fill-current" />
              Stop
            </Button>
          ) : (
            <Button
              onClick={handleSubmit}
              disabled={!value.trim() || disabled}
              size="sm"
              className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              <Send className="w-3 h-3" />
              Run
            </Button>
          )}
        </div>
      </div>

      {/* Quick suggestions */}
      {!isRunning && !value && (
        <div className="mt-3 flex flex-wrap gap-2">
          {[
            'Add user authentication to the app',
            'Fix the checkout flow bug',
            'Improve API error handling',
          ].map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => setValue(suggestion)}
              className={cn(
                'px-3 py-1.5 text-xs rounded-full border border-border',
                'bg-secondary/50 text-muted-foreground',
                'hover:bg-secondary hover:text-foreground hover:border-primary/30',
                'transition-colors duration-200',
                'flex items-center gap-1.5'
              )}
            >
              <Sparkles className="w-3 h-3 text-primary" />
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
