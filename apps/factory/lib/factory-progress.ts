"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

export interface DarkFactoryRun {
  readonly factoryRunKey: string
  readonly subscriberId: string
  readonly source: string
  readonly externalEntityKey: string
  readonly plannerContextId: string
  readonly acceptedFactKey: readonly [string, string]
  readonly status: "accepted" | "planner_started" | "waiting_permission" | "resumed" | "done" | "failed"
  readonly createdAt: string
  readonly updatedAt: string
  readonly correlationId?: string
  readonly repoHint?: string
  readonly linearIssueId?: string
  readonly linearIdentifier?: string
  readonly linearUrl?: string
  readonly lastPermissionRequestId?: string
  readonly lastRuntimeSequence?: number
}

export interface DarkFactoryFact {
  readonly factKey: readonly [string, string]
  readonly source: string
  readonly externalEventKey: string
  readonly externalEntityKey: string
  readonly eventType: string
  readonly factoryRunKey?: string
  readonly contextId?: string
  readonly correlationId?: string
  readonly createdAt: string
  readonly payload: unknown
}

export interface RuntimeRunEventRow {
  readonly runEventId: {
    readonly contextId: string
    readonly activityAttempt: number
    readonly status: "started" | "exited" | "failed"
  }
  readonly contextId: string
  readonly activityAttempt: number
  readonly status: "started" | "exited" | "failed"
  readonly at: string
  readonly provider: string
  readonly exitCode?: number
  readonly signal?: string
  readonly message?: string
}

export interface RuntimeEventRow {
  readonly eventId: {
    readonly contextId: string
    readonly activityAttempt: number
    readonly target: "events"
    readonly sequence: number
  }
  readonly contextId: string
  readonly activityAttempt: number
  readonly sequence: number
  readonly source: "stdout"
  readonly format: "jsonl"
  readonly receivedAt: string
  readonly raw: string
}

export interface RuntimeLogLineRow {
  readonly logLineId: {
    readonly contextId: string
    readonly activityAttempt: number
    readonly target: "logs"
    readonly sequence: number
  }
  readonly contextId: string
  readonly activityAttempt: number
  readonly sequence: number
  readonly source: "stderr"
  readonly format: "text-lines"
  readonly receivedAt: string
  readonly raw: string
}

export interface RuntimeIngressInputRow {
  readonly inputId: string
  readonly contextId: string
  readonly sequence?: number
  readonly status: "pending" | "sequenced" | "cancelled"
  readonly kind: "message" | "control" | "tool_result" | "required_action_result"
  readonly authoredBy: "client" | "workflow" | "tool" | "system"
  readonly payload: unknown
  readonly idempotencyKey?: string
  readonly createdAt: string
  readonly sequencedAt?: string
  readonly metadata?: Readonly<Record<string, string>>
}

export interface FactoryPermissionOption {
  readonly optionId: string
  readonly kind: string
  readonly name: string
}

export interface FactoryPermissionRequest {
  readonly contextId: string
  readonly activityAttempt: number
  readonly sequence: number
  readonly permissionRequestId: string
  readonly toolUseId: string
  readonly options: ReadonlyArray<FactoryPermissionOption>
  readonly event: unknown
}

export interface FactoryRunStatusView {
  readonly run: DarkFactoryRun
  readonly facts: ReadonlyArray<DarkFactoryFact>
  readonly runtimeRuns: ReadonlyArray<RuntimeRunEventRow>
  readonly runtimeEvents: ReadonlyArray<RuntimeEventRow>
  readonly runtimeLogs: ReadonlyArray<RuntimeLogLineRow>
  readonly ingressInputs: ReadonlyArray<RuntimeIngressInputRow>
  readonly permissions: ReadonlyArray<FactoryPermissionRequest>
}

export type FactoryProgressState =
  | { status: "idle"; data?: undefined; error?: undefined }
  | { status: "loading"; data?: FactoryRunStatusView; error?: undefined }
  | { status: "ready"; data: FactoryRunStatusView; error?: undefined }
  | { status: "error"; data?: FactoryRunStatusView; error: string }

const refreshMs = 5_000

const factoryProgressStatusUrlTemplate = () =>
  process.env.NEXT_PUBLIC_FACTORY_PROGRESS_STATUS_URL_TEMPLATE?.trim()

const statusRequestUrl = (factoryRunKey: string): string => {
  const template = factoryProgressStatusUrlTemplate()
  if (template === undefined || template === "") {
    throw new Error(
      "No factory progress adapter is configured. Set NEXT_PUBLIC_FACTORY_PROGRESS_STATUS_URL_TEMPLATE.",
    )
  }
  if (!template.includes("{factoryRunKey}")) {
    throw new Error(
      "Factory progress adapter URL template must include {factoryRunKey}.",
    )
  }
  return template.replaceAll("{factoryRunKey}", encodeURIComponent(factoryRunKey))
}

const describeFetchError = async (response: Response) => {
  const body = await response.text().catch(() => "")
  return body.trim() === ""
    ? `Factory run request failed with ${response.status}`
    : body.trim()
}

export function useFactoryRunStatus(factoryRunKey: string) {
  const normalizedKey = useMemo(() => factoryRunKey.trim(), [factoryRunKey])
  const [state, setState] = useState<FactoryProgressState>({ status: "idle" })

  const load = useCallback(async () => {
    if (normalizedKey === "") {
      setState({ status: "idle" })
      return
    }

    setState(previous => previous.status === "ready"
      ? { status: "loading", data: previous.data }
      : { status: "loading" })

    try {
      const response = await fetch(statusRequestUrl(normalizedKey), {
        headers: { accept: "application/json" },
        cache: "no-store",
      })

      if (!response.ok) {
        throw new Error(await describeFetchError(response))
      }

      const data = await response.json() as FactoryRunStatusView
      setState({ status: "ready", data })
    } catch (error) {
      setState(previous => ({
        status: "error",
        data: previous.data,
        error: error instanceof Error ? error.message : "Factory run request failed",
      }))
    }
  }, [normalizedKey])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (normalizedKey === "") return
    const interval = window.setInterval(() => {
      void load()
    }, refreshMs)
    return () => window.clearInterval(interval)
  }, [load, normalizedKey])

  return {
    state,
    reload: load,
  }
}

export const formatTimestamp = (value: string | undefined) => {
  if (value === undefined || value.trim() === "") return "unknown"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export const compactJson = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
