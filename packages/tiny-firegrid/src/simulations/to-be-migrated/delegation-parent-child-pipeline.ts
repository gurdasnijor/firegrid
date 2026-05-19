/* eslint-disable */
import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  FiregridRuntimeHostLive,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "../../types.ts"
import { Clock, Effect, Schedule } from "effect"
import type { Layer } from "effect"

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client simulation retry backoff. */

// Self-contained host compose. This simulation deliberately does NOT import
// packages/tiny-firegrid/src/configurations/ (slated for deletion; sims own
// their host compose).
const composeDelegationHost = (
  env: TinyFiregridSimulationEnv,
): Layer.Layer<FiregridHost, unknown> =>
  // TFIND-005: production host factories still return a layer whose public
  // surface is `FiregridHost` but whose inferred output channel is `any`.
   
  FiregridRuntimeHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    hostId: "host-a",
    hostSessionId: "host-a-session",
    input: true,
    ...(env.localProcessEnv === undefined
      ? {}
      : { localProcessEnv: env.localProcessEnv }),
  })

const CHILD_DONE = "FIREGRID_CHILD_DONE"
const CHILD_RESUMED = "FIREGRID_CHILD_RESUMED"
const SESSION_NEW_TOOL_USE_ID = "child-1"

// factory-vision §7.4 — delegation is session_new + session_prompt ONLY.
// spawn / spawn_all are excluded from the toolkit (finding tf-mn2); the
// deterministic parent participant below never emits them.
const FORBIDDEN_TOOLS = ["spawn", "spawn_all"] as const

// Deterministic, agent-FREE stdio-jsonl child participant. `session_new`
// builds the child argv as `[agentKind]` (a single executable, no args),
// so the parent writes this child as an executable script and passes its
// path as `agentKind`. The child proves the delegated handoff reached it
// from the inside: it emits CHILD_DONE on the first delegated prompt
// (session_new handoff) and CHILD_RESUMED on the second (session_prompt
// resume), then completes.
const childScriptSource = [
  "#!/usr/bin/env node",
  "const NL = String.fromCharCode(10)",
  "function emit(o){ process.stdout.write(JSON.stringify(o) + NL) }",
  "let prompts = 0",
  "let buf = ''",
  "const done = setTimeout(() => process.exit(0), 120000)",
  "process.stdin.on('data', d => {",
  "  buf += String(d)",
  "  let i",
  "  while ((i = buf.indexOf(NL)) >= 0) {",
  "    const line = buf.slice(0, i); buf = buf.slice(i + 1)",
  "    let m; try { m = JSON.parse(line) } catch (e) { continue }",
  "    if (!m || m.type !== 'prompt') continue",
  "    prompts += 1",
  `    if (prompts === 1) { emit({ type: 'text', text: ${JSON.stringify(CHILD_DONE)} + ':turn' + prompts }) }`,
  `    else { emit({ type: 'text', text: ${JSON.stringify(CHILD_RESUMED)} + ':turn' + prompts }); emit({ type: 'turn_complete', finishReason: 'stop' }); clearTimeout(done); process.exit(0) }`,
  "  }",
  "})",
].join("\n")

// Deterministic, agent-FREE stdio-jsonl PARENT participant. It writes the
// child executable, then performs the §7.4 delegation move purely through
// the public agent-tool surface: `session_new` (create child + initial
// handoff prompt with parent correlation) then `session_prompt` (resume
// the child from the inside using the returned handle).
const parentScriptSource = [
  "const fs = require('node:fs')",
  "const os = require('node:os')",
  "const path = require('node:path')",
  "const NL = String.fromCharCode(10)",
  "function emit(o){ process.stdout.write(JSON.stringify(o) + NL) }",
  `const childSrc = ${JSON.stringify(childScriptSource)}`,
  "const childPath = path.join(os.tmpdir(), 'fg-deleg-child-' + process.pid + '.mjs')",
  "fs.writeFileSync(childPath, childSrc, { mode: 0o755 })",
  "emit({ type: 'tool_use', toolUseId: " + JSON.stringify(SESSION_NEW_TOOL_USE_ID) +
    ", name: 'session_new', input: { agentKind: childPath, prompt: 'Delegated handoff: produce the child result.' } })",
  "let buf = ''",
  "let promptedChild = false",
  "const guard = setTimeout(() => process.exit(0), 150000)",
  "process.stdin.on('data', d => {",
  "  buf += String(d)",
  "  let i",
  "  while ((i = buf.indexOf(NL)) >= 0) {",
  "    const line = buf.slice(0, i); buf = buf.slice(i + 1)",
  "    let m; try { m = JSON.parse(line) } catch (e) { continue }",
  "    if (!m || m.type !== 'tool_result') continue",
  `    if (m.toolUseId === ${JSON.stringify(SESSION_NEW_TOOL_USE_ID)} && !promptedChild) {`,
  "      promptedChild = true",
  "      const c = m.content || {}",
  "      const childId = c && c.session && c.session.sessionId",
  "      if (typeof childId === 'string' && childId.length > 0) {",
  "        emit({ type: 'tool_use', toolUseId: 'prompt-1', name: 'session_prompt', input: { sessionId: childId, prompt: 'Resume: finalize the delegated child result.' } })",
  "      }",
  "    } else if (m.toolUseId === 'prompt-1') {",
  "      emit({ type: 'turn_complete', finishReason: 'stop' })",
  "      clearTimeout(guard)",
  "      process.exit(0)",
  "    }",
  "  }",
  "})",
].join("\n")

const parentArgv = [
  globalThis.process.execPath,
  "-e",
  parentScriptSource,
] as const

const childContextIdForToolUse = (
  parentContextId: string,
  toolUseId: string,
): string => {
  const segment = `${parentContextId}-${toolUseId}`.replaceAll(
    /[^A-Za-z0-9_-]/g,
    "_",
  )
  return `ctx_${segment}`
}

interface DelegationSimulationResult {
  readonly parentContextId: string
  readonly childContextId: string
  readonly sawSessionNew: boolean
  readonly sawSessionPrompt: boolean
  readonly sawForbiddenSpawnTool: boolean
  readonly childCreatedWithParentCorrelation: boolean
  readonly observedCreatedBy: string
  readonly childResultObserved: boolean
  readonly childResumeObserved: boolean
  readonly childText: string
}

const delegationDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<DelegationSimulationResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const parentContextId = sessionContextIdForExternalKey({
      source: "tiny-firegrid",
      id: env.runId,
    })
    const childContextId = childContextIdForToolUse(
      parentContextId,
      SESSION_NEW_TOOL_USE_ID,
    )
    const expectedCreatedBy = `agent-tool:${parentContextId}`

    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: { source: "tiny-firegrid", id: env.runId },
      runtime: local.jsonl({
        argv: [...parentArgv],
        agent: "tiny-firegrid-deterministic-parent",
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload: "tiny-firegrid delegation parent-child probe",
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

    const deadline = (yield* Clock.currentTimeMillis) + 220_000

    // (1) Observe the parent's delegation moves through the PUBLIC client.
    let sawSessionNew = false
    let sawSessionPrompt = false
    let sawForbiddenSpawnTool = false
    let parentSeq: number | undefined
    while (!(sawSessionNew && sawSessionPrompt)) {
      if ((yield* Clock.currentTimeMillis) >= deadline) break
      const next = yield* session.wait.forAgentOutput({
        ...(parentSeq === undefined ? {} : { afterSequence: parentSeq }),
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
      parentSeq = next.output.sequence
      const event = next.output.event
      if (event._tag === "ToolUse") {
        if (event.part.name === "session_new") sawSessionNew = true
        if (event.part.name === "session_prompt") sawSessionPrompt = true
        if ((FORBIDDEN_TOOLS as ReadonlyArray<string>).includes(event.part.name)) {
          sawForbiddenSpawnTool = true
        }
      }
    }

    // (2) Child durably created with parent correlation — observed via the
    // PUBLIC client snapshot of the child RuntimeContext.
    let observedCreatedBy = ""
    let childCreatedWithParentCorrelation = false
    const childHandle = firegrid.open(childContextId)
    while (!childCreatedWithParentCorrelation) {
      if ((yield* Clock.currentTimeMillis) >= deadline) break
      const snap = yield* childHandle.snapshot.pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      )
      const createdBy = snap?.context?.createdBy
      if (createdBy !== undefined) {
        observedCreatedBy = createdBy
        if (createdBy === expectedCreatedBy) {
          childCreatedWithParentCorrelation = true
          break
        }
      }
      yield* Clock.sleep("500 millis")
    }

    // (3) Parent observes the child result through the PUBLIC surface — a
    // scoped client handle attached to the child session id.
    const childSession = yield* firegrid.sessions.attach({
      sessionId: childContextId,
    })
    let childText = ""
    let childSeq: number | undefined
    while (!childText.includes(CHILD_RESUMED)) {
      if ((yield* Clock.currentTimeMillis) >= deadline) break
      const next = yield* childSession.wait.forAgentOutput({
        ...(childSeq === undefined ? {} : { afterSequence: childSeq }),
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
      childSeq = next.output.sequence
      const event = next.output.event
      if (event._tag === "TextChunk") childText += event.part.delta
    }

    return {
      parentContextId,
      childContextId,
      sawSessionNew,
      sawSessionPrompt,
      sawForbiddenSpawnTool,
      childCreatedWithParentCorrelation,
      observedCreatedBy,
      childResultObserved: childText.includes(CHILD_DONE),
      childResumeObserved: childText.includes(CHILD_RESUMED),
      childText,
    }
  })

export const delegationParentChildSimulation = {
  id: "delegation-parent-child-pipeline",
  description:
    "factory-vision §7.4: a deterministic parent participant delegates to a child participant via session_new + session_prompt (NO spawn/spawn_all). The child is durably created with parent correlation, observable from outside through the public client, and resumable from inside.",
  makeHost: env => composeDelegationHost(env),
  driver: delegationDriver,
} satisfies TinyFiregridSimulation<DelegationSimulationResult>

/* eslint-enable local/no-fixed-polling */
