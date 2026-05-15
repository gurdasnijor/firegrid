'use client'

import { cn } from '@/lib/utils'
import Link from 'next/link'
import { Factory, Github, BookOpen, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function Header() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 border border-primary/20">
            <Factory className="w-4 h-4 text-primary" />
          </div>
          <span className="font-semibold text-lg tracking-tight">
            Dark Factory
          </span>
          <span className="hidden sm:inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full bg-primary/10 text-primary border border-primary/20">
            BETA
          </span>
        </div>

        <nav className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" asChild>
            <Link href="#">
              <BookOpen className="w-4 h-4 mr-2" />
              Docs
            </Link>
          </Button>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" asChild>
            <Link href="#">
              <Github className="w-4 h-4 mr-2" />
              GitHub
            </Link>
          </Button>
          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
            <Settings className="w-4 h-4" />
          </Button>
        </nav>
      </div>
    </header>
  )
}
