"use client"

import { cn } from "../lib/utils"

interface GridBackgroundProps {
  className?: string
}

export function GridBackground({ className }: GridBackgroundProps) {
  return (
    <div className={cn("pointer-events-none fixed inset-0 z-0 overflow-hidden", className)}>
      {/* Grid pattern */}
      <div 
        className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: `
            linear-gradient(to right, currentColor 1px, transparent 1px),
            linear-gradient(to bottom, currentColor 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
        }}
      />
      
      {/* Radial gradient overlay */}
      <div 
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(var(--primary-rgb, 217, 119, 87), 0.08), transparent)",
        }}
      />
      
      {/* Bottom fade */}
      <div 
        className="absolute bottom-0 left-0 right-0 h-40"
        style={{
          background: "linear-gradient(to top, var(--background), transparent)",
        }}
      />
    </div>
  )
}
