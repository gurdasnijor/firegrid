import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  FiregridRuntimeHostLive,
  type FiregridHost,
} from "@firegrid/host-sdk"
import {
  hostOwnedStreamUrl,
  makeHostStreamPrefix,
  RuntimeControlPlaneTable,
  runtimeControlPlaneStreamUrl,
  type HostId,
} from "@firegrid/protocol/launch"
import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import {
  CallerOwnedFactStreams,
  DurableToolsTable,
  type WaitRow,
} from "@firegrid/runtime/durable-tools"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "./types.ts"
import {
  Clock,
  Effect,
  Exit,
  Layer,
  Option,
  Schedule,
  Scope,
  Schema,
  Stream,
} from "effect"
import type { Layer as LayerType } from "effect"
import { durableStreamUrl } from "@firegrid/protocol/launch"

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client + restart barrier deterministic polling. */

const HOST_ID = "wait-restart-host"
const FACT_STREAM = "factoryWaitRestart.facts"
const FACT_EVENT_TYPE = "human.plan.approved"
const WAIT_TOOL_USE_ID = "caller-fact-wait-1"
const WAIT_RESUMED_PREFIX = "FIREGRID_CALLER_FACT_WAIT_RESUMED:"
const SENTINEL_GEN1_WAIT_ACTIVE = "tiny-wait-restart:gen1-wait-active"
const SENTINEL_GEN1_CLOSED = "tiny-wait-restart:gen1-closed"
const SENTINEL_GEN2_STARTED = "tiny-wait-restart:gen2-started"

const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  correlationId: Schema.String,
  eventType: Schema.String,
  status: Schema.String,
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

type FactRow = Schema.Schema.Type<typeof FactRowSchema>

class FactoryWaitRestartTable extends DurableTable("factoryWaitRestart", {
  facts: FactRowSchema,
}) {}

interface WaitForCallerFactRestartResult {
  readonly contextId: string
  readonly waitToolUseObserved: boolean
  readonly waitActiveBeforeRestart: boolean
  readonly gen1ClosedBeforeFact: boolean
  readonly gen2StartedBeforeFact: boolean
  readonly factAppendedAfterRestart: boolean
  readonly callerFactWaitCompletedAfterRestart: boolean
  readonly callerFactWaitCompletionOutcome: string | undefined
  readonly sameParticipantResumed: boolean
  readonly waitMatchedAfterRestart: boolean
  readonly resultText: string
  readonly activeWaitSource: string | undefined
  readonly activeWaitName: string | undefined
  readonly finding: string | undefined
}

const factTableOptions = (env: TinyFiregridSimulationEnv): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(env.durableStreamsBaseUrl, `${env.namespace}.factoryWaitRestart`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const factTableLayer = (env: TinyFiregridSimulationEnv) =>
  FactoryWaitRestartTable.layer(factTableOptions(env))

const controlPlaneTableLayer = (env: TinyFiregridSimulationEnv) =>
  RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      }),
      contentType: "application/json",
    },
  })

const durableToolsTableLayer = (env: TinyFiregridSimulationEnv) =>
  DurableToolsTable.layer({
    streamOptions: {
      url: hostOwnedStreamUrl({
        baseUrl: env.durableStreamsBaseUrl,
        prefix: makeHostStreamPrefix({
          namespace: env.namespace,
          hostId: HOST_ID as HostId,
        }),
        segment: "durableTools",
      }),
      contentType: "application/json",
    },
  })

const composeWaitRestartHost = (
  env: TinyFiregridSimulationEnv,
): LayerType.Layer<FiregridHost, unknown> => {
  const facts = factTableLayer(env)
  const callerFacts = Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(FactoryWaitRestartTable, table => ({
      streamFor: (stream: string) =>
        stream === FACT_STREAM ? table.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(facts))
  const appFacts = Layer.merge(facts, callerFacts)

  // TFIND-005: production host factories still return a layer whose public
  // surface is `FiregridHost` but whose inferred output channel is `any`.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return FiregridRuntimeHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    hostId: HOST_ID,
    hostSessionId: `${HOST_ID}-session`,
    input: true,
    ...(env.localProcessEnv === undefined
      ? {}
      : { localProcessEnv: env.localProcessEnv }),
  }).pipe(Layer.provideMerge(appFacts))
}

const publishSentinel = (
  env: TinyFiregridSimulationEnv,
  contextId: string,
  intentId: string,
  text: string,
) =>
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    yield* control.inputIntents.insertOrGet({
      intentId,
      contextId,
      kind: "message",
      authoredBy: "system",
      payload: { type: "text", text },
      createdAt: new Date(0).toISOString(),
    }).pipe(Effect.catchAll(() => Effect.void))
  }).pipe(
    Effect.scoped,
    Effect.provide(controlPlaneTableLayer(env)),
    Effect.catchAll(() => Effect.void),
  )

const activeCallerFactWait = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<Option.Option<WaitRow>, unknown> =>
  Effect.gen(function*() {
    const table = yield* DurableToolsTable
    const waits = yield* table.waits.query(coll => coll.toArray)
    return Option.fromNullable(
      waits.find(row =>
        row.status === "active" &&
        row.source._tag === "CallerFact" &&
        row.source.stream === FACT_STREAM &&
        row.trigger.some(predicate =>
          predicate.path.length === 1 &&
          predicate.path[0] === "eventType" &&
          predicate.equals === FACT_EVENT_TYPE),
      ),
    )
  }).pipe(
    Effect.scoped,
    Effect.provide(durableToolsTableLayer(env)),
  )

const callerFactWaitCompletion = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<{
  readonly wait: Option.Option<WaitRow>
  readonly outcome: string | undefined
}, unknown> =>
  Effect.gen(function*() {
    const table = yield* DurableToolsTable
    const waits = yield* table.waits.query(coll => coll.toArray)
    const completions = yield* table.completions.query(coll => coll.toArray)
    const wait = Option.fromNullable(
      waits.find(row =>
        row.waitKey.name === `tool:${WAIT_TOOL_USE_ID}` &&
        row.source._tag === "CallerFact" &&
        row.source.stream === FACT_STREAM),
    )
    const completion = Option.flatMap(wait, row =>
      Option.fromNullable(
        completions.find(completed =>
          completed.waitKey.executionId === row.waitKey.executionId &&
          completed.waitKey.name === row.waitKey.name),
      ))
    return {
      wait,
      outcome: Option.match(completion, {
        onNone: () => undefined,
        onSome: row => row.outcome,
      }),
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(durableToolsTableLayer(env)),
  )

const makeRestartingHost = (env: TinyFiregridSimulationEnv) => {
  const contextId = contextIdFor(env)
  return Layer.scopedContext(
    Effect.gen(function*() {
      const parentScope = yield* Effect.scope
      const gen1Scope = yield* Scope.make()
      yield* Layer.buildWithScope(
        composeWaitRestartHost(env),
        gen1Scope,
      )

      const waitDeadline = (yield* Clock.currentTimeMillis) + 90_000
      let activeWait = Option.none<WaitRow>()
      while (Option.isNone(activeWait)) {
        if ((yield* Clock.currentTimeMillis) >= waitDeadline) break
        activeWait = yield* activeCallerFactWait(env).pipe(
          Effect.catchAll(() => Effect.succeed(Option.none())),
        )
        if (Option.isSome(activeWait)) break
        yield* Clock.sleep("500 millis")
      }
      if (Option.isSome(activeWait)) {
        yield* publishSentinel(
          env,
          contextId,
          SENTINEL_GEN1_WAIT_ACTIVE,
          "host-generation-1 recorded an active CallerFact wait",
        )
      }

      yield* Scope.close(gen1Scope, Exit.void)
      yield* publishSentinel(
        env,
        contextId,
        SENTINEL_GEN1_CLOSED,
        "host-generation-1 closed before the matching fact existed",
      )

      const gen2Context = yield* Layer.buildWithScope(
        Layer.fresh(composeWaitRestartHost(env)),
        parentScope,
      )
      yield* publishSentinel(
        env,
        contextId,
        SENTINEL_GEN2_STARTED,
        "host-generation-2 started on the same durable streams namespace",
      )
      return gen2Context
    }),
  )
}

const deterministicParticipantSource = (runKey: string) => `
const NL = String.fromCharCode(10)
const WAIT_ID = ${JSON.stringify(WAIT_TOOL_USE_ID)}
const FACT_STREAM = ${JSON.stringify(FACT_STREAM)}
const EVENT_TYPE = ${JSON.stringify(FACT_EVENT_TYPE)}
const RESUMED = ${JSON.stringify(WAIT_RESUMED_PREFIX)}
const RUN_KEY = ${JSON.stringify(runKey)}
let buffer = ""
let emitted = false
let finished = false
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + NL)
const finish = (text) => {
  if (finished) return
  finished = true
  emit({ type: "text", text })
  emit({ type: "turn_complete", finishReason: "stop" })
}
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf(NL)) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (line.length === 0) continue
    let msg
    try { msg = JSON.parse(line) } catch (_e) { continue }
    if (msg && msg.type === "prompt" && !emitted) {
      emitted = true
      emit({ type: "status", kind: "accepted" })
      emit({
        type: "tool_use",
        toolUseId: WAIT_ID,
        name: "wait_for",
        input: {
          waitQuery: {
            source: { _tag: "CallerFact", stream: FACT_STREAM },
            whereFields: { correlationId: RUN_KEY, eventType: EVENT_TYPE }
          }
        }
      })
    } else if (msg && msg.type === "tool_result" && msg.toolUseId === WAIT_ID) {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
      finish(RESUMED + content)
    }
  }
})
`

const participantArgv = (env: TinyFiregridSimulationEnv) => [
  globalThis.process.execPath,
  "-e",
  deterministicParticipantSource(factoryRunKey(env)),
] as const

const externalKeyId = (env: TinyFiregridSimulationEnv): string => env.runId

const contextIdFor = (env: TinyFiregridSimulationEnv): string =>
  sessionContextIdForExternalKey({
    source: "tiny-firegrid.wait-restart",
    id: externalKeyId(env),
  })

const factoryRunKey = (env: TinyFiregridSimulationEnv): string =>
  `factory-run:${env.runId}`

const sentinelObserved = (
  env: TinyFiregridSimulationEnv,
  intentId: string,
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    const row = yield* control.inputIntents.get(intentId)
    return Option.isSome(row)
  }).pipe(
    Effect.scoped,
    Effect.provide(controlPlaneTableLayer(env)),
  )

const waitForSentinel = (
  env: TinyFiregridSimulationEnv,
  intentId: string,
  timeoutMs: number,
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const observed = yield* sentinelObserved(env, intentId).pipe(
        Effect.catchAll(() => Effect.succeed(false)),
      )
      if (observed) return true
      yield* Clock.sleep("500 millis")
    }
    return false
  })

const appendMatchingFact = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function*() {
    const table = yield* FactoryWaitRestartTable
    const inserted = yield* table.facts.insertOrGet({
      factId: `${env.runId}:${FACT_EVENT_TYPE}`,
      correlationId: factoryRunKey(env),
      eventType: FACT_EVENT_TYPE,
      status: "approved",
      payload: {
        approvedBy: "tiny-firegrid.simulation",
        afterRestart: true,
      },
      acceptedAt: new Date().toISOString(),
    } satisfies FactRow)
    return inserted._tag === "Inserted" || inserted._tag === "Found"
  }).pipe(
    Effect.scoped,
    Effect.provide(factTableLayer(env)),
  )

const waitForCallerFactRestartDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<WaitForCallerFactRestartResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid.wait-restart",
        id: externalKeyId(env),
      },
      runtime: local.jsonl({
        argv: [...participantArgv(env)],
        agent: "tiny-firegrid-wait-restart-fixture",
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload: "wait for the post-restart human.plan.approved fact",
      idempotencyKey: `${env.runId}:turn-1`,
    }).pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.spaced("1000 millis"),
          Schedule.recurs(60),
        ),
      ),
    )
    yield* session.start()

    let afterSequence: number | undefined
    let waitToolUseObserved = false
    let resultText = ""
    const observeUntil = (predicate: () => boolean, timeoutMs: number) =>
      Effect.gen(function*() {
        const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
        while (!predicate() && (yield* Clock.currentTimeMillis) < deadline) {
          const next = yield* session.wait.forAgentOutput({
            ...(afterSequence === undefined ? {} : { afterSequence }),
            timeoutMs: 10_000,
          }).pipe(
            Effect.retry(
              Schedule.intersect(
                Schedule.spaced("1000 millis"),
                Schedule.recurs(5),
              ),
            ),
          )
          if (!next.matched) continue
          const observation = next.output
          afterSequence = observation.sequence
          const event = observation.event
          if (event._tag === "ToolUse" && event.part.name === "wait_for") {
            waitToolUseObserved = true
          }
          if (event._tag === "TextChunk") {
            resultText += event.part.delta
          }
        }
      })

    yield* observeUntil(() => waitToolUseObserved, 90_000)
    const waitActiveBeforeRestart = yield* waitForSentinel(
      env,
      SENTINEL_GEN1_WAIT_ACTIVE,
      90_000,
    )
    const gen1ClosedBeforeFact = yield* waitForSentinel(
      env,
      SENTINEL_GEN1_CLOSED,
      90_000,
    )
    const gen2StartedBeforeFact = yield* waitForSentinel(
      env,
      SENTINEL_GEN2_STARTED,
      90_000,
    )
    const activeWait = yield* activeCallerFactWait(env).pipe(
      Effect.catchAll(() => Effect.succeed(Option.none())),
    )
    const factAppendedAfterRestart = gen2StartedBeforeFact
      ? yield* appendMatchingFact(env)
      : false

    yield* observeUntil(
      () => resultText.includes(WAIT_RESUMED_PREFIX),
      120_000,
    )

    const postFactWait = yield* callerFactWaitCompletion(env).pipe(
      Effect.catchAll(() =>
        Effect.succeed({
          wait: Option.none<WaitRow>(),
          outcome: undefined,
        })),
    )
    const callerFactWaitCompletedAfterRestart = Option.match(postFactWait.wait, {
      onNone: () => false,
      onSome: row => row.status === "completed",
    })
    const sameParticipantResumed =
      session.contextId === contextIdFor(env) &&
      resultText.includes(WAIT_RESUMED_PREFIX)
    const waitMatchedAfterRestart =
      sameParticipantResumed &&
      resultText.includes('"matched":true') &&
      resultText.includes(FACT_EVENT_TYPE)
    const finding = waitMatchedAfterRestart
      ? undefined
      : [
        "FINDING: CallerFact wait did not resume across host restart.",
        `waitToolUseObserved=${String(waitToolUseObserved)}`,
        `waitActiveBeforeRestart=${String(waitActiveBeforeRestart)}`,
        `gen1ClosedBeforeFact=${String(gen1ClosedBeforeFact)}`,
        `gen2StartedBeforeFact=${String(gen2StartedBeforeFact)}`,
        `factAppendedAfterRestart=${String(factAppendedAfterRestart)}`,
        `callerFactWaitCompletedAfterRestart=${String(callerFactWaitCompletedAfterRestart)}`,
        `callerFactWaitCompletionOutcome=${postFactWait.outcome ?? "none"}`,
        `resultText=${resultText.slice(0, 600)}`,
      ].join(" ")

    return {
      contextId: session.contextId,
      waitToolUseObserved,
      waitActiveBeforeRestart,
      gen1ClosedBeforeFact,
      gen2StartedBeforeFact,
      factAppendedAfterRestart,
      callerFactWaitCompletedAfterRestart,
      callerFactWaitCompletionOutcome: postFactWait.outcome,
      sameParticipantResumed,
      waitMatchedAfterRestart,
      resultText,
      activeWaitSource: Option.match(activeWait, {
        onNone: () => undefined,
        onSome: row => row.source._tag,
      }),
      activeWaitName: Option.match(activeWait, {
        onNone: () => undefined,
        onSome: row => row.waitKey.name,
      }),
      finding,
    }
  })

export const waitForCallerFactRestartSimulation = {
  id: "wait-for-caller-fact-restart-pipeline",
  description:
    "Durability proof for factory-vision section 6: a deterministic participant blocks on wait_for CallerFact, host generation 1 is torn down, host generation 2 starts on the same durable streams namespace, the matching app-owned fact is appended after restart, and the same participant context resumes through the public Firegrid client output.",
  makeHost: env => makeRestartingHost(env),
  driver: waitForCallerFactRestartDriver,
  summarize: result => ({
    contextId: result.contextId,
    waitToolUseObserved: result.waitToolUseObserved,
    waitActiveBeforeRestart: result.waitActiveBeforeRestart,
    gen1ClosedBeforeFact: result.gen1ClosedBeforeFact,
    gen2StartedBeforeFact: result.gen2StartedBeforeFact,
    factAppendedAfterRestart: result.factAppendedAfterRestart,
    callerFactWaitCompletedAfterRestart: result.callerFactWaitCompletedAfterRestart,
    callerFactWaitCompletionOutcome: result.callerFactWaitCompletionOutcome,
    sameParticipantResumed: result.sameParticipantResumed,
    waitMatchedAfterRestart: result.waitMatchedAfterRestart,
    activeWaitSource: result.activeWaitSource,
    activeWaitName: result.activeWaitName,
    resultTextExcerpt: result.resultText.slice(0, 800),
    finding: result.finding,
  }),
  localize: result =>
    result.waitMatchedAfterRestart
      ? [
        "CallerFact wait survived host-generation shutdown and resumed after a post-restart fact append.",
        "Inspect spans for durable_tools.wait_for.upsert_active, wait_router.complete_match, workflow deferred result, and stdio-jsonl tool_result delivery across the restart sentinels.",
      ]
      : [
        result.finding ?? "CallerFact restart wait proof did not complete.",
        "Inspect durable wait rows, CallerFact stream replay, and runtime-context resume spans.",
      ],
} satisfies TinyFiregridSimulation<WaitForCallerFactRestartResult>

/* eslint-enable local/no-fixed-polling */
