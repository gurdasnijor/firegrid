import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Clock, Effect } from "effect"

// Deterministic, keyless control-plane lifecycle probe. A stdio-jsonl parent
// agent creates a child session and drives it through the agent-tool lifecycle
// surface — session_cancel, a resume-after-cancel prompt, then session_close —
// each of which appends a durable RuntimeLifecycleRequest the host's
// control-request dispatcher claims + executes. This is the production public
// control surface for cancel/close (the client SDK has no direct cancel/close);
// it exercises the under-sampled control-request-dispatcher / runtime-control
// path (runtime-dynamics-map.md §8).

const sessionNewToolUseId = "cc-session-new"
const sessionCancelToolUseId = "cc-session-cancel"
const sessionResumeToolUseId = "cc-session-resume"
const sessionCloseToolUseId = "cc-session-close"

const safeContextSegment = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9_-]/g, "_")

const childContextIdForToolUse = (
  parentContextId: string,
  toolUseId: string,
): string => `ctx_${safeContextSegment(`${parentContextId}-${toolUseId}`)}`

const jsonLineProgram = (lines: ReadonlyArray<string>): string =>
  lines.join("\n")

// Minimal child agent: announce ready, then idle so cancel terminates a live
// process (and close releases it).
const childProgram = jsonLineProgram([
  "#!/usr/bin/env node",
  "const NL = String.fromCharCode(10)",
  "const writeOutput = event => process.stdout.write(JSON.stringify({ type: 'firegrid.agent-output', event }) + NL)",
  "writeOutput({ _tag: 'TextChunk', part: { type: 'text-delta', id: 'cc-child', delta: 'CC_CHILD_READY' } })",
  "const idle = setTimeout(() => process.exit(0), 120000)",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', () => {})",
])

// Parent agent: session_new -> session_cancel -> session_prompt (resume after
// cancel) -> session_close, each step driven off the prior tool_result so the
// turn completes deterministically.
const parentProgram = jsonLineProgram([
  "const fs = require('node:fs')",
  "const os = require('node:os')",
  "const path = require('node:path')",
  "const NL = String.fromCharCode(10)",
  "const emit = value => process.stdout.write(JSON.stringify(value) + NL)",
  `const childSource = ${JSON.stringify(childProgram)}`,
  "const childPath = path.join(os.tmpdir(), 'firegrid-cc-child-' + process.pid + '.mjs')",
  "fs.writeFileSync(childPath, childSource, { mode: 0o755 })",
  "let buffer = ''",
  "let sessionId = null",
  "const guard = setTimeout(() => process.exit(0), 150000)",
  "emit({",
  "  type: 'tool_use',",
  `  toolUseId: ${JSON.stringify(sessionNewToolUseId)},`,
  "  name: 'session_new',",
  "  input: {",
  "    agentKind: childPath,",
  "    prompt: 'control-plane cancel/close child: stay ready',",
  "    options: { metadata: { role: 'cc-child', correlationId: 'control-plane-cancel-close' } }",
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
  `    if (event.toolUseId === ${JSON.stringify(sessionNewToolUseId)}) {`,
  "      sessionId = event.content && event.content.session && event.content.session.sessionId",
  "      if (typeof sessionId !== 'string' || sessionId.length === 0) continue",
  `      emit({ type: 'tool_use', toolUseId: ${JSON.stringify(sessionCancelToolUseId)}, name: 'session_cancel', input: { sessionId, reason: 'cancel-close-probe' } })`,
  `    } else if (event.toolUseId === ${JSON.stringify(sessionCancelToolUseId)}) {`,
  `      emit({ type: 'tool_use', toolUseId: ${JSON.stringify(sessionResumeToolUseId)}, name: 'session_prompt', input: { sessionId, prompt: 'resume after cancel' } })`,
  `    } else if (event.toolUseId === ${JSON.stringify(sessionResumeToolUseId)}) {`,
  `      emit({ type: 'tool_use', toolUseId: ${JSON.stringify(sessionCloseToolUseId)}, name: 'session_close', input: { sessionId, reason: 'cancel-close-probe' } })`,
  `    } else if (event.toolUseId === ${JSON.stringify(sessionCloseToolUseId)}) {`,
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

interface ControlPlaneCancelCloseResult {
  readonly parentContextId: string
  readonly childContextId: string
  readonly sawSessionNew: boolean
  readonly sawSessionCancel: boolean
  readonly sawSessionResume: boolean
  readonly sawSessionClose: boolean
  readonly childReachedTerminal: boolean
}

const fail = (message: string): Effect.Effect<never, string> =>
  Effect.fail(message)

export const controlPlaneCancelCloseDriver: Effect.Effect<
  ControlPlaneCancelCloseResult,
  unknown,
  Firegrid
> = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const externalKey = {
    source: "tiny-firegrid.control-plane-cancel-close",
    id: crypto.randomUUID(),
  }

  const parent = yield* firegrid.sessions.createOrLoad({
    externalKey,
    runtime: local.jsonl({
      argv: [...parentArgv],
      agent: "tiny-firegrid-cancel-close-parent",
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

  yield* parent.prompt({
    payload: "control-plane cancel/close: drive child lifecycle",
    idempotencyKey: `${externalKey.id}:parent-prompt`,
  })
  yield* parent.start()

  const deadlineMs = (yield* Clock.currentTimeMillis) + 180_000
  let parentAfter: number | undefined
  let sawSessionNew = false
  let sawSessionCancel = false
  let sawSessionResume = false
  let sawSessionClose = false

  // Phase 1: observe the parent driving the lifecycle tool calls.
  while (!sawSessionCancel || !sawSessionClose) {
    if ((yield* Clock.currentTimeMillis) >= deadlineMs) {
      return yield* fail("timed out waiting for parent cancel/close tool calls")
    }
    const next = yield* parent.wait.forAgentOutput({
      ...(parentAfter === undefined ? {} : { afterSequence: parentAfter }),
      timeoutMs: 10_000,
    })
    if (!next.matched) continue
    parentAfter = next.output.sequence
    const event = next.output.event
    if (event._tag === "ToolUse") {
      switch (event.part.name) {
        case "session_new":
          sawSessionNew = true
          break
        case "session_cancel":
          sawSessionCancel = true
          break
        case "session_prompt":
          sawSessionResume = true
          break
        case "session_close":
          sawSessionClose = true
          break
      }
    }
  }

  // Phase 2: wait for the host control-request dispatcher to drive the child to
  // a terminal run, proving cancel/close were claimed + executed (not just
  // appended) — so the dispatcher/runtime-control spans are in the trace. The
  // child observation wait (bounded by the deadline) paces the loop without
  // fixed polling.
  const child = yield* firegrid.sessions.attach({ sessionId: childContextId })
  let childAfter: number | undefined
  let childReachedTerminal = false
  while (!childReachedTerminal) {
    if ((yield* Clock.currentTimeMillis) >= deadlineMs) {
      return yield* fail("timed out waiting for child lifecycle terminal run")
    }
    childReachedTerminal = yield* firegrid.open(childContextId).snapshot.pipe(
      Effect.map(snapshot =>
        snapshot.runs.some(run =>
          run.status === "exited" || run.status === "failed",
        )),
      Effect.catchAll(() => Effect.succeed(false)),
    )
    if (childReachedTerminal) break
    const next = yield* child.wait.forAgentOutput({
      ...(childAfter === undefined ? {} : { afterSequence: childAfter }),
      timeoutMs: 1_000,
    })
    if (next.matched) childAfter = next.output.sequence
  }

  if (!sawSessionNew) {
    return yield* fail("child session_new was never observed")
  }

  const result: ControlPlaneCancelCloseResult = {
    parentContextId,
    childContextId,
    sawSessionNew,
    sawSessionCancel,
    sawSessionResume,
    sawSessionClose,
    childReachedTerminal,
  }

  yield* Effect.annotateCurrentSpan({
    "firegrid.control_plane_cancel_close.parent_context_id": result.parentContextId,
    "firegrid.control_plane_cancel_close.child_context_id": result.childContextId,
    "firegrid.control_plane_cancel_close.saw_session_cancel": result.sawSessionCancel,
    "firegrid.control_plane_cancel_close.saw_session_resume": result.sawSessionResume,
    "firegrid.control_plane_cancel_close.saw_session_close": result.sawSessionClose,
    "firegrid.control_plane_cancel_close.child_reached_terminal": result.childReachedTerminal,
  })

  return result
}).pipe(
  Effect.withSpan("firegrid.control_plane_cancel_close.driver", {
    kind: "client",
  }),
)
