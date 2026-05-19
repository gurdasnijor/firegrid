/* eslint-disable */
import {
  FiregridRuntimeHostLive,
  type RuntimeHostTopologyOptions,
} from "@firegrid/host-sdk"
import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "../../types.ts"
import { Clock, Effect, Schedule } from "effect"

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client simulation retry backoff. */

interface SessionLifecycleUnwindSimulationResult {
  readonly lifecycle: "cancel" | "close"
  readonly sawReady: boolean
  readonly sawTerminated: boolean
  readonly snapshotStatus: string
  readonly terminalObserved: boolean
}

// Self-contained deterministic stdio-JSONL agent. NOT an LLM / NOT a real
// provider. On a prompt it parses a `TERMINATE:<cancel|close>:<sessionId>`
// marker out of the prompt envelope and emits exactly one Firegrid
// `session_cancel`/`session_close` agent-tool call against that session,
// then deliberately stays alive (it never turn_completes) so the
// per-context engine is still RUNNING when the durable lifecycle request
// reconciles. The clean-unwind substrate then drives the engine to a
// durable terminal state and the agent process is terminated — observed
// here purely through the public Firegrid client as a `Terminated`
// agent-output / non-running run status (§6 "abandon child work, record
// the outcome").
const deterministicLifecycleAgentSource = `
let buf = ""
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n")
let emitted = false
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line.length === 0) continue
    let msg
    try { msg = JSON.parse(line) } catch (_e) { continue }
    if (msg && msg.type === "prompt" && !emitted) {
      const m = JSON.stringify(msg).match(/TERMINATE:(cancel|close):([A-Za-z0-9_-]+)/)
      if (!m) continue
      emitted = true
      const lifecycle = m[1]
      const sessionId = m[2]
      const toolName = lifecycle === "cancel" ? "session_cancel" : "session_close"
      out({ type: "status", kind: "accepted" })
      out({
        type: "tool_use",
        toolUseId: "lifecycle-1",
        name: toolName,
        input: { sessionId },
      })
      // Deliberately do NOT turn_complete: stay alive so the engine is
      // running when the lifecycle request reconciles and the unwind
      // terminates this process.
    }
  }
})
`

const lifecycleAgentArgv = [
  "node",
  "-e",
  deterministicLifecycleAgentSource,
] as const

const makeSelfContainedHost = (
  env: TinyFiregridSimulationEnv,
): ReturnType<typeof FiregridRuntimeHostLive> => {
  const hostId = "host-a"
  const localProcessEnv: RuntimeHostTopologyOptions["localProcessEnv"] | undefined =
    env.localProcessEnv
  // Self-contained: deliberately does NOT import
  // packages/tiny-firegrid/src/configurations/ (slated for deletion). The
  // host-compose is inlined. FiregridRuntimeHostLive composes the
  // control-request reconciler daemon by default — that is what drives the
  // durable session-lifecycle terminate request to a terminal state.
  return FiregridRuntimeHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    hostId,
    hostSessionId: `${hostId}-session`,
    input: true,
    ...(localProcessEnv === undefined ? {} : { localProcessEnv }),
  })
}

const sessionLifecycleUnwindDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<SessionLifecycleUnwindSimulationResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const lifecycle: "cancel" | "close" = "cancel"
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid",
        id: env.runId,
      },
      runtime: local.jsonl({
        argv: [...lifecycleAgentArgv],
        agent: "session-lifecycle-fixture",
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    // The agent learns the target session id only through the public
    // prompt surface (the client never expresses cancel/close itself —
    // session_cancel/session_close are agent-tool-only by the SDD).
    yield* session.prompt({
      payload: [
        "Deterministic clean-unwind substrate probe.",
        `TERMINATE:${lifecycle}:${session.contextId}`,
      ].join("\n"),
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

    const deadline = (yield* Clock.currentTimeMillis) + 220_000
    let sawReady = false
    let sawTerminated = false
    let afterSequence: number | undefined

    while (!sawTerminated) {
      if ((yield* Clock.currentTimeMillis) >= deadline) break
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
      const observation = next.output
      afterSequence = observation.sequence
      const event = observation.event
      if (event._tag === "Ready") sawReady = true
      if (event._tag === "Terminated") sawTerminated = true
    }

    const snapshot = yield* session.snapshot()
    const snapshotStatus = snapshot.status ?? "unknown"
    const terminalObserved = sawTerminated || snapshotStatus !== "started"

    return {
      lifecycle,
      sawReady,
      sawTerminated,
      snapshotStatus,
      terminalObserved,
    }
  })

export const sessionLifecycleUnwindSimulation = {
  id: "session-lifecycle-unwind-pipeline",
  description:
    "Drives an inlined self-contained host with a deterministic stdio-jsonl agent that calls the session_cancel agent tool against its own running session, then observes — purely through the public Firegrid client — that the clean-unwind substrate terminates the session. Substrate-property trace of durable session_cancel/session_close (the §6 clean-unwind primitive).",
  makeHost: env => makeSelfContainedHost(env),
  driver: sessionLifecycleUnwindDriver,
} satisfies TinyFiregridSimulation<SessionLifecycleUnwindSimulationResult>

/* eslint-enable local/no-fixed-polling */
