/* eslint-disable */
import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  FiregridRuntimeHostLive,
  type FiregridHost,
} from "@firegrid/host-sdk"
import {
  durableStreamUrl,
} from "@firegrid/protocol/launch"
import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import { DurableTable } from "effect-durable-operators"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "../../types.ts"
import {
  Clock,
  Effect,
  Exit,
  Layer,
  Option,
  Schedule,
  Schema,
  Scope,
} from "effect"

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client + substrate-barrier deterministic polling. */

// factory-vision §6: "record the result durably; the next decision might
// depend on whether the action succeeded." This sim proves that property
// ACROSS a host-generation interruption: a participant takes a real
// provider-edge `execute` action (the merged #388 Gap-2 SandboxProvider
// seam in FiregridRuntimeHostLive), the result is recorded to an app-owned
// durable evidence row, the host restarts (gen-1 -> gen-2 over the SAME
// durable-streams baseUrl+namespace, reusing the merged #381 harness), and
// the participant's NEXT decision still sees the durably-recorded prior
// action result through the PUBLIC client. No LLM (independent of the
// external Anthropic-quota blocker per #395).

const composeHost = (opts: {
  readonly baseUrl: string
  readonly namespace: string
  readonly hostId: string
  readonly localProcessEnv?: TinyFiregridSimulationEnv["localProcessEnv"]
}): Layer.Layer<FiregridHost, unknown> =>
  // TFIND-005: production host factories still return a layer whose public
  // surface is `FiregridHost` but whose inferred output channel is `any`.
   
  FiregridRuntimeHostLive({
    durableStreamsBaseUrl: opts.baseUrl,
    namespace: opts.namespace,
    hostId: opts.hostId,
    hostSessionId: `${opts.hostId}-session`,
    input: true,
    ...(opts.localProcessEnv === undefined
      ? {}
      : { localProcessEnv: opts.localProcessEnv }),
  })

const ACTION_SENTINEL = "FIREGRID_ACTION_SIDE_EFFECT_OK"
const OBSERVED_PREFIX = "FIREGRID_ACTION_OBSERVED:"
const HOST_GEN_1 = "gen1"
const HOST_GEN_2 = "gen2"

// App-owned durable evidence (the §6 "remember"). On durable-streams, so it
// is independent of any host generation.
const ActionEvidenceRowSchema = Schema.Struct({
  evidenceId: Schema.String.pipe(DurableTable.primaryKey),
  participantId: Schema.String,
  actionId: Schema.String,
  toolUseId: Schema.String,
  status: Schema.Literal("succeeded", "failed"),
  observedResult: Schema.String,
  recordedAt: Schema.String,
})
type ActionEvidenceRow = Schema.Schema.Type<typeof ActionEvidenceRowSchema>

class ActionEvidenceTable extends DurableTable("tiny.actionSurvivesRestart", {
  evidence: ActionEvidenceRowSchema,
}) {}

const evidenceTableLayer = (env: TinyFiregridSimulationEnv) =>
  ActionEvidenceTable.layer({
    streamOptions: {
      url: durableStreamUrl(
        env.durableStreamsBaseUrl,
        `${env.namespace}.actionSurvivesRestart`,
      ),
      contentType: "application/json",
    },
    txTimeoutMs: 2_000,
  })

const externalKeyId = (env: TinyFiregridSimulationEnv): string => env.runId
const contextIdFor = (env: TinyFiregridSimulationEnv): string =>
  sessionContextIdForExternalKey({
    source: "tiny-firegrid",
    id: externalKeyId(env),
  })
const evidenceIdFor = (env: TinyFiregridSimulationEnv): string =>
  `participant:${env.runId}:post-restart-evidence`

// Deterministic, agent-FREE stdio-jsonl participant. Turn-1: take a real
// provider-edge action via the #388 `execute` seam (run a process that
// writes a sentinel), then re-emit the provider stdout (received back over
// the ToolResult stdin roundtrip) so the driver observes the action result
// strictly through the PUBLIC client. No quotes inside the nested argv
// (sentinel passed via envVars). No LLM.
const participantChildCode = [
  "const C = process.execPath",
  `const SENT = ${JSON.stringify(ACTION_SENTINEL)}`,
  `const OBS = ${JSON.stringify(OBSERVED_PREFIX)}`,
  "const NL = String.fromCharCode(10)",
  "function emit(o){ process.stdout.write(JSON.stringify(o) + NL) }",
  "emit({ type:'tool_use', toolUseId:'action-1', name:'execute', input:{ sandbox:{ providerName:'demo', toolName:'post-pr-comment' }, input:{ argv:[C,'-e','process.stdout.write(process.env.FG_SENT)'], envVars:{ FG_SENT: SENT } } } })",
  "let buf=''",
  "process.stdin.on('data', d=>{ buf+=String(d); let i; while((i=buf.indexOf(NL))>=0){ const line=buf.slice(0,i); buf=buf.slice(i+1); try{ const m=JSON.parse(line); if(m && m.type==='tool_result' && m.toolUseId==='action-1'){ const c=m.content; const out=(c && typeof c==='object') ? (c.stdout||'') : String(c); emit({ type:'text', text: OBS + out }); emit({ type:'turn_complete', finishReason:'stop' }); process.exit(0) } }catch(e){} } })",
].join("\n")

const participantArgv = [
  globalThis.process.execPath,
  "-e",
  participantChildCode,
] as const

interface ActionSurvivesRestartResult {
  // gen-1: the provider-edge action ran and its result was observed
  // through the public client.
  readonly sawExecuteToolUse: boolean
  readonly sawActionResult: boolean
  // §6 "record the result durably": app-owned evidence row written.
  readonly evidenceRecordedPreRestart: boolean
  // gen-1 -> gen-2 host-generation boundary actually crossed.
  readonly runtimeRestarted: boolean
  // post-restart "next decision": the durably-recorded prior action
  // result is still observable through the public/durable surface.
  readonly evidenceSurvivedRestart: boolean
  readonly postRestartActionSucceeded: boolean
  readonly contextRecoveredPostRestart: boolean
  readonly observedResult: string
}

const RESTART_SENTINEL_INTENT_ID = "tiny-action-survives-restart:gen2-recovered"

// makeHost: gen-1 (real #388-capable FiregridRuntimeHostLive) -> durable
// barrier that waits until the participant's action result is DURABLY
// recorded (app-owned evidence row present) -> tear down gen-1 -> publish
// restart sentinel -> recover gen-2 over the SAME durable baseUrl+namespace.
// makeHost and the driver rendezvous ONLY through durable-streams.
const makeRestartingHost = (env: TinyFiregridSimulationEnv) => {
  const evidenceId = evidenceIdFor(env)

  const orchestration = Effect.gen(function*() {
    const parentScope = yield* Effect.scope

    const gen1Scope = yield* Scope.make()
    yield* Layer.buildWithScope(
      composeHost({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
        hostId: HOST_GEN_1,
        ...(env.localProcessEnv === undefined
          ? {}
          : { localProcessEnv: env.localProcessEnv }),
      }),
      gen1Scope,
    )

    // Barrier: the §6 proof requires the restart to happen AFTER the action
    // result is durably recorded. Wait for the app-owned evidence row to
    // exist, read through the same durable-streams the driver writes to.
    const barrierDeadline = (yield* Clock.currentTimeMillis) + 200_000
    const observeEvidenceRecorded = Effect.gen(function*() {
      const table = yield* ActionEvidenceTable
      const row = yield* table.evidence.get(evidenceId)
      return Option.isSome(row)
    }).pipe(
      Effect.scoped,
      Effect.provide(evidenceTableLayer(env)),
      Effect.catchAll(() => Effect.succeed(false)),
    )

    while (true) {
      if ((yield* Clock.currentTimeMillis) >= barrierDeadline) break
      if (yield* observeEvidenceRecorded) break
      yield* Clock.sleep("1000 millis")
    }

    // RESTART: tear down gen-1 entirely.
    yield* Scope.close(gen1Scope, Exit.void)

    // Publish the restart sentinel ONLY through durable-streams so the
    // driver can falsifiably observe the gen-1 -> gen-2 boundary.
    yield* Effect.gen(function*() {
      const table = yield* ActionEvidenceTable
      yield* table.evidence.insertOrGet({
        evidenceId: RESTART_SENTINEL_INTENT_ID,
        participantId: "system",
        actionId: "restart-sentinel",
        toolUseId: "restart-sentinel",
        status: "succeeded",
        observedResult: "host-generation-2 recovered",
        recordedAt: new Date(0).toISOString(),
      }).pipe(Effect.catchAll(() => Effect.void))
    }).pipe(
      Effect.scoped,
      Effect.provide(evidenceTableLayer(env)),
      Effect.catchAll(() => Effect.void),
    )

    // RECOVER: gen-2 over the SAME durable baseUrl+namespace into the
    // long-lived parent scope.
    const gen2Context = yield* Layer.buildWithScope(
      Layer.fresh(composeHost({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
        hostId: HOST_GEN_2,
        ...(env.localProcessEnv === undefined
          ? {}
          : { localProcessEnv: env.localProcessEnv }),
      })),
      parentScope,
    )

    return gen2Context
  })

  return Layer.scopedContext(orchestration)
}

const driver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<ActionSurvivesRestartResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const contextId = contextIdFor(env)
    const evidenceId = evidenceIdFor(env)
    const participantId = `participant:${env.runId}`

    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: { source: "tiny-firegrid", id: externalKeyId(env) },
      runtime: local.jsonl({
        argv: [...participantArgv],
        agent: "tiny-firegrid-deterministic-participant",
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload: "tiny-firegrid §6 action-survives-restart probe",
      idempotencyKey: `${env.runId}:turn-1`,
    }).pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.spaced("1000 millis"),
          Schedule.recurs(30),
        ),
      ),
    )
    yield* session.start()

    // (1) gen-1: observe the real provider-edge action + its result through
    // the PUBLIC client.
    const actionDeadline = (yield* Clock.currentTimeMillis) + 150_000
    let sawExecuteToolUse = false
    let observedResult = ""
    let afterSequence: number | undefined
    while (!(sawExecuteToolUse && observedResult.includes(OBSERVED_PREFIX))) {
      if ((yield* Clock.currentTimeMillis) >= actionDeadline) break
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: 15_000,
      }).pipe(
        Effect.retry(
          Schedule.intersect(
            Schedule.spaced("1000 millis"),
            Schedule.recurs(5),
          ),
        ),
      )
      if (!next.matched) continue
      afterSequence = next.output.sequence
      const event = next.output.event
      if (event._tag === "ToolUse" && event.part.name === "execute") {
        sawExecuteToolUse = true
      }
      if (event._tag === "TextChunk") observedResult += event.part.delta
    }
    const sawActionResult = observedResult.includes(
      `${OBSERVED_PREFIX}${ACTION_SENTINEL}`,
    )

    // §6 "record the result durably": the participant writes its action
    // result to app-owned durable evidence (independent of host generation).
    let evidenceRecordedPreRestart = false
    if (sawActionResult) {
      const row: ActionEvidenceRow = {
        evidenceId,
        participantId,
        actionId: `post-pr-comment:${env.runId}`,
        toolUseId: "action-1",
        status: "succeeded",
        observedResult,
        recordedAt: new Date().toISOString(),
      }
      yield* Effect.gen(function*() {
        const table = yield* ActionEvidenceTable
        yield* table.evidence.insertOrGet(row)
      }).pipe(
        Effect.scoped,
        Effect.provide(evidenceTableLayer(env)),
        Effect.catchAll(() => Effect.void),
      )
      evidenceRecordedPreRestart = true
    }

    // (2) observe the gen-1 -> gen-2 restart falsifiably via the
    // substrate-published sentinel.
    const restartDeadline = (yield* Clock.currentTimeMillis) + 200_000
    let runtimeRestarted = false
    while (!runtimeRestarted) {
      if ((yield* Clock.currentTimeMillis) >= restartDeadline) break
      const sentinel = yield* Effect.gen(function*() {
        const table = yield* ActionEvidenceTable
        return yield* table.evidence.get(RESTART_SENTINEL_INTENT_ID)
      }).pipe(
        Effect.scoped,
        Effect.provide(evidenceTableLayer(env)),
        Effect.catchAll(() => Effect.succeed(Option.none())),
      )
      if (Option.isSome(sentinel)) {
        runtimeRestarted = true
        break
      }
      yield* Clock.sleep("1000 millis")
    }

    // (3) post-restart "next decision": a FRESH read of the app-owned
    // durable evidence must still see the prior action result, and a FRESH
    // public-client snapshot must still resolve the durable context
    // recovered by gen-2.
    const postDeadline = (yield* Clock.currentTimeMillis) + 90_000
    let evidenceSurvivedRestart = false
    let postRestartActionSucceeded = false
    while (!evidenceSurvivedRestart) {
      if ((yield* Clock.currentTimeMillis) >= postDeadline) break
      const recovered = yield* Effect.gen(function*() {
        const table = yield* ActionEvidenceTable
        return yield* table.evidence.get(evidenceId)
      }).pipe(
        Effect.scoped,
        Effect.provide(evidenceTableLayer(env)),
        Effect.catchAll(() => Effect.succeed(Option.none())),
      )
      if (Option.isSome(recovered)) {
        evidenceSurvivedRestart = true
        postRestartActionSucceeded = recovered.value.status === "succeeded" &&
          recovered.value.observedResult.includes(ACTION_SENTINEL)
        break
      }
      yield* Clock.sleep("1000 millis")
    }

    const postRestartSnap = yield* firegrid.open(contextId).snapshot.pipe(
      Effect.catchAll(() => Effect.succeed(undefined)),
    )
    const contextRecoveredPostRestart = postRestartSnap?.context !== undefined

    return {
      sawExecuteToolUse,
      sawActionResult,
      evidenceRecordedPreRestart,
      runtimeRestarted,
      evidenceSurvivedRestart,
      postRestartActionSucceeded,
      contextRecoveredPostRestart,
      observedResult,
    }
  })

export const actionSurvivesRestartSimulation = {
  id: "action-survives-restart-pipeline",
  description:
    "factory-vision §6 provider-edge durability: a participant takes a real #388 execute action, its result is recorded to app-owned durable evidence, the host restarts (gen-1 -> gen-2, same durable-streams), and the participant's next decision still sees the durably-recorded prior action result through the public client. No LLM.",
  makeHost: env => makeRestartingHost(env),
  driver,
} satisfies TinyFiregridSimulation<ActionSurvivesRestartResult>

/* eslint-enable local/no-fixed-polling */
