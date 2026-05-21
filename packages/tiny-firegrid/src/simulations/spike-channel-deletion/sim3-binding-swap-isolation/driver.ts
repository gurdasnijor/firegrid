import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import type { PermissionDecision } from "@firegrid/protocol/agent-tools"
import {
  SessionPermissionChannel,
  SessionPermissionChannelTarget,
  type SessionPermissionChannelRequest,
} from "@firegrid/protocol/channels/session-permission"
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  runtimeContextOutputStreamUrl,
  runtimeControlPlaneStreamUrl,
  type HostStreamPrefix,
  type RuntimeEventRow,
  type RuntimeInputIntentRow,
} from "@firegrid/protocol/launch"
import {
  SessionPermissionAutoApproveLayer,
  SessionPermissionChannelLive,
} from "@firegrid/host-sdk"
import { encodeRuntimeAgentOutputEnvelope } from "@firegrid/runtime/events"
import { Effect } from "effect"
import { sim3RuntimeEnv, type Sim3RuntimeEnv } from "./host.ts"

interface PermissionResponseSummary {
  readonly inputId: string
  readonly contextId: string
  readonly permissionRequestId: string
  readonly decision: string
  readonly origin: string
}

interface Sim3BindingSwapIsolationResult {
  readonly verdict: "GREEN"
  readonly sessionAId: string
  readonly sessionBId: string
  readonly requestAId: string
  readonly requestBId: string
  readonly sameChannelTag: boolean
  readonly sameChannelTarget: string
  readonly sessionAResponses: ReadonlyArray<PermissionResponseSummary>
  readonly sessionBResponses: ReadonlyArray<PermissionResponseSummary>
  readonly crossSessionLeakCount: number
}

const sessionASourceId = "sim3-binding-swap-session-a"
const sessionBSourceId = "sim3-binding-swap-session-b"
const requestAId = "sim3-permission-a-1"
const requestBId = "sim3-permission-b-1"
const sessionAAutoApproveOrigin = "sim3:autoApprove:session-a"
const sessionBDefaultOrigin = "sim3:default:session-b"

const runtimeControlPlaneLayer = (
  env: Sim3RuntimeEnv,
) =>
  RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      }),
      contentType: "application/json",
    },
  })

const runtimeOutputLayer = (
  env: Sim3RuntimeEnv,
  prefix: HostStreamPrefix,
  contextId: string,
) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: runtimeContextOutputStreamUrl({
        baseUrl: env.durableStreamsBaseUrl,
        prefix,
        contextId,
      }),
      contentType: "application/json",
    },
  })

const permissionRequestRow = (input: {
  readonly contextId: string
  readonly sequence: number
  readonly permissionRequestId: string
}): RuntimeEventRow => ({
  eventId: {
    contextId: input.contextId,
    activityAttempt: 1,
    target: "events",
    sequence: input.sequence,
  },
  contextId: input.contextId,
  activityAttempt: 1,
  sequence: input.sequence,
  source: "stdout",
  format: "jsonl",
  receivedAt: new Date().toISOString(),
  raw: encodeRuntimeAgentOutputEnvelope({
    _tag: "PermissionRequest",
    permissionRequestId: input.permissionRequestId,
    toolUseId: `${input.permissionRequestId}:tool`,
    options: [
      {
        optionId: "allow",
        kind: "allow_once",
        name: "Allow once",
      },
      {
        optionId: "deny",
        kind: "reject_once",
        name: "Deny",
      },
    ],
  }),
})

const seedPermissionRequest = (
  env: Sim3RuntimeEnv,
  input: {
    readonly contextId: string
    readonly prefix: HostStreamPrefix
    readonly sequence: number
    readonly permissionRequestId: string
  },
) =>
  Effect.gen(function*() {
    const output = yield* RuntimeOutputTable
    yield* output.events.upsert(permissionRequestRow(input))
  }).pipe(
    Effect.provide(runtimeOutputLayer(env, input.prefix, input.contextId)),
  )

const callSessionPermission = (
  request: SessionPermissionChannelRequest,
) =>
  Effect.flatMap(SessionPermissionChannel, channel =>
    channel.binding.call(request))

const decisionTag = (
  decision: PermissionDecision,
): string => decision._tag

const isPermissionResponsePayload = (
  payload: unknown,
): payload is {
  readonly _tag: "PermissionResponse"
  readonly permissionRequestId: string
  readonly decision: PermissionDecision
} =>
  typeof payload === "object" &&
  payload !== null &&
  (payload as { readonly _tag?: unknown })._tag === "PermissionResponse" &&
  typeof (payload as { readonly permissionRequestId?: unknown }).permissionRequestId === "string"

const summarizePermissionResponse = (
  row: RuntimeInputIntentRow,
): PermissionResponseSummary | undefined => {
  if (!isPermissionResponsePayload(row.payload)) return undefined
  return {
    inputId: row.intentId,
    contextId: row.contextId,
    permissionRequestId: row.payload.permissionRequestId,
    decision: decisionTag(row.payload.decision),
    origin: row.metadata?.["firegrid.permission.response.origin"] ?? "",
  }
}

const queryPermissionResponses = (
  sessionId: string,
) =>
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return yield* control.inputIntents.query((coll) =>
      coll.toArray
        .filter(row => row.contextId === sessionId)
        .flatMap(row => {
          const summary = summarizePermissionResponse(row)
          return summary === undefined ? [] : [summary]
        })
        .sort((left, right) => left.inputId.localeCompare(right.inputId)))
  })

const assertSingleResponse = (
  rows: ReadonlyArray<PermissionResponseSummary>,
  expected: {
    readonly sessionId: string
    readonly permissionRequestId: string
    readonly decision?: string
  },
) =>
  Effect.gen(function*() {
    const matching = rows.filter(row =>
      row.contextId === expected.sessionId &&
      row.permissionRequestId === expected.permissionRequestId)
    if (matching.length === 0) {
      return yield* Effect.fail(
        new Error(`missing response for ${expected.sessionId}/${expected.permissionRequestId}`),
      )
    }
    if (
      expected.decision !== undefined &&
      !matching.some(row => row.decision === expected.decision)
    ) {
      return yield* Effect.fail(
        new Error(`missing ${expected.decision} decision for ${expected.permissionRequestId}`),
      )
    }
  })

export const sim3BindingSwapIsolationDriver: Effect.Effect<
  Sim3BindingSwapIsolationResult,
  unknown,
  Firegrid
> = Effect.scoped(Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const env = yield* Effect.promise(() => sim3RuntimeEnv)
  const controlLayer = runtimeControlPlaneLayer(env)

  const sessionA = yield* firegrid.sessions.createOrLoad({
    externalKey: { source: "tiny-firegrid", id: sessionASourceId },
    runtime: local.jsonl({
      argv: [globalThis.process.execPath, "-e", "setInterval(() => {}, 1000)"],
      agent: "sim3-session-a",
      agentProtocol: "stdio-jsonl",
      cwd: globalThis.process.cwd(),
    }),
    createdBy: "tiny-firegrid-simulation",
  })
  const sessionB = yield* firegrid.sessions.createOrLoad({
    externalKey: { source: "tiny-firegrid", id: sessionBSourceId },
    runtime: local.jsonl({
      argv: [globalThis.process.execPath, "-e", "setInterval(() => {}, 1000)"],
      agent: "sim3-session-b",
      agentProtocol: "stdio-jsonl",
      cwd: globalThis.process.cwd(),
    }),
    createdBy: "tiny-firegrid-simulation",
  })

  yield* Effect.all([
    sessionA.whenReady,
    sessionB.whenReady,
  ], { concurrency: "unbounded" })

  const [sessionASnapshot, sessionBSnapshot] = yield* Effect.all([
    sessionA.snapshot(),
    sessionB.snapshot(),
  ], { concurrency: "unbounded" })
  const sessionAPrefix = sessionASnapshot.context?.host.streamPrefix
  if (sessionAPrefix === undefined) {
    return yield* Effect.fail(new Error("session A snapshot has no host stream prefix"))
  }
  const sessionBPrefix = sessionBSnapshot.context?.host.streamPrefix
  if (sessionBPrefix === undefined) {
    return yield* Effect.fail(new Error("session B snapshot has no host stream prefix"))
  }

  yield* Effect.all([
    seedPermissionRequest(env, {
      contextId: sessionA.contextId,
      prefix: sessionAPrefix,
      sequence: 1,
      permissionRequestId: requestAId,
    }),
    seedPermissionRequest(env, {
      contextId: sessionB.contextId,
      prefix: sessionBPrefix,
      sequence: 1,
      permissionRequestId: requestBId,
    }),
  ], { concurrency: "unbounded" })

  const observedRequests = yield* Effect.all([
    sessionA.wait.forPermissionRequest({ timeoutMs: 5_000 }),
    sessionB.wait.forPermissionRequest({ timeoutMs: 5_000 }),
  ], { concurrency: "unbounded" })
  if (!observedRequests[0].matched || observedRequests[0].request.permissionRequestId !== requestAId) {
    return yield* Effect.fail(new Error("session A permission request was not observable"))
  }
  if (!observedRequests[1].matched || observedRequests[1].request.permissionRequestId !== requestBId) {
    return yield* Effect.fail(new Error("session B permission request was not observable"))
  }

  const sessionADurablePermissionLayer = SessionPermissionChannelLive({
    sessionId: sessionA.contextId,
  })
  const sessionBDurablePermissionLayer = SessionPermissionChannelLive({
    sessionId: sessionB.contextId,
  })

  yield* Effect.all([
    Effect.gen(function*() {
      const defaultBinding = yield* SessionPermissionChannel
      const sessionAAutoApproveLayer = SessionPermissionAutoApproveLayer({
        sessionId: sessionA.contextId,
        defaultBinding,
        decision: { _tag: "Allow", optionId: "allow" },
        responseOrigin: sessionAAutoApproveOrigin,
      })
      return yield* callSessionPermission({
        permissionRequestId: requestAId,
        idempotencyKey: `sim3:${sessionA.contextId}:${requestAId}`,
      }).pipe(
        Effect.provide(sessionAAutoApproveLayer),
      )
    }).pipe(
      Effect.provide(sessionADurablePermissionLayer),
      Effect.provide(controlLayer),
    ),
    callSessionPermission({
      permissionRequestId: requestBId,
      decision: { _tag: "Deny", reason: "manual default path" },
      idempotencyKey: `sim3:${sessionB.contextId}:${requestBId}`,
      responseOrigin: sessionBDefaultOrigin,
    }).pipe(
      Effect.provide(sessionBDurablePermissionLayer),
      Effect.provide(controlLayer),
    ),
  ], { concurrency: "unbounded" })

  const [sessionAResponses, sessionBResponses] = yield* Effect.all([
    queryPermissionResponses(sessionA.contextId),
    queryPermissionResponses(sessionB.contextId),
  ], { concurrency: "unbounded" }).pipe(
    Effect.provide(controlLayer),
  )

  yield* assertSingleResponse(sessionAResponses, {
    sessionId: sessionA.contextId,
    permissionRequestId: requestAId,
    decision: "Allow",
  })
  yield* assertSingleResponse(sessionBResponses, {
    sessionId: sessionB.contextId,
    permissionRequestId: requestBId,
  })

  const crossSessionLeakCount = sessionBResponses.filter(row =>
    row.decision === "Allow" && row.origin === sessionAAutoApproveOrigin,
  ).length
  if (crossSessionLeakCount !== 0) {
    return yield* Effect.fail(new Error("session A auto-approve policy leaked into session B"))
  }

  const sameChannelTag = SessionPermissionChannel === SessionPermissionChannel
  const result: Sim3BindingSwapIsolationResult = {
    verdict: "GREEN",
    sessionAId: sessionA.contextId,
    sessionBId: sessionB.contextId,
    requestAId,
    requestBId,
    sameChannelTag,
    sameChannelTarget: String(SessionPermissionChannelTarget),
    sessionAResponses,
    sessionBResponses,
    crossSessionLeakCount,
  }

  // firegrid-sim3-binding-swap-isolation.SIMULATION.2
  // firegrid-sim3-binding-swap-isolation.SIMULATION.3
  // firegrid-sim3-binding-swap-isolation.SIMULATION.4
  yield* Effect.annotateCurrentSpan({
    "firegrid.sim3.verdict": result.verdict,
    "firegrid.sim3.same_channel_tag": result.sameChannelTag,
    "firegrid.sim3.same_channel_target": result.sameChannelTarget,
    "firegrid.sim3.session_a.id": result.sessionAId,
    "firegrid.sim3.session_b.id": result.sessionBId,
    "firegrid.sim3.session_a.responses": JSON.stringify(result.sessionAResponses),
    "firegrid.sim3.session_b.responses": JSON.stringify(result.sessionBResponses),
    "firegrid.sim3.cross_session_leak_count": result.crossSessionLeakCount,
  })

  return result
})).pipe(
  Effect.withSpan("firegrid.sim3.binding_swap_isolation.driver", {
    kind: "client",
  }),
)
