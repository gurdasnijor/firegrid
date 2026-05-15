'use client'

import { useMemo, useState } from 'react'
import { Header } from '@/components/header'
import { PromptInput } from '@/components/prompt-input'
import { AgentCard } from '@/components/agent-card'
import { MessageFeed } from '@/components/message-feed'
import { ProgressTracker } from '@/components/progress-tracker'
import { AgentGraph } from '@/components/agent-graph'
import { RunSummary } from '@/components/run-summary'
import { GridBackground } from '@/components/grid-background'
import { LiveIndicator } from '@/components/live-indicator'
import { useFactorySimulation } from '@/hooks/use-factory-simulation'
import { cn } from '@/lib/utils'
import { Bot, MessageSquare, Network, RotateCcw, Zap, Shield, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export default function DarkFactoryPage() {
  const { run, isRunning, simulateRun, stopRun, resetRun } = useFactorySimulation()
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)

  const agentNames = useMemo(() => {
    if (!run) return {}
    return run.agents.reduce((acc, agent) => {
      acc[agent.id] = agent.name
      return acc
    }, {} as Record<string, string>)
  }, [run])

  const filteredMessages = useMemo(() => {
    if (!run) return []
    if (!selectedAgentId) return run.messages
    return run.messages.filter(m => m.agentId === selectedAgentId)
  }, [run, selectedAgentId])

  return (
    <div className="min-h-screen flex flex-col bg-background relative">
      <GridBackground />
      <Header />

      <main className="flex-1 container px-4 py-6 relative z-10">
        {/* Hero / Input Section */}
        {!run && (
          <div className="max-w-2xl mx-auto text-center mb-8">
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mb-3 text-balance">
              AI Agents Building Your Ideas
            </h1>
            <p className="text-muted-foreground text-lg mb-8 text-pretty">
              Describe what you want to build. Watch autonomous agents plan, implement, review, and test in real-time.
            </p>
          </div>
        )}

        {/* Prompt Input */}
        <div className={cn('max-w-2xl mx-auto mb-8', run && 'max-w-none')}>
          <PromptInput
            onSubmit={simulateRun}
            onStop={stopRun}
            isRunning={isRunning}
            disabled={false}
          />
        </div>

        {/* Run Content */}
        {run && (
          <div className="space-y-6">
            {/* Progress Tracker */}
            <div className="max-w-2xl mx-auto">
              <ProgressTracker run={run} />
            </div>

            {/* Summary Card (when complete) */}
            {(run.status === 'complete' || run.status === 'error') && (
              <div className="max-w-2xl mx-auto">
                <RunSummary run={run} />
                <div className="flex justify-center mt-4">
                  <Button
                    variant="outline"
                    onClick={resetRun}
                    className="gap-2"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Start New Run
                  </Button>
                </div>
              </div>
            )}

            {/* Main Content Grid */}
            <div className="grid lg:grid-cols-3 gap-6">
              {/* Agents Panel */}
              <div className="lg:col-span-1 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-foreground flex items-center gap-2">
                    <Bot className="w-4 h-4 text-primary" />
                    Active Agents
                    <span className="text-xs text-muted-foreground font-normal">
                      ({run.agents.length})
                    </span>
                    <LiveIndicator isLive={isRunning} />
                  </h2>
                  {selectedAgentId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedAgentId(null)}
                      className="text-xs text-muted-foreground"
                    >
                      Clear filter
                    </Button>
                  )}
                </div>

                <div className="space-y-3">
                  {run.agents.map(agent => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      isSelected={selectedAgentId === agent.id}
                      onSelect={() => setSelectedAgentId(
                        selectedAgentId === agent.id ? null : agent.id
                      )}
                    />
                  ))}
                </div>
              </div>

              {/* Messages Panel */}
              <div className="lg:col-span-2">
                <Tabs defaultValue="messages" className="h-full flex flex-col">
                  <TabsList className="w-fit mb-4">
                    <TabsTrigger value="messages" className="gap-2">
                      <MessageSquare className="w-4 h-4" />
                      Messages
                    </TabsTrigger>
                    <TabsTrigger value="graph" className="gap-2">
                      <Network className="w-4 h-4" />
                      Agent Graph
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="messages" className="flex-1 mt-0">
                    <div className="h-[500px] rounded-xl border border-border bg-card/50 backdrop-blur-sm p-4 flex flex-col">
                      <div className="flex items-center justify-between mb-3 pb-3 border-b border-border">
                        <span className="text-sm text-muted-foreground">
                          {selectedAgentId 
                            ? `Showing messages from ${agentNames[selectedAgentId]}`
                            : 'All agent communications'
                          }
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {filteredMessages.length} message{filteredMessages.length !== 1 && 's'}
                        </span>
                      </div>
                      <MessageFeed
                        messages={filteredMessages}
                        agentNames={agentNames}
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="graph" className="flex-1 mt-0">
                    <div className="h-[500px] rounded-xl border border-border bg-card/50 backdrop-blur-sm p-4 flex items-center justify-center">
                      <AgentGraph agents={run.agents} />
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          </div>
        )}

        {/* Empty State Features */}
        {!run && (
          <div className="max-w-4xl mx-auto mt-12">
            <div className="grid sm:grid-cols-3 gap-6">
              {[
                {
                  icon: Zap,
                  title: 'Autonomous Planning',
                  description: 'AI planner analyzes your request and creates a detailed implementation strategy.',
                  color: 'text-agent-planner',
                  bgColor: 'bg-agent-planner/10',
                  borderColor: 'border-agent-planner/20',
                },
                {
                  icon: Bot,
                  title: 'Real-time Implementation',
                  description: 'Watch code changes happen as implementer agents work on your codebase.',
                  color: 'text-agent-implementer',
                  bgColor: 'bg-agent-implementer/10',
                  borderColor: 'border-agent-implementer/20',
                },
                {
                  icon: Shield,
                  title: 'Automated Review & QA',
                  description: 'Reviewer and QA agents ensure quality before any changes are merged.',
                  color: 'text-agent-reviewer',
                  bgColor: 'bg-agent-reviewer/10',
                  borderColor: 'border-agent-reviewer/20',
                },
              ].map((feature) => (
                <div
                  key={feature.title}
                  className={cn(
                    'p-5 rounded-xl border transition-colors duration-200 hover:border-opacity-50',
                    feature.bgColor,
                    feature.borderColor
                  )}
                >
                  <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center mb-3', feature.bgColor)}>
                    <feature.icon className={cn('w-5 h-5', feature.color)} />
                  </div>
                  <h3 className={cn('font-semibold mb-2', feature.color)}>
                    {feature.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-4">
        <div className="container px-4 text-center text-xs text-muted-foreground">
          Powered by Firegrid Runtime &middot; Choreography-driven AI orchestration
        </div>
      </footer>
    </div>
  )
}
