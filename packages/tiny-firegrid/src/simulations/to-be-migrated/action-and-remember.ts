/* eslint-disable */
import { Firegrid } from "@firegrid/client-sdk/firegrid"
import type { FiregridHost } from "@firegrid/host-sdk"
import {
  CurrentHostSession,
  durableStreamUrl,
  hostOwnedStreamUrl,
  makeHostSessionRow,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  RuntimeStartCapability,
  runtimeControlPlaneStreamUrl,
  type HostId,
  type HostSessionId,
} from "@firegrid/protocol/launch"
import { toolExecutionFailed } from "@firegrid/host-sdk/agent-tools/bindings"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "@firegrid/host-sdk/agent-tools/execution"
import {
  ExecuteToolInputSchema,
  type SandboxRef,
} from "@firegrid/protocol/agent-tools"
import { DurableTable } from "effect-durable-operators"
import { Effect, Layer, Option, Schema } from "effect"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "../../types.ts"

interface ActionAndRememberFinding {
  readonly id: string
  readonly status: "failed-claim" | "reach-past"
  readonly summary: string
  readonly evidence: string
}

interface ActionAndRememberClaim {
  readonly name: string
  readonly status: "passed" | "failed"
  readonly evidence: string
}

interface ExecuteInvocation {
  readonly toolUseId: string
  readonly toolName: "execute"
  readonly params: unknown
}

interface ExecuteOutcome {
  readonly ok: boolean
  readonly result: unknown
}

interface ActionAndRememberSimulationResult {
  readonly participantId: string
  readonly toolUseId: string
  readonly evidenceId: string
  readonly executeSucceeded: boolean
  readonly evidenceRecorded: boolean
  readonly laterWaitMatched: boolean
  readonly historyObserved: boolean
  readonly historyCount: number
  readonly claimStatus: "passed" | "failed"
  readonly claims: ReadonlyArray<ActionAndRememberClaim>
  readonly findings: ReadonlyArray<ActionAndRememberFinding>
}

const ActionEvidenceRowSchema = Schema.Struct({
  evidenceId: Schema.String.pipe(DurableTable.primaryKey),
  participantId: Schema.String,
  actionId: Schema.String,
  toolUseId: Schema.String,
  capability: Schema.Literal("execute"),
  sandboxProvider: Schema.String,
  sandboxTool: Schema.String,
  status: Schema.Literal("succeeded", "failed"),
  sequence: Schema.Number,
  request: Schema.Unknown,
  result: Schema.Unknown,
})
type ActionEvidenceRow = Schema.Schema.Type<typeof ActionEvidenceRowSchema>

class ActionEvidenceTable extends DurableTable("tiny.actionAndRemember", {
  evidence: ActionEvidenceRowSchema,
}) {}

const stringifyUnknown = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const unusedTool = (name: string) =>
  (params: { readonly toolUseId: string }) =>
    Effect.fail(toolExecutionFailed(
      params.toolUseId,
      name,
      "action-and-remember simulation only exposes execute, not " + name,
    ))

const actionCapabilityHost: AgentToolHostService = {
  spawnChildContext: unusedTool("session_new"),
  spawnChildContexts: unusedTool("spawn_all"),
  executeSandboxTool: ({ sandbox, input }) =>
    Effect.succeed({
      acknowledged: true,
      providerName: sandbox.providerName,
      toolName: sandbox.toolName,
      effect: "posted-pr-comment",
      input,
    }),
  executeSessionCapability: ({ capability, input }) =>
    Effect.succeed({
      acknowledged: true,
      capability,
      input,
    }),
  appendSessionPrompt: unusedTool("session_prompt"),
  cancelSession: unusedTool("session_cancel"),
  closeSession: unusedTool("session_close"),
}

const evidenceLayer = (env: TinyFiregridSimulationEnv) =>
  ActionEvidenceTable.layer({
    streamOptions: {
      url: durableStreamUrl(env.durableStreamsBaseUrl, `${env.namespace}.actionAndRemember`),
      contentType: "application/json",
    },
    txTimeoutMs: 2_000,
  })

const sandboxFromParams = (
  params: unknown,
): SandboxRef | undefined => {
  if (typeof params !== "object" || params === null || !("sandbox" in params)) return undefined
  const sandbox = (params as { readonly sandbox?: unknown }).sandbox
  if (typeof sandbox !== "object" || sandbox === null) return undefined
  const candidate = sandbox as { readonly providerName?: unknown; readonly toolName?: unknown }
  if (typeof candidate.providerName !== "string" || typeof candidate.toolName !== "string") return undefined
  return { providerName: candidate.providerName, toolName: candidate.toolName }
}

const invokeAdvertisedExecute = (
  invocation: ExecuteInvocation,
): Effect.Effect<ExecuteOutcome, never, AgentToolHost> =>
  Effect.gen(function*() {
    const input = yield* Schema.decodeUnknown(ExecuteToolInputSchema)(invocation.params)
    const host = yield* AgentToolHost
    if (input.sessionId !== undefined && input.capability !== undefined) {
      const result = yield* host.executeSessionCapability({
        toolUseId: invocation.toolUseId,
        sessionId: input.sessionId,
        capability: input.capability,
        input: input.input,
      })
      return { ok: true, result }
    }
    if (input.sandbox === undefined) {
      return yield* Effect.fail("execute requires either sessionId + capability or a sandbox reference")
    }
    const result = yield* host.executeSandboxTool({
      toolUseId: invocation.toolUseId,
      sandbox: input.sandbox,
      input: input.input,
    })
    return { ok: true, result }
  }).pipe(
    Effect.catchAll(error => Effect.succeed({ ok: false, result: stringifyUnknown(error) })),
  )

const recordExecuteEvidence = (
  input: {
    readonly participantId: string
    readonly actionId: string
    readonly invocation: ExecuteInvocation
    readonly outcome: ExecuteOutcome
  },
) =>
  Effect.gen(function*() {
    const table = yield* ActionEvidenceTable
    const sandbox = sandboxFromParams(input.invocation.params) ?? {
      providerName: "session",
      toolName: "capability",
    }
    const row: ActionEvidenceRow = {
      evidenceId: `${input.participantId}:${input.actionId}:evidence`,
      participantId: input.participantId,
      actionId: input.actionId,
      toolUseId: input.invocation.toolUseId,
      capability: input.invocation.toolName,
      sandboxProvider: sandbox.providerName,
      sandboxTool: sandbox.toolName,
      status: input.outcome.ok ? "succeeded" : "failed",
      sequence: 1,
      request: input.invocation.params,
      result: input.outcome.result,
    }
    yield* table.evidence.insert(row)
    return row
  })

const waitForEvidence = (
  input: {
    readonly participantId: string
    readonly actionId: string
    readonly evidenceId: string
  },
) =>
  Effect.gen(function*() {
    const table = yield* ActionEvidenceTable
    const row = yield* table.evidence.get(input.evidenceId)
    return Option.filter(row, candidate =>
      candidate.participantId === input.participantId &&
      candidate.actionId === input.actionId &&
      candidate.status === "succeeded",
    )
  })

const participantHistory = (
  input: {
    readonly participantId: string
    readonly evidenceId: string
  },
) =>
  Effect.gen(function*() {
    const table = yield* ActionEvidenceTable
    const row = yield* table.evidence.get(input.evidenceId)
    return Option.match(row, {
      onNone: (): ReadonlyArray<ActionEvidenceRow> => [],
      onSome: candidate =>
        candidate.participantId === input.participantId ? [candidate] : [],
    })
  })

const claim = (
  name: string,
  passed: boolean,
  evidence: string,
): ActionAndRememberClaim => ({
  name,
  status: passed ? "passed" : "failed",
  evidence,
})

const findingsFor = (
  result: Omit<ActionAndRememberSimulationResult, "claimStatus" | "claims" | "findings">,
): ReadonlyArray<ActionAndRememberFinding> => {
  const findings: Array<ActionAndRememberFinding> = []
  if (!result.executeSucceeded) {
    findings.push({
      id: "action-and-remember.execute.failed",
      status: "failed-claim",
      summary: "execute did not return a successful bounded capability result.",
      evidence: `toolUseId=${result.toolUseId}`,
    })
  }
  if (!result.evidenceRecorded || !result.laterWaitMatched || !result.historyObserved) {
    findings.push({
      id: "action-and-remember.evidence.not-durable-observable",
      status: "failed-claim",
      summary: "The action result was not durably observable to a later evidence wait and participant history read.",
      evidence:
        `evidenceRecorded=${result.evidenceRecorded} laterWaitMatched=${result.laterWaitMatched} historyObserved=${result.historyObserved}`,
    })
  }
  return findings
}

const runActionAndRemember = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<ActionAndRememberSimulationResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    yield* Firegrid
    const participantId = `participant:${env.runId}`
    const actionId = `post-pr-comment:${env.runId}`
    const toolUseId = `execute:${env.runId}`
    const invocation: ExecuteInvocation = {
      toolUseId,
      toolName: "execute",
      params: {
        sandbox: { providerName: "demo", toolName: "post-pr-comment" },
        input: {
          pr: 376,
          body: "factory participant recorded an external action",
        },
      },
    }

    const tableLayer = evidenceLayer(env)
    const outcome = yield* invokeAdvertisedExecute(invocation).pipe(
      Effect.provide(AgentToolHost.layer(actionCapabilityHost)),
    )
    const evidence = yield* recordExecuteEvidence({
      participantId,
      actionId,
      invocation,
      outcome,
    }).pipe(Effect.provide(tableLayer))

    // firegrid-observability.TINY_FIREGRID_SIMULATIONS.10
    // Re-acquire the app-owned table before the later observations so the
    // assertion is durable-table backed, not an in-memory variable handoff.
    const waitMatch = yield* waitForEvidence({
      participantId,
      actionId,
      evidenceId: evidence.evidenceId,
    }).pipe(
      Effect.provide(tableLayer),
    )
    const history = yield* participantHistory({ participantId, evidenceId: evidence.evidenceId }).pipe(
      Effect.provide(tableLayer),
    )

    const base = {
      participantId,
      toolUseId,
      evidenceId: evidence.evidenceId,
      executeSucceeded: outcome.ok,
      evidenceRecorded: evidence.status === "succeeded",
      laterWaitMatched: Option.isSome(waitMatch) && waitMatch.value.evidenceId === evidence.evidenceId,
      historyObserved: history.some(row => row.evidenceId === evidence.evidenceId),
      historyCount: history.length,
    }
    const claims = [
      claim("execute capability returned", base.executeSucceeded, `toolUseId=${toolUseId}`),
      claim("durable evidence row recorded", base.evidenceRecorded, `evidenceId=${evidence.evidenceId}`),
      claim("later evidence wait matched", base.laterWaitMatched, `evidenceId=${evidence.evidenceId}`),
      claim("participant history observed action", base.historyObserved, `historyCount=${base.historyCount}`),
    ]
    const findings = findingsFor(base)
    return {
      ...base,
      claimStatus: findings.length === 0 ? "passed" : "failed",
      claims,
      findings,
    }
  })

const makeHost = (
  env: TinyFiregridSimulationEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const session = makeHostSessionRow({
    hostId: "host-a" as HostId,
    hostSessionId: "host-a-session" as HostSessionId,
    namespace: env.namespace,
    startedAtMs: 0,
  })
  return Layer.mergeAll(
    Layer.succeed(CurrentHostSession, session),
    Layer.succeed(RuntimeStartCapability, RuntimeStartCapability.of({
      start: options =>
        Effect.succeed({
          contextId: options.contextId,
          activityAttempt: 0,
          exitCode: 0,
        }),
    })),
    RuntimeControlPlaneTable.layer({
      streamOptions: {
        url: runtimeControlPlaneStreamUrl({
          baseUrl: env.durableStreamsBaseUrl,
          namespace: env.namespace,
        }),
        contentType: "application/json",
      },
      txTimeoutMs: 2_000,
    }),
    RuntimeOutputTable.layer({
      streamOptions: {
        url: hostOwnedStreamUrl({
          baseUrl: env.durableStreamsBaseUrl,
          prefix: session.streamPrefix,
          segment: "runtimeOutput",
        }),
        contentType: "application/json",
      },
      txTimeoutMs: 2_000,
    }),
  ) as Layer.Layer<FiregridHost, unknown>
}

export const actionAndRememberSimulation = {
  id: "action-and-remember",
  description:
    "Checks that an execute capability invocation can be remembered as a durable evidence row and observed by a later participant wait/history read.",
  makeHost,
  driver: runActionAndRemember,
} satisfies TinyFiregridSimulation<ActionAndRememberSimulationResult>
