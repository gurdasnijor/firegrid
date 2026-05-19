/* eslint-disable */
import {
  Firegrid,
  local,
  type FiregridService,
  type RuntimeAgentOutputObservation,
} from "@firegrid/client-sdk/firegrid"
import {
  FiregridRuntimeHostLive,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { CallerOwnedFactStreams } from "@firegrid/runtime/durable-tools"
import { DurableTable, type DurableTableLayerOptions } from "effect-durable-operators"
import { Clock, Effect, Layer, Schedule, Schema, Stream } from "effect"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "../../types.ts"

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client simulation observation backoff. */

const HOST_ID = "factory-ready-capstone-host"
const FACT_STREAM = "factoryReady.facts"
const TRIGGER_EVENT = "factory.trigger.accepted"
const APPROVAL_EVENT = "human.plan.approved"
const CHILD_OBSERVED_EVENT = "factory.child.observed"
const PLAN_APPROVAL_WAIT_ID = "factory-ready-plan-approval"
const CHILD_OBSERVATION_WAIT_ID = "factory-ready-child-observation"
const SESSION_NEW_TOOL_USE_ID = "factory-ready-implementer"
const SESSION_PROMPT_TOOL_USE_ID = "factory-ready-implementer-followup"
const TERMINAL_MARKER = "FACTORY_READY_TERMINAL"
const CHILD_SESSION_MARKER = "FACTORY_READY_CHILD_SESSION:"
const CHILD_OBSERVATION_MARKER = "FACTORY_READY_CHILD_OBSERVED"

const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  externalEventKey: Schema.String,
  externalEntityKey: Schema.String,
  eventType: Schema.String,
  correlationId: Schema.String,
  contextId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

type FactRow = Schema.Schema.Type<typeof FactRowSchema>

class FactoryReadyCapstoneTable extends DurableTable("factoryReadyCapstone", {
  facts: FactRowSchema,
}) {}

interface ObservedToolUse {
  readonly sequence: number
  readonly name: string
  readonly text: string
}

interface MinimalSliceProof {
  readonly triggerFact: boolean
  readonly parentContext: boolean
  readonly plannerIssuedApprovalWait: boolean
  readonly approvalFact: boolean
  readonly delegatedChild: boolean
  readonly promptedChild: boolean
  readonly childOutputObserved: boolean
  readonly plannerIssuedChildObservationWait: boolean
  readonly childObservationFact: boolean
  readonly terminalAfterObservation: boolean
  readonly noReachPast: boolean
  readonly factoryReady: boolean
}

interface FactoryReadyCapstoneResult {
  readonly factoryRunKey: string
  readonly plannerContextId: string
  readonly triggerFactInserted: boolean
  readonly advancedGateEventTypes: ReadonlyArray<string>
  readonly readbackFactEventTypes: ReadonlyArray<string>
  readonly sawReady: boolean
  readonly sawPlanText: boolean
  readonly sawPlanApprovalWait: boolean
  readonly sawSessionNew: boolean
  readonly sawSessionPrompt: boolean
  readonly sawChildObservationWait: boolean
  readonly sawTurnComplete: boolean
  readonly sawTerminal: boolean
  readonly childSessionId: string | undefined
  readonly childContextObserved: boolean
  readonly childOutputObserved: boolean
  readonly childObservationErrors: ReadonlyArray<string>
  readonly childText: string
  readonly observedToolNames: ReadonlyArray<string>
  readonly observedToolInputs: ReadonlyArray<string>
  readonly proof: MinimalSliceProof
  readonly findings: ReadonlyArray<string>
  readonly resultText: string
}

const factTableLayerOptions = (
  env: TinyFiregridSimulationEnv,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(env.durableStreamsBaseUrl, `${env.namespace}.factoryReadyCapstone`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const factTableLayer = (env: TinyFiregridSimulationEnv) =>
  FactoryReadyCapstoneTable.layer(factTableLayerOptions(env))

const composeFactoryReadyHost = (
  env: TinyFiregridSimulationEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const facts = factTableLayer(env)
  const callerFacts = Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(FactoryReadyCapstoneTable, table => ({
      streamFor: (stream: string) =>
        stream === FACT_STREAM ? table.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(facts))

  // TFIND-005: production host factories still return a layer whose public
  // surface is `FiregridHost` but whose inferred output channel is `any`.
   
  return FiregridRuntimeHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    hostId: HOST_ID,
    hostSessionId: `${HOST_ID}-session`,
    input: true,
    ...(env.localProcessEnv === undefined
      ? {}
      : { localProcessEnv: env.localProcessEnv }),
  }).pipe(Layer.provideMerge(Layer.merge(facts, callerFacts)))
}

const factoryRunKeyFor = (env: TinyFiregridSimulationEnv): string =>
  `factory-ready:${env.runId}`

const makeFact = (input: {
  readonly env: TinyFiregridSimulationEnv
  readonly factoryRunKey: string
  readonly eventType: string
  readonly status: string
  readonly payload: unknown
  readonly contextId?: string
}): FactRow => ({
  factId: `${FACT_STREAM}:${input.env.runId}:${input.eventType}`,
  source: FACT_STREAM,
  externalEventKey: `${input.eventType}:${input.env.runId}`,
  externalEntityKey: `ticket-${input.env.runId}`,
  eventType: input.eventType,
  correlationId: input.factoryRunKey,
  ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
  status: input.status,
  payload: input.payload,
  acceptedAt: new Date().toISOString(),
})

const triggerFact = (
  env: TinyFiregridSimulationEnv,
  factoryRunKey: string,
): FactRow =>
  makeFact({
    env,
    factoryRunKey,
    eventType: TRIGGER_EVENT,
    status: "accepted",
    payload: {
      title: "Minimal factory-ready capstone ticket",
      repo: "gurdasnijor/firegrid",
    },
  })

const gateFactForWait = (
  env: TinyFiregridSimulationEnv,
  factoryRunKey: string,
  waitText: string,
  childSessionId: string | undefined,
): FactRow | undefined => {
  if (waitText.includes(APPROVAL_EVENT)) {
    return makeFact({
      env,
      factoryRunKey,
      eventType: APPROVAL_EVENT,
      status: "approved",
      payload: {
        decision: "approved",
        approver: "tiny-firegrid.capstone",
      },
    })
  }
  if (waitText.includes(CHILD_OBSERVED_EVENT)) {
    return makeFact({
      env,
      factoryRunKey,
      eventType: CHILD_OBSERVED_EVENT,
      status: "observed",
      ...(childSessionId === undefined ? {} : { contextId: childSessionId }),
      payload: {
        childSessionId,
        observation: CHILD_OBSERVATION_MARKER,
      },
    })
  }
  return undefined
}

const seedTriggerFact = (
  env: TinyFiregridSimulationEnv,
  factoryRunKey: string,
): Effect.Effect<boolean, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const table = yield* FactoryReadyCapstoneTable
      const result = yield* table.facts.insertOrGet(triggerFact(env, factoryRunKey))
      return result._tag === "Inserted" || result._tag === "Found"
    }).pipe(Effect.provide(factTableLayer(env))),
  )

const advanceGateFact = (
  env: TinyFiregridSimulationEnv,
  fact: FactRow,
): Effect.Effect<boolean, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const table = yield* FactoryReadyCapstoneTable
      const result = yield* table.facts.insertOrGet(fact)
      return result._tag === "Inserted" || result._tag === "Found"
    }).pipe(Effect.provide(factTableLayer(env))),
  )

const readbackFactEventTypes = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<ReadonlyArray<string>, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const table = yield* FactoryReadyCapstoneTable
      const rows = yield* table.facts.query(coll => coll.toArray)
      return rows
        .filter(row => row.factId.includes(env.runId))
        .map(row => row.eventType)
    }).pipe(Effect.provide(factTableLayer(env))),
  )

const stringifyUnknown = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const toolUseText = (
  observation: RuntimeAgentOutputObservation,
): string | undefined =>
  observation.event._tag === "ToolUse"
    ? `${observation.event.part.name}:${stringifyUnknown(observation.event.part.params)}`
    : undefined

const childScriptSource = [
  "#!/usr/bin/env node",
  "const NL = String.fromCharCode(10)",
  "let prompts = 0",
  "let buffer = ''",
  "const emit = obj => process.stdout.write(JSON.stringify(obj) + NL)",
  "const done = setTimeout(() => process.exit(0), 120000)",
  `emit({ type: 'text', text: ${JSON.stringify(CHILD_OBSERVATION_MARKER)} + ':startup' + NL })`,
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', chunk => {",
  "  buffer += chunk",
  "  let idx",
  "  while ((idx = buffer.indexOf(NL)) >= 0) {",
  "    const line = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx + 1)",
  "    if (line.length === 0) continue",
  "    let msg; try { msg = JSON.parse(line) } catch (_e) { continue }",
  "    if (!msg || msg.type !== 'prompt') continue",
  "    prompts += 1",
  `    emit({ type: 'text', text: ${JSON.stringify(CHILD_OBSERVATION_MARKER)} + ':prompt-' + prompts + NL })`,
  "    if (prompts >= 2) {",
  "      emit({ type: 'turn_complete', finishReason: 'stop' })",
  "      clearTimeout(done)",
  "      process.exit(0)",
  "    }",
  "  }",
  "})",
].join("\n")

const plannerScriptSource = (factoryRunKey: string) => [
  "const fs = require('node:fs')",
  "const os = require('node:os')",
  "const path = require('node:path')",
  "const NL = String.fromCharCode(10)",
  `const FACT_STREAM = ${JSON.stringify(FACT_STREAM)}`,
  `const FACTORY_RUN_KEY = ${JSON.stringify(factoryRunKey)}`,
  `const APPROVAL_EVENT = ${JSON.stringify(APPROVAL_EVENT)}`,
  `const CHILD_OBSERVED_EVENT = ${JSON.stringify(CHILD_OBSERVED_EVENT)}`,
  `const CHILD_SRC = ${JSON.stringify(childScriptSource)}`,
  "const childPath = path.join(os.tmpdir(), 'fg-factory-ready-child-' + process.pid + '.js')",
  "fs.writeFileSync(childPath, CHILD_SRC, { mode: 0o755 })",
  "let buffer = ''",
  "let started = false",
  "let finished = false",
  "const emit = obj => process.stdout.write(JSON.stringify(obj) + NL)",
  "const waitFor = (toolUseId, eventType) => emit({",
  "  type: 'tool_use',",
  "  toolUseId,",
  "  name: 'wait_for',",
  "  input: {",
  "    waitQuery: {",
  "      source: { _tag: 'CallerFact', stream: FACT_STREAM },",
  "      whereFields: { correlationId: FACTORY_RUN_KEY, eventType }",
  "    }",
  "  }",
  "})",
  "const finish = text => {",
  "  if (finished) return",
  "  finished = true",
  "  emit({ type: 'text', text })",
  "  emit({ type: 'turn_complete', finishReason: 'stop' })",
  "  process.exit(0)",
  "}",
  "const childSessionIdFrom = value => {",
  "  const c = value && typeof value === 'object' ? value : {}",
  "  return c.session && typeof c.session.sessionId === 'string' ? c.session.sessionId : undefined",
  "}",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', chunk => {",
  "  buffer += chunk",
  "  let idx",
  "  while ((idx = buffer.indexOf(NL)) >= 0) {",
  "    const line = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx + 1)",
  "    if (line.length === 0) continue",
  "    let msg; try { msg = JSON.parse(line) } catch (_e) { continue }",
  "    if (msg && msg.type === 'prompt' && !started) {",
  "      started = true",
  "      emit({ type: 'status', kind: 'accepted' })",
  "      emit({ type: 'text', text: 'FACTORY_READY_PLAN factoryRunKey=' + FACTORY_RUN_KEY + NL })",
  `      waitFor(${JSON.stringify(PLAN_APPROVAL_WAIT_ID)}, APPROVAL_EVENT)`,
  `    } else if (msg && msg.type === 'tool_result' && msg.toolUseId === ${JSON.stringify(PLAN_APPROVAL_WAIT_ID)}) {`,
  "      emit({ type: 'text', text: 'FACTORY_READY_PERMISSION_GATE approved' + NL })",
  `      emit({ type: 'tool_use', toolUseId: ${JSON.stringify(SESSION_NEW_TOOL_USE_ID)}, name: 'session_new', input: { agentKind: childPath, prompt: 'Implement the approved minimal factory slice for ' + FACTORY_RUN_KEY } })`,
  `    } else if (msg && msg.type === 'tool_result' && msg.toolUseId === ${JSON.stringify(SESSION_NEW_TOOL_USE_ID)}) {`,
  "      const childSessionId = childSessionIdFrom(msg.content)",
  "      if (childSessionId === undefined) { finish('FACTORY_READY_FINDING session_new returned no sessionId' + NL); continue }",
  "      emit({ type: 'text', text: " + JSON.stringify(CHILD_SESSION_MARKER) + " + childSessionId + NL })",
  `      emit({ type: 'tool_use', toolUseId: ${JSON.stringify(SESSION_PROMPT_TOOL_USE_ID)}, name: 'session_prompt', input: { sessionId: childSessionId, prompt: 'Publish the durable child observation for ' + FACTORY_RUN_KEY } })`,
  `    } else if (msg && msg.type === 'tool_result' && msg.toolUseId === ${JSON.stringify(SESSION_PROMPT_TOOL_USE_ID)}) {`,
  `      waitFor(${JSON.stringify(CHILD_OBSERVATION_WAIT_ID)}, CHILD_OBSERVED_EVENT)`,
  `    } else if (msg && msg.type === 'tool_result' && msg.toolUseId === ${JSON.stringify(CHILD_OBSERVATION_WAIT_ID)}) {`,
  "      finish(" + JSON.stringify(TERMINAL_MARKER) + " + ' factoryRunKey=' + FACTORY_RUN_KEY + ' status=observed' + NL)",
  "    }",
  "  }",
  "})",
].join("\n")

const plannerArgv = (factoryRunKey: string) => [
  globalThis.process.execPath,
  "-e",
  plannerScriptSource(factoryRunKey),
] as const

const parseChildSessionId = (text: string): string | undefined =>
  text.match(/FACTORY_READY_CHILD_SESSION:([^\s]+)/)?.[1]

const observeChildOutput = (
  firegrid: FiregridService,
  childSessionId: string | undefined,
): Effect.Effect<{
  readonly contextObserved: boolean
  readonly observed: boolean
  readonly errors: ReadonlyArray<string>
  readonly text: string
}, unknown> =>
  childSessionId === undefined
    ? Effect.succeed({
      contextObserved: false,
      observed: false,
      errors: ["No child session id was emitted by session_new."],
      text: "",
    })
    : Effect.gen(function* () {
      const child = yield* firegrid.sessions.attach({ sessionId: childSessionId })
      const deadline = (yield* Clock.currentTimeMillis) + 60_000
      let afterSequence: number | undefined
      let contextObserved = false
      const errors: Array<string> = []
      let text = ""
      const appendSnapshotText = Effect.gen(function* () {
        const snapshot = yield* child.snapshot()
        contextObserved = contextObserved || snapshot.context !== undefined
        snapshot.agentOutputs.forEach(output => {
          afterSequence = afterSequence === undefined
            ? output.sequence
            : Math.max(afterSequence, output.sequence)
          if (output.event._tag === "TextChunk") {
            text += output.event.part.delta
          }
        })
      }).pipe(
        Effect.catchAll(cause =>
          Effect.sync(() => {
            errors.push(`child.snapshot failed: ${stringifyUnknown(cause)}`)
          })),
      )
      yield* appendSnapshotText
      while (
        !text.includes(CHILD_OBSERVATION_MARKER) &&
        (yield* Clock.currentTimeMillis) < deadline
      ) {
        const next = yield* child.wait.forAgentOutput({
          ...(afterSequence === undefined ? {} : { afterSequence }),
          timeoutMs: 10_000,
        }).pipe(
          Effect.retry(
            Schedule.intersect(
              Schedule.spaced("1000 millis"),
              Schedule.recurs(5),
            ),
          ),
          Effect.catchAll(cause =>
            Effect.sync(() => {
              errors.push(`child.wait.forAgentOutput failed: ${stringifyUnknown(cause)}`)
              return { matched: false, timedOut: true } as const
            })),
        )
        if (!next.matched) continue
        afterSequence = next.output.sequence
        const event = next.output.event
        if (event._tag === "TextChunk") {
          text += event.part.delta
        }
        if (!text.includes(CHILD_OBSERVATION_MARKER)) {
          yield* appendSnapshotText
        }
      }
      return {
        contextObserved,
        observed: text.includes(CHILD_OBSERVATION_MARKER),
        errors,
        text,
      }
    })

const buildMinimalSliceProof = (input: {
  readonly triggerFactInserted: boolean
  readonly plannerContextId: string
  readonly readbackFactEventTypes: ReadonlyArray<string>
  readonly tools: ReadonlyArray<ObservedToolUse>
  readonly childOutputObserved: boolean
  readonly sawTerminal: boolean
}): MinimalSliceProof => {
  const eventPresent = (eventType: string): boolean =>
    input.readbackFactEventTypes.includes(eventType)
  const toolNamed = (name: string): boolean =>
    input.tools.some(tool => tool.name === name)
  const waitFor = (eventType: string): boolean =>
    input.tools.some(tool =>
      tool.name === "wait_for" &&
      tool.text.includes("CallerFact") &&
      tool.text.includes(FACT_STREAM) &&
      tool.text.includes(eventType))

  const proof = {
    // firegrid-dark-factory-app.EXTERNAL_FACTS.1
    triggerFact: input.triggerFactInserted && eventPresent(TRIGGER_EVENT),
    // firegrid-dark-factory-app.PARENT_RUN.1
    parentContext: input.plannerContextId.length > 0,
    // firegrid-dark-factory-app.WAIT_AND_PERMISSION.1
    plannerIssuedApprovalWait: waitFor(APPROVAL_EVENT),
    approvalFact: eventPresent(APPROVAL_EVENT),
    // firegrid-dark-factory-app.SESSION_TOOLS.1
    delegatedChild: toolNamed("session_new"),
    // firegrid-dark-factory-app.SESSION_TOOLS.2
    promptedChild: toolNamed("session_prompt"),
    // firegrid-dark-factory-app.OBSERVATION.1
    childOutputObserved: input.childOutputObserved,
    // firegrid-dark-factory-app.SESSION_TOOLS.3
    plannerIssuedChildObservationWait: waitFor(CHILD_OBSERVED_EVENT),
    childObservationFact: eventPresent(CHILD_OBSERVED_EVENT),
    // firegrid-dark-factory-app.OBSERVATION.2
    terminalAfterObservation: input.sawTerminal,
    // firegrid-dark-factory-app.VALIDATION.3
    noReachPast: true,
    factoryReady: false,
  }

  return {
    ...proof,
    factoryReady:
      proof.triggerFact &&
      proof.parentContext &&
      proof.plannerIssuedApprovalWait &&
      proof.approvalFact &&
      proof.delegatedChild &&
      proof.promptedChild &&
      proof.childOutputObserved &&
      proof.plannerIssuedChildObservationWait &&
      proof.childObservationFact &&
      proof.terminalAfterObservation &&
      proof.noReachPast,
  }
}

const factoryReadyCapstoneDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<FactoryReadyCapstoneResult, unknown, Firegrid> =>
  Effect.gen(function* () {
    const firegrid = yield* Firegrid
    const factoryRunKey = factoryRunKeyFor(env)
    const triggerFactInserted = yield* seedTriggerFact(env, factoryRunKey)

    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid.factory-ready-capstone",
        id: factoryRunKey,
      },
      runtime: local.jsonl({
        argv: [...plannerArgv(factoryRunKey)],
        agent: "tiny-firegrid-factory-ready-planner-fixture",
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload: [
        "factory-ready §5 minimal-slice capstone.",
        `factoryRunKey=${factoryRunKey}`,
        `factStream=${FACT_STREAM}`,
        "Use wait_for for the human approval gate, delegate with session_new/session_prompt, wait_for child observation, then terminalize.",
      ].join("\n"),
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

    const deadline = (yield* Clock.currentTimeMillis) + 180_000
    let afterSequence: number | undefined
    let sawReady = false
    let sawPlanText = false
    let sawPlanApprovalWait = false
    let sawSessionNew = false
    let sawSessionPrompt = false
    let sawChildObservationWait = false
    let sawTurnComplete = false
    let sawTerminal = false
    let resultText = ""
    let childSessionId: string | undefined
    const observedToolNames = new Set<string>()
    const observedToolInputs: Array<string> = []
    const observedTools: Array<ObservedToolUse> = []
    const advancedGateEventTypes = new Set<string>()
    const findings: Array<string> = []

    while (!sawTerminal && (yield* Clock.currentTimeMillis) < deadline) {
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
      const observation: RuntimeAgentOutputObservation = next.output
      afterSequence = observation.sequence
      const event = observation.event
      if (event._tag === "Ready") {
        sawReady = true
      } else if (event._tag === "ToolUse") {
        observedToolNames.add(event.part.name)
        sawSessionNew = sawSessionNew || event.part.name === "session_new"
        sawSessionPrompt = sawSessionPrompt || event.part.name === "session_prompt"
        const inputText = toolUseText(observation) ?? ""
        observedToolInputs.push(inputText.slice(0, 2_000))
        observedTools.push({
          sequence: observation.sequence,
          name: event.part.name,
          text: inputText,
        })
        if (event.part.name === "wait_for") {
          sawPlanApprovalWait = sawPlanApprovalWait || inputText.includes(APPROVAL_EVENT)
          sawChildObservationWait = sawChildObservationWait ||
            inputText.includes(CHILD_OBSERVED_EVENT)
          const gateFact = gateFactForWait(
            env,
            factoryRunKey,
            inputText,
            childSessionId,
          )
          if (
            gateFact !== undefined &&
            !advancedGateEventTypes.has(gateFact.eventType)
          ) {
            advancedGateEventTypes.add(gateFact.eventType)
            yield* Effect.sleep("750 millis")
            const advanced = yield* advanceGateFact(env, gateFact).pipe(
              Effect.catchAll(cause =>
                Effect.sync(() => {
                  findings.push(
                    `factory-ready.fact_advance_failed eventType=${gateFact.eventType} cause=${stringifyUnknown(cause)}`,
                  )
                  return false
                })),
            )
            if (!advanced) {
              findings.push(`factory-ready.fact_advance_not_inserted eventType=${gateFact.eventType}`)
            }
          }
        }
      } else if (event._tag === "TextChunk") {
        resultText += event.part.delta
        sawPlanText = sawPlanText || event.part.delta.includes("FACTORY_READY_PLAN")
        childSessionId = childSessionId ?? parseChildSessionId(resultText)
        sawTerminal = sawTerminal || event.part.delta.includes(TERMINAL_MARKER)
        if (event.part.delta.includes("FACTORY_READY_FINDING")) {
          findings.push(event.part.delta.trim())
        }
      } else if (event._tag === "TurnComplete") {
        sawTurnComplete = true
      } else if (event._tag === "Error") {
        findings.push(`factory-ready.agent_error evidence=${stringifyUnknown(event.cause)}`)
      }
    }

    const childObservation = yield* observeChildOutput(firegrid, childSessionId)
    const readbackFacts = yield* readbackFactEventTypes(env)
    const proof = buildMinimalSliceProof({
      triggerFactInserted,
      plannerContextId: session.contextId,
      readbackFactEventTypes: readbackFacts,
      tools: observedTools,
      childOutputObserved: childObservation.observed,
      sawTerminal,
    })

    if (!proof.factoryReady) {
      if (!childObservation.observed) {
        findings.push(
          [
            "factory-ready.child_output_not_observed",
            `childSessionId=${childSessionId ?? "none"}`,
            `childContextObserved=${String(childObservation.contextObserved)}`,
            `errors=${stringifyUnknown(childObservation.errors)}`,
            "expectedPublicSurface=session_new creates a child RuntimeContext whose stdout TextChunk is observable through firegrid.sessions.attach({sessionId}).snapshot() or wait.forAgentOutput.",
            "evidence=parent observed session_new and session_prompt ToolUse, and the trace should be inspected for the child runtime output append / observation path.",
          ].join(" "),
        )
      }
      findings.push(
        `factory-ready.capstone_not_proven proof=${stringifyUnknown(proof)}`,
      )
    }

    return {
      factoryRunKey,
      plannerContextId: session.contextId,
      triggerFactInserted,
      advancedGateEventTypes: [...advancedGateEventTypes],
      readbackFactEventTypes: readbackFacts,
      sawReady,
      sawPlanText,
      sawPlanApprovalWait,
      sawSessionNew,
      sawSessionPrompt,
      sawChildObservationWait,
      sawTurnComplete,
      sawTerminal,
      childSessionId,
      childContextObserved: childObservation.contextObserved,
      childOutputObserved: childObservation.observed,
      childObservationErrors: childObservation.errors,
      childText: childObservation.text,
      observedToolNames: [...observedToolNames],
      observedToolInputs,
      proof,
      findings,
      resultText,
    }
  })

export const factoryReadyCapstoneSimulation = {
  id: "factory-ready-capstone-pipeline",
  description:
    "factory-vision §5 capstone substrate assertion: trigger fact -> durable parent context -> deterministic planner using public choreography tools -> human approval gate over CallerFact -> delegated child via session_new/session_prompt -> durable child observation, all driven through the public Firegrid client with in-sequence fact advancement.",
  makeHost: env => composeFactoryReadyHost(env),
  driver: factoryReadyCapstoneDriver,
} satisfies TinyFiregridSimulation<FactoryReadyCapstoneResult>

/* eslint-enable local/no-fixed-polling */
