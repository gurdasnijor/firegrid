"use client"

import { type FormEvent, useMemo, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock,
  Database,
  ExternalLink,
  FileText,
  GitBranch,
  Loader2,
  RefreshCcw,
  Search,
  ShieldQuestion,
  TerminalSquare,
} from "lucide-react"
import { GridBackground } from "../components/grid-background"
import { Header } from "../components/header"
import { LiveIndicator } from "../components/live-indicator"
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { Skeleton } from "../components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs"
import {
  compactJson,
  formatTimestamp,
  type FactoryRunStatusView,
  useFactoryRunStatus,
} from "../lib/factory-progress"
import { cn } from "../lib/utils"

const statusSteps = [
  { key: "accepted", label: "Accepted" },
  { key: "planner_started", label: "Planner" },
  { key: "waiting_permission", label: "Waiting" },
  { key: "resumed", label: "Resumed" },
  { key: "done", label: "Done" },
] as const

const statusAliases: Record<string, string> = {
  failed: "done",
}

const terminalStatuses = new Set(["done", "failed"])
const waitingStatuses = new Set(["waiting_permission"])

const statusLabel = (value: string) =>
  value.replaceAll("_", " ")

const stepIndexForStatus = (status: string) => {
  const normalized = statusAliases[status] ?? status
  const index = statusSteps.findIndex(step => step.key === normalized)
  return index === -1 ? 0 : index
}

function RunLookupForm({
  initialValue,
  loading,
  onSubmit,
  onRefresh,
}: {
  initialValue: string
  loading: boolean
  onSubmit: (factoryRunKey: string) => void
  onRefresh: () => void
}) {
  const [value, setValue] = useState(initialValue)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit(value.trim())
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={value}
          onChange={event => setValue(event.target.value)}
          placeholder="Factory run key"
          className="pl-9"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={value.trim() === "" || loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Open
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onRefresh}
          disabled={initialValue.trim() === "" || loading}
        >
          <RefreshCcw className={cn("h-4 w-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>
    </form>
  )
}

function EmptyState() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center justify-center py-20 text-center">
      <Database className="mb-4 h-12 w-12 text-muted-foreground/50" />
      <h2 className="text-xl font-semibold">No factory run selected</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Enter a factory run key from the dark factory backend to inspect durable progress rows.
      </p>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Skeleton className="h-40 lg:col-span-2" />
      <Skeleton className="h-40" />
      <Skeleton className="h-80 lg:col-span-3" />
    </div>
  )
}

function StatusRail({ status }: { status: string }) {
  const currentIndex = stepIndexForStatus(status)
  const terminal = terminalStatuses.has(status)
  const failed = status === "failed"

  return (
    <div className="grid gap-3 sm:grid-cols-5">
      {statusSteps.map((step, index) => {
        const complete = index < currentIndex || terminal
        const current = index === currentIndex && !terminal
        return (
          <div key={step.key} className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2",
                complete && !failed && "border-success bg-success text-background",
                failed && index === statusSteps.length - 1 && "border-destructive bg-destructive/10 text-destructive",
                current && "border-primary bg-primary/10 text-primary",
                !complete && !current && "border-border bg-card text-muted-foreground",
              )}
            >
              {complete && !failed ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : current ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Circle className="h-3 w-3" />
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{step.label}</p>
              {current && <p className="truncate text-xs text-muted-foreground">{statusLabel(status)}</p>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function RunOverview({ data }: { data: FactoryRunStatusView }) {
  const { run } = data
  const live = !terminalStatuses.has(run.status)
  const waiting = waitingStatuses.has(run.status)

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                Factory Run
                <LiveIndicator isLive={live} />
              </CardTitle>
              <p className="mt-1 break-all text-sm text-muted-foreground">{run.factoryRunKey}</p>
            </div>
            <Badge variant={waiting ? "secondary" : terminalStatuses.has(run.status) ? "outline" : "default"}>
              {statusLabel(run.status)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <StatusRail status={run.status} />
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Subscriber</p>
              <p className="mt-1 break-all font-mono text-xs">{run.subscriberId}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Planner Context</p>
              <p className="mt-1 break-all font-mono text-xs">{run.plannerContextId}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Source</p>
              <p className="mt-1 break-all font-mono text-xs">{run.source}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">External Entity</p>
              <p className="mt-1 break-all font-mono text-xs">{run.externalEntityKey}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Repository</p>
              <p className="mt-1">{run.repoHint ?? "Not reported"}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Updated</p>
              <p className="mt-1">{formatTimestamp(run.updatedAt)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Linear</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Issue</p>
            <p className="mt-1">{run.linearIdentifier ?? run.linearIssueId ?? "Not reported"}</p>
          </div>
          {run.linearUrl === undefined ? (
            <p className="text-muted-foreground">No Linear link reported.</p>
          ) : (
            <Button asChild variant="outline" size="sm">
              <a href={run.linearUrl} target="_blank" rel="noreferrer">
                Open Linear
                <ExternalLink className="h-3 w-3" />
              </a>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Metrics({ data }: { data: FactoryRunStatusView }) {
  const items = [
    { label: "Facts", value: data.facts.length, icon: FileText },
    { label: "Runtime Runs", value: data.runtimeRuns.length, icon: GitBranch },
    { label: "Output Events", value: data.runtimeEvents.length, icon: TerminalSquare },
    { label: "Logs", value: data.runtimeLogs.length, icon: Clock },
    { label: "Ingress Inputs", value: data.ingressInputs.length, icon: Database },
    { label: "Permissions", value: data.permissions.length, icon: ShieldQuestion },
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
      {items.map(item => (
        <Card key={item.label}>
          <CardContent className="flex items-center gap-3 p-4">
            <item.icon className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-2xl font-semibold">{item.value}</p>
              <p className="text-xs text-muted-foreground">{item.label}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function FactsPanel({ data }: { data: FactoryRunStatusView }) {
  const facts = data.facts.slice().reverse()

  return (
    <div className="space-y-3">
      {facts.length === 0 ? (
        <EmptyPanel label="No facts reported for this run." />
      ) : facts.map(fact => (
        <div key={`${fact.source}:${fact.externalEventKey}`} className="rounded-lg border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge variant="secondary">{fact.eventType}</Badge>
            <span className="text-xs text-muted-foreground">{formatTimestamp(fact.createdAt)}</span>
          </div>
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <Field label="Source" value={fact.source} />
            <Field label="External event" value={fact.externalEventKey} />
            <Field label="External entity" value={fact.externalEntityKey} />
            <Field label="Context" value={fact.contextId ?? "Not reported"} />
            <Field label="Correlation" value={fact.correlationId ?? "Not reported"} />
          </div>
          <pre className="mt-3 max-h-28 overflow-auto rounded bg-secondary/50 p-2 text-xs">
            {compactJson(fact.payload)}
          </pre>
        </div>
      ))}
    </div>
  )
}

function RuntimePanel({ data }: { data: FactoryRunStatusView }) {
  const timeline = useMemo(() => {
    const runs = data.runtimeRuns.map(row => ({
      key: `run:${row.contextId}:${row.activityAttempt}:${row.status}`,
      at: row.at,
      label: `run ${row.status}`,
      contextId: row.contextId,
      detail: row.message ?? row.provider,
    }))
    const events = data.runtimeEvents.map(row => ({
      key: `event:${row.contextId}:${row.activityAttempt}:${row.sequence}`,
      at: row.receivedAt,
      label: "runtime event",
      contextId: row.contextId,
      detail: row.raw,
    }))
    const logs = data.runtimeLogs.map(row => ({
      key: `log:${row.contextId}:${row.activityAttempt}:${row.sequence}`,
      at: row.receivedAt,
      label: "runtime log",
      contextId: row.contextId,
      detail: row.raw,
    }))
    return [...runs, ...events, ...logs].sort((left, right) => left.at.localeCompare(right.at)).reverse()
  }, [data])

  return (
    <div className="space-y-3">
      {timeline.length === 0 ? (
        <EmptyPanel label="No runtime observations reported yet." />
      ) : timeline.map(item => (
        <div key={item.key} className="rounded-lg border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge variant="outline">{item.label}</Badge>
            <span className="text-xs text-muted-foreground">{formatTimestamp(item.at)}</span>
          </div>
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{item.contextId}</p>
          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-secondary/50 p-2 text-xs">
            {item.detail}
          </pre>
        </div>
      ))}
    </div>
  )
}

function PermissionsPanel({ data }: { data: FactoryRunStatusView }) {
  return (
    <div className="space-y-3">
      {data.permissions.length === 0 ? (
        <EmptyPanel label="No permission requests reported yet." />
      ) : data.permissions.map(permission => (
        <div
          key={`${permission.contextId}:${permission.activityAttempt}:${permission.sequence}:${permission.permissionRequestId}`}
          className="rounded-lg border bg-card p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge>{permission.permissionRequestId}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{permission.toolUseId}</span>
          </div>
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{permission.contextId}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {permission.options.map(option => (
              <Badge key={option.optionId} variant="secondary">
                {option.name}
              </Badge>
            ))}
          </div>
          <pre className="mt-3 max-h-32 overflow-auto rounded bg-secondary/50 p-2 text-xs">
            {compactJson(permission.event)}
          </pre>
        </div>
      ))}
    </div>
  )
}

function IngressPanel({ data }: { data: FactoryRunStatusView }) {
  const rows = data.ingressInputs.slice().sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)).reverse()

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <EmptyPanel label="No ingress inputs reported yet." />
      ) : rows.map(input => (
        <div key={input.inputId} className="rounded-lg border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <Badge>{input.kind}</Badge>
              <Badge variant="secondary">{input.status}</Badge>
            </div>
            <span className="text-xs text-muted-foreground">{formatTimestamp(input.createdAt)}</span>
          </div>
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{input.contextId}</p>
          <pre className="mt-2 max-h-32 overflow-auto rounded bg-secondary/50 p-2 text-xs">
            {compactJson(input.payload)}
          </pre>
        </div>
      ))}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="break-all font-mono">{value}</p>
    </div>
  )
}

function EmptyPanel({ label }: { label: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed bg-card/50 p-6 text-center text-sm text-muted-foreground">
      {label}
    </div>
  )
}

export default function DarkFactoryPage() {
  const [factoryRunKey, setFactoryRunKey] = useState("")
  const { state, reload } = useFactoryRunStatus(factoryRunKey)
  const data = state.data
  const loading = state.status === "loading"

  return (
    <div className="relative flex min-h-screen flex-col bg-background">
      <GridBackground />
      <Header />

      <main className="container relative z-10 flex-1 space-y-6 px-4 py-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Dark Factory Progress</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Durable run status from the configured factory progress adapter.
            </p>
          </div>
          <div className="w-full lg:max-w-xl">
            <RunLookupForm
              initialValue={factoryRunKey}
              loading={loading}
              onSubmit={setFactoryRunKey}
              onRefresh={() => {
                void reload()
              }}
            />
          </div>
        </div>

        {state.status === "error" && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Progress request failed</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}

        {state.status === "idle" && <EmptyState />}
        {state.status === "loading" && data === undefined && <LoadingState />}

        {data !== undefined && (
          <div className="space-y-6">
            <RunOverview data={data} />
            <Metrics data={data} />

            <Tabs defaultValue="facts" className="space-y-4">
              <TabsList className="flex h-auto flex-wrap justify-start">
                <TabsTrigger value="facts">Facts</TabsTrigger>
                <TabsTrigger value="runtime">Runtime</TabsTrigger>
                <TabsTrigger value="permissions">Permissions</TabsTrigger>
                <TabsTrigger value="ingress">Ingress</TabsTrigger>
              </TabsList>
              <TabsContent value="facts">
                <FactsPanel data={data} />
              </TabsContent>
              <TabsContent value="runtime">
                <RuntimePanel data={data} />
              </TabsContent>
              <TabsContent value="permissions">
                <PermissionsPanel data={data} />
              </TabsContent>
              <TabsContent value="ingress">
                <IngressPanel data={data} />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </main>

      <footer className="border-t border-border py-4">
        <div className="container px-4 text-center text-xs text-muted-foreground">
          Powered by Firegrid Runtime
        </div>
      </footer>
    </div>
  )
}
