'use client'

import { useState, useCallback, useRef } from 'react'
import type { FactoryRun, Agent, Message, AgentRole } from '@/lib/types'
import { createInitialRun, generateAgentName, mockMessages, mockTasks } from '@/lib/mock-data'

export function useFactorySimulation() {
  const [run, setRun] = useState<FactoryRun | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const timeoutRef = useRef<NodeJS.Timeout[]>([])

  const clearAllTimeouts = useCallback(() => {
    timeoutRef.current.forEach(clearTimeout)
    timeoutRef.current = []
  }, [])

  const addMessage = useCallback((message: Message) => {
    setRun(prev => prev ? { ...prev, messages: [...prev.messages, message] } : null)
  }, [])

  const updateAgent = useCallback((agentId: string, updates: Partial<Agent>) => {
    setRun(prev => prev ? {
      ...prev,
      agents: prev.agents.map(a => a.id === agentId ? { ...a, ...updates } : a),
    } : null)
  }, [])

  const addAgent = useCallback((agent: Agent) => {
    setRun(prev => prev ? { ...prev, agents: [...prev.agents, agent] } : null)
  }, [])

  const simulateRun = useCallback((prompt: string) => {
    clearAllTimeouts()
    const initialRun = createInitialRun(prompt)
    setRun(initialRun)
    setIsRunning(true)

    const planner = initialRun.agents[0]
    let delay = 0

    // Phase 1: Planner thinks and works
    const plannerMessages = mockMessages.slice(0, 3)
    plannerMessages.forEach((msg, i) => {
      delay += 1500 + Math.random() * 1000
      const t = setTimeout(() => {
        const taskIndex = Math.min(i, mockTasks.length - 1)
        updateAgent(planner.id, {
          status: i < 2 ? 'working' : 'complete',
          currentTask: mockTasks[taskIndex],
          progress: Math.min(100, (i + 1) * 35),
        })
        addMessage({
          id: `msg-${Date.now()}-${i}`,
          agentId: planner.id,
          agentRole: 'planner',
          content: msg.content!,
          type: msg.type!,
          timestamp: new Date(),
        })
        if (i === 2) {
          setRun(prev => prev ? { ...prev, status: 'implementing' } : null)
        }
      }, delay)
      timeoutRef.current.push(t)
    })

    // Phase 2: Spawn implementer
    delay += 2000
    const implementerId = `agent-${Date.now()}-impl`
    const t1 = setTimeout(() => {
      const implementer: Agent = {
        id: implementerId,
        role: 'implementer',
        name: generateAgentName('implementer'),
        status: 'thinking',
        currentTask: 'Starting implementation',
        parentId: planner.id,
        createdAt: new Date(),
      }
      addAgent(implementer)
      addMessage({
        id: `msg-${Date.now()}-spawn-impl`,
        agentId: planner.id,
        agentRole: 'planner',
        content: `Spawning ${implementer.name} to handle code changes`,
        type: 'action',
        timestamp: new Date(),
        targetAgentId: implementerId,
      })
    }, delay)
    timeoutRef.current.push(t1)

    // Phase 2b: Implementer works
    const implMessages = mockMessages.slice(3, 7)
    implMessages.forEach((msg, i) => {
      delay += 2000 + Math.random() * 1500
      const t = setTimeout(() => {
        updateAgent(implementerId, {
          status: i < 3 ? 'working' : 'waiting',
          currentTask: mockTasks[3 + i],
          progress: Math.min(100, (i + 1) * 25),
        })
        addMessage({
          id: `msg-${Date.now()}-impl-${i}`,
          agentId: implementerId,
          agentRole: 'implementer',
          content: msg.content!,
          type: msg.type!,
          timestamp: new Date(),
        })
        if (i === 3) {
          setRun(prev => prev ? { ...prev, status: 'reviewing' } : null)
        }
      }, delay)
      timeoutRef.current.push(t)
    })

    // Phase 3: Spawn reviewer
    delay += 1500
    const reviewerId = `agent-${Date.now()}-rev`
    const t2 = setTimeout(() => {
      const reviewer: Agent = {
        id: reviewerId,
        role: 'reviewer',
        name: generateAgentName('reviewer'),
        status: 'thinking',
        currentTask: 'Starting code review',
        parentId: planner.id,
        createdAt: new Date(),
      }
      addAgent(reviewer)
    }, delay)
    timeoutRef.current.push(t2)

    // Phase 3b: Reviewer works
    const reviewMessages = mockMessages.slice(7, 9)
    reviewMessages.forEach((msg, i) => {
      delay += 2500 + Math.random() * 1000
      const t = setTimeout(() => {
        updateAgent(reviewerId, {
          status: i === 0 ? 'working' : 'complete',
          currentTask: mockTasks[7 + i],
          progress: i === 0 ? 50 : 100,
        })
        updateAgent(implementerId, {
          status: 'complete',
          progress: 100,
        })
        addMessage({
          id: `msg-${Date.now()}-rev-${i}`,
          agentId: reviewerId,
          agentRole: 'reviewer',
          content: msg.content!,
          type: msg.type!,
          timestamp: new Date(),
        })
        if (i === 1) {
          setRun(prev => prev ? { ...prev, status: 'qa' } : null)
        }
      }, delay)
      timeoutRef.current.push(t)
    })

    // Phase 4: Spawn QA
    delay += 1500
    const qaId = `agent-${Date.now()}-qa`
    const t3 = setTimeout(() => {
      const qa: Agent = {
        id: qaId,
        role: 'qa',
        name: generateAgentName('qa'),
        status: 'thinking',
        currentTask: 'Preparing test suite',
        parentId: planner.id,
        createdAt: new Date(),
      }
      addAgent(qa)
    }, delay)
    timeoutRef.current.push(t3)

    // Phase 4b: QA works
    const qaMessages = mockMessages.slice(9, 11)
    qaMessages.forEach((msg, i) => {
      delay += 2000 + Math.random() * 1000
      const t = setTimeout(() => {
        updateAgent(qaId, {
          status: i === 0 ? 'working' : 'complete',
          currentTask: mockTasks[8 + i],
          progress: i === 0 ? 60 : 100,
        })
        addMessage({
          id: `msg-${Date.now()}-qa-${i}`,
          agentId: qaId,
          agentRole: 'qa',
          content: msg.content!,
          type: msg.type!,
          timestamp: new Date(),
        })
      }, delay)
      timeoutRef.current.push(t)
    })

    // Phase 5: Complete
    delay += 2000
    const t4 = setTimeout(() => {
      setRun(prev => prev ? {
        ...prev,
        status: 'complete',
        completedAt: new Date(),
        prUrl: 'https://github.com/org/repo/pull/123',
      } : null)
      updateAgent(planner.id, { status: 'complete', progress: 100 })
      setIsRunning(false)
    }, delay)
    timeoutRef.current.push(t4)
  }, [clearAllTimeouts, addMessage, updateAgent, addAgent])

  const stopRun = useCallback(() => {
    clearAllTimeouts()
    setIsRunning(false)
    setRun(prev => prev ? { ...prev, status: 'error' } : null)
  }, [clearAllTimeouts])

  const resetRun = useCallback(() => {
    clearAllTimeouts()
    setRun(null)
    setIsRunning(false)
  }, [clearAllTimeouts])

  return {
    run,
    isRunning,
    simulateRun,
    stopRun,
    resetRun,
  }
}
