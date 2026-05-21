import {
  Firegrid,
  local,
  type RuntimeAgentOutputObservation,
} from "@firegrid/client-sdk/firegrid"
import { Clock, Effect } from "effect"

const marker = {
  childHandoff: "CAP4_CHILD_HANDOFF_RECEIVED",
  childResume: "CAP4_CHILD_RESUME_RECEIVED",
} as const

const sessionNewToolUseId = "cap4-session-new"
const sessionPromptToolUseId = "cap4-session-prompt"

const safeContextSegment = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9_-]/g, "_")

const childContextIdForToolUse = (
  parentContextId: string,
  toolUseId: string,
): string => `ctx_${safeContextSegment(`${parentContextId}-${toolUseId}`)}`

const jsonLineProgram = (lines: ReadonlyArray<string>): string =>
  lines.join("\n")

const childProgram = jsonLineProgram([
  "#!/usr/bin/env node",
  "const NL = String.fromCharCode(10)",
  "const writeOutput = event => process.stdout.write(JSON.stringify({ type: 'firegrid.agent-output', event }) + NL)",
  "const writeText = text => writeOutput({ _tag: 'TextChunk', part: { type: 'text-delta', id: 'cap4-child', delta: text } })",
  "let turns = 0",
  "const idle = setTimeout(() => process.exit(0), 120000)",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', chunk => {",
  "  for (const line of chunk.split(NL)) {",
  "    if (line.length === 0) continue",
  "    turns += 1",
  `    if (turns === 1) writeText(${JSON.stringify(marker.childHandoff)})`,
  `    if (turns === 2) { writeText(${JSON.stringify(marker.childResume)}); writeOutput({ _tag: 'TurnComplete', finishReason: 'stop' }); clearTimeout(idle); process.exit(0) }`,
  "  }",
  "})",
])

const parentProgram = jsonLineProgram([
  "const fs = require('node:fs')",
  "const os = require('node:os')",
  "const path = require('node:path')",
  "const NL = String.fromCharCode(10)",
  "const emit = value => process.stdout.write(JSON.stringify(value) + NL)",
  `const childSource = ${JSON.stringify(childProgram)}`,
  "const childPath = path.join(os.tmpdir(), 'firegrid-cap4-child-' + process.pid + '.mjs')",
  "fs.writeFileSync(childPath, childSource, { mode: 0o755 })",
  "let buffer = ''",
  "let resumed = false",
  "const guard = setTimeout(() => process.exit(0), 150000)",
  "emit({",
  "  type: 'tool_use',",
  `  toolUseId: ${JSON.stringify(sessionNewToolUseId)},`,
  "  name: 'session_new',",
  "  input: {",
  "    agentKind: childPath,",
  "    prompt: 'capability-4 handoff: acknowledge this delegated child session',",
  "    options: { metadata: { role: 'cap4-child', correlationId: 'delegation-proof-cap4' } }",
  "  }",
  "})",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', chunk => {",
  "  buffer += chunk",
  "  for (;;) {",
  "    const boundary = buffer.indexOf(NL)",
  "    if (boundary < 0) break",
  "    const line = buffer.slice(0, boundary)",
  "    buffer = buffer.slice(boundary + 1)",
  "    let event",
  "    try { event = JSON.parse(line) } catch { continue }",
  "    if (!event || event.type !== 'tool_result') continue",
  `    if (event.toolUseId === ${JSON.stringify(sessionNewToolUseId)} && !resumed) {`,
  "      const sessionId = event.content?.session?.sessionId",
  "      if (typeof sessionId !== 'string' || sessionId.length === 0) continue",
  "      resumed = true",
  "      emit({",
  "        type: 'tool_use',",
  `        toolUseId: ${JSON.stringify(sessionPromptToolUseId)},`,
  "        name: 'session_prompt',",
  "        input: { sessionId, prompt: 'capability-4 resume: emit the resume marker' }",
  "      })",
  `    } else if (event.toolUseId === ${JSON.stringify(sessionPromptToolUseId)}) {`,
  "      emit({ type: 'turn_complete', finishReason: 'stop' })",
  "      clearTimeout(guard)",
  "      process.exit(0)",
  "    }",
  "  }",
  "})",
])

const parentArgv = [
  globalThis.process.execPath,
  "-e",
  parentProgram,
] as const

interface DelegationProofCap4Result {
  readonly parentContextId: string
  readonly childContextId: string
  readonly sawSessionNew: boolean
  readonly sawSessionPrompt: boolean
  readonly childCreatedWithParentCorrelation: boolean
  readonly observedCreatedBy: string
  readonly childHandoffObserved: boolean
  readonly childResumeObserved: boolean
  readonly childText: string
}

const fail = (message: string): Effect.Effect<never, string> =>
  Effect.fail(message)

const textFromAgentOutput = (
  output: RuntimeAgentOutputObservation,
): string =>
  output.event._tag === "TextChunk" ? output.event.part.delta : ""

const textFromAgentOutputs = (
  outputs: ReadonlyArray<RuntimeAgentOutputObservation>,
): string => outputs.map(textFromAgentOutput).join("")

const untilDeadline = <A>(
  deadlineMs: number,
  body: Effect.Effect<A | undefined, unknown, Firegrid>,
): Effect.Effect<A | undefined, unknown, Firegrid> =>
  Effect.gen(function*() {
    while ((yield* Clock.currentTimeMillis) < deadlineMs) {
      const next = yield* body
      if (next !== undefined) return next
    }
    return undefined
  })

export const delegationProofCap4Driver: Effect.Effect<
  DelegationProofCap4Result,
  unknown,
  Firegrid
> = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const externalKey = {
    source: "tiny-firegrid.delegation-proof-cap4",
    id: crypto.randomUUID(),
  }

  const parent = yield* firegrid.sessions.createOrLoad({
    externalKey,
    runtime: local.jsonl({
      argv: [...parentArgv],
      agent: "tiny-firegrid-cap4-parent",
      agentProtocol: "stdio-jsonl",
      cwd: globalThis.process.cwd(),
    }),
    createdBy: "tiny-firegrid-simulation",
  })
  const parentContextId = parent.contextId
  const childContextId = childContextIdForToolUse(
    parentContextId,
    sessionNewToolUseId,
  )
  const expectedCreatedBy = `agent-tool:${parentContextId}`

  yield* parent.prompt({
    payload: "firegrid-factory-aligned-agent-tools.SESSION.8",
    idempotencyKey: `${externalKey.id}:parent-prompt`,
  })
  yield* parent.start()

  const deadlineMs = (yield* Clock.currentTimeMillis) + 180_000
  let parentAfter: number | undefined
  let sawSessionNew = false
  let sawSessionPrompt = false

  while (!sawSessionNew || !sawSessionPrompt) {
    if ((yield* Clock.currentTimeMillis) >= deadlineMs) {
      return yield* fail("timed out waiting for parent delegation tool calls")
    }
    const next = yield* parent.wait.forAgentOutput({
      ...(parentAfter === undefined ? {} : { afterSequence: parentAfter }),
      timeoutMs: 10_000,
    })
    if (!next.matched) continue
    parentAfter = next.output.sequence
    const event = next.output.event
    if (event._tag === "ToolUse") {
      if (event.part.name === "session_new") sawSessionNew = true
      if (event.part.name === "session_prompt") sawSessionPrompt = true
      if (event.part.name === "spawn" || event.part.name === "spawn_all") {
        return yield* fail("delegation proof used forbidden spawn surface")
      }
    }
  }

  const childSnapshot = yield* untilDeadline(
    deadlineMs,
    firegrid.open(childContextId).snapshot.pipe(
      Effect.map(snapshot =>
        snapshot.context?.createdBy === expectedCreatedBy ? snapshot : undefined,
      ),
      Effect.catchAll(() => Effect.succeed(undefined)),
    ),
  )
  if (childSnapshot === undefined) {
    return yield* fail("timed out waiting for child RuntimeContext correlation")
  }

  const child = yield* firegrid.sessions.attach({ sessionId: childContextId })
  let childAfter: number | undefined
  let childText = ""

  while (!childText.includes(marker.childResume)) {
    if ((yield* Clock.currentTimeMillis) >= deadlineMs) {
      return yield* fail("timed out waiting for delegated child output")
    }
    const snapshotText = yield* firegrid.open(childContextId).snapshot.pipe(
      Effect.map(snapshot => textFromAgentOutputs(snapshot.agentOutputs)),
      Effect.catchAll(() => Effect.succeed("")),
    )
    if (snapshotText.length > childText.length) {
      childText = snapshotText
      if (childText.includes(marker.childResume)) break
    }
    const next = yield* child.wait.forAgentOutput({
      ...(childAfter === undefined ? {} : { afterSequence: childAfter }),
      timeoutMs: 1_000,
    })
    if (!next.matched) continue
    childAfter = next.output.sequence
    childText += textFromAgentOutput(next.output)
  }

  if (!childText.includes(marker.childHandoff)) {
    return yield* fail("delegated child resume output arrived without handoff output")
  }

  const result: DelegationProofCap4Result = {
    parentContextId,
    childContextId,
    sawSessionNew,
    sawSessionPrompt,
    childCreatedWithParentCorrelation: true,
    observedCreatedBy: childSnapshot.context?.createdBy ?? "",
    childHandoffObserved: childText.includes(marker.childHandoff),
    childResumeObserved: childText.includes(marker.childResume),
    childText,
  }

  yield* Effect.annotateCurrentSpan({
    "firegrid.delegation_proof_cap4.parent_context_id": result.parentContextId,
    "firegrid.delegation_proof_cap4.child_context_id": result.childContextId,
    "firegrid.delegation_proof_cap4.saw_session_new": result.sawSessionNew,
    "firegrid.delegation_proof_cap4.saw_session_prompt": result.sawSessionPrompt,
    "firegrid.delegation_proof_cap4.child_handoff_observed": result.childHandoffObserved,
    "firegrid.delegation_proof_cap4.child_resume_observed": result.childResumeObserved,
  })

  return result
}).pipe(
  Effect.withSpan("firegrid.delegation_proof_cap4.driver", {
    kind: "client",
  }),
)
