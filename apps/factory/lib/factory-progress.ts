"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { FactoryRunStatusView } from "../src/index.ts"

export type { FactoryRunStatusView } from "../src/index.ts"

type FactoryProgressState =
  | { status: "idle"; data?: undefined; error?: undefined }
  | { status: "loading"; data?: FactoryRunStatusView | undefined; error?: undefined }
  | { status: "ready"; data: FactoryRunStatusView; error?: undefined }
  | { status: "error"; data?: FactoryRunStatusView | undefined; error: string }

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
      const message = error instanceof Error
        ? error.message
        : "Factory run request failed"
      setState(previous => previous.data === undefined
        ? { status: "error", error: message }
        : { status: "error", data: previous.data, error: message })
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
