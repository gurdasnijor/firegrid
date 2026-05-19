/* eslint-disable */
import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  FiregridRuntimeHostLive,
  type FiregridHost,
} from "@firegrid/host-sdk"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "../../types.ts"
import { Clock, Effect, Schedule } from "effect"
import type { Layer } from "effect"

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client simulation retry backoff. */

// Self-contained host compose. This simulation deliberately does NOT import
// packages/tiny-firegrid/src/configurations/ (slated for deletion; sims own
// their host compose). The agent-free stdio-jsonl host path:
// FiregridRuntimeHostLive composes the runtime tool-use executor +
// LocalProcessSandboxProvider; a deterministic stdio-jsonl child is the
// agent (no LLM).
const composeExecuteHost = (
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

const EXECUTE_SENTINEL = "FIREGRID_EXECUTE_SIDE_EFFECT_OK"
const OBSERVED_PREFIX = "FIREGRID_EXECUTE_OBSERVED:"

// Deterministic, agent-FREE stdio-jsonl child. It emits exactly one
// `execute` ToolUse whose sandbox-neutral input is a real provider command
// (run a process that writes a sentinel to stdout), then reads the
// host-fed `tool_result` back over stdin and re-emits the provider stdout
// as agent text so the driver can observe the provider side-effect
// strictly through the PUBLIC client surface. No LLM, no quotes inside the
// nested argv (the sentinel is passed via envVars).
const deterministicChildCode = [
  "const C = process.execPath",
  `const SENT = ${JSON.stringify(EXECUTE_SENTINEL)}`,
  `const OBS = ${JSON.stringify(OBSERVED_PREFIX)}`,
  "const NL = String.fromCharCode(10)",
  "function emit(o){ process.stdout.write(JSON.stringify(o) + NL) }",
  "emit({ type:'tool_use', toolUseId:'exec-1', name:'execute', input:{ sandbox:{ providerName:'local-process', toolName:'shell' }, input:{ argv:[C,'-e','process.stdout.write(process.env.FG_SENT)'], envVars:{ FG_SENT: SENT } } } })",
  "let buf=''",
  "process.stdin.on('data', d=>{ buf+=String(d); let i; while((i=buf.indexOf(NL))>=0){ const line=buf.slice(0,i); buf=buf.slice(i+1); try{ const m=JSON.parse(line); if(m && m.type==='tool_result' && m.toolUseId==='exec-1'){ const c=m.content; const out=(c && typeof c==='object') ? (c.stdout||'') : String(c); emit({ type:'text', text: OBS + out }); emit({ type:'turn_complete', finishReason:'stop' }); process.exit(0) } }catch(e){} } })",
].join("\n")

const deterministicArgv = [
  globalThis.process.execPath,
  "-e",
  deterministicChildCode,
] as const

interface ExecuteProviderSideEffectResult {
  readonly sawExecuteToolUse: boolean
  readonly sawProviderStdout: boolean
  readonly resultText: string
}

const executeProviderSideEffectDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<ExecuteProviderSideEffectResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid",
        id: env.runId,
      },
      runtime: local.jsonl({
        argv: [...deterministicArgv],
        agent: "tiny-firegrid-deterministic",
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload: "tiny-firegrid execute provider side-effect probe",
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
    let sawExecuteToolUse = false
    let resultText = ""
    let afterSequence: number | undefined

    while (
      !(sawExecuteToolUse && resultText.includes(OBSERVED_PREFIX))
    ) {
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
      if (event._tag === "ToolUse" && event.part.name === "execute") {
        sawExecuteToolUse = true
      }
      if (event._tag === "TextChunk") resultText += event.part.delta
    }

    return {
      sawExecuteToolUse,
      sawProviderStdout: resultText.includes(
        `${OBSERVED_PREFIX}${EXECUTE_SENTINEL}`,
      ),
      resultText,
    }
  })

export const executeProviderSideEffectSimulation = {
  id: "execute-provider-side-effect-pipeline",
  description:
    "Deterministic, agent-free stdio-jsonl probe of the `execute` agent-tool provider side-effect substrate, driven entirely through the public Firegrid client: an execute ToolUse runs a real SandboxProvider command and its stdout is observed back as agent output.",
  makeHost: env => composeExecuteHost(env),
  driver: executeProviderSideEffectDriver,
} satisfies TinyFiregridSimulation<ExecuteProviderSideEffectResult>

/* eslint-enable local/no-fixed-polling */
