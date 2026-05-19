import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  FiregridRuntimeHostLive,
  type FiregridHost,
  RuntimeEnvResolverPolicy,
} from "@firegrid/host-sdk"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "./types.ts"
import { Clock, Effect, Schedule } from "effect"
import type { Layer } from "effect"

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client simulation retry backoff. */

interface PermissionFlowSimulationResult {
  readonly sawReady: boolean
  readonly sawPermissionRequest: boolean
  readonly respondedAllow: boolean
  readonly sawPostResumeOutput: boolean
  readonly permissionRequestId: string
  readonly permissionToolUseId: string
  readonly resultText: string
}

// Self-contained host compose. This simulation deliberately does NOT import
// packages/tiny-firegrid/src/configurations/ (slated for deletion; sims own
// their host compose). The permission-flow signal needs a real
// tool-ENUMERATING ACP agent that issues `session/request_permission`;
// codex-acp@0.14.0 is verified non-enumerating, so claude-code-acp is used.
// The agent process needs its provider key resolved through the host env
// policy; the default `denyAll` would never authorize it, so an explicit
// single-binding policy is composed here (host stays locked down by default).
const permissionFlowAnthropicEnvPolicy = (
  env: NodeJS.ProcessEnv,
): Layer.Layer<RuntimeEnvResolverPolicy> =>
  RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
    lookupEnv: name => env[name],
  })

const permissionFlowHost = (
  env: TinyFiregridSimulationEnv,
): Layer.Layer<FiregridHost, unknown> =>
  // TFIND-005: production host factories still return a layer whose public
  // surface is `FiregridHost` but whose inferred output channel is `any`.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  FiregridRuntimeHostLive(
    {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      hostId: "host-a",
      hostSessionId: "host-a-session",
      input: true,
      ...(env.localProcessEnv === undefined
        ? {}
        : { localProcessEnv: env.localProcessEnv }),
    },
    permissionFlowAnthropicEnvPolicy(env.processEnv),
  )

const claudeAcpArgv = [
  "npx",
  "-y",
  "@zed-industries/claude-code-acp@0.16.2",
] as const

// tf-e1d / tf-v2z: the prior probe (`echo FIREGRID_PERMISSION_PROBE`) is a
// read-only command claude-code-acp AUTO-PERMITS in its default ACP
// posture, so it never emits `session/request_permission` and the durable
// human-gate round-trip is never exercised (the §413 keyed REAL finding).
// Drive a genuinely permission-GATED operation instead: a state-changing
// FILE WRITE, which Claude Code's default permission mode reliably gates
// behind an approval request. Written to an absolute /tmp path so the
// repo/worktree is not polluted and the op is unambiguously side-effecting.
const permissionProbePath = (runId: string): string =>
  `/tmp/firegrid_permission_probe_${runId.replace(/[^A-Za-z0-9_-]/g, "_")}`

const promptForGatedToolCall = (runId: string): string =>
  [
    "You have a shell/Bash tool available in this ACP session.",
    "Make EXACTLY ONE shell tool call that WRITES A FILE: run the command",
    `\`printf 'FIREGRID_PERMISSION_PROBE' > ${permissionProbePath(runId)}\`.`,
    "This is a state-changing file write and should require approval.",
    "Do not call any other tool, and do not call any tool more than once.",
    "After that single command's result returns, reply with exactly this",
    "line and nothing else: FIREGRID_PERMISSION_RESULT done=true",
  ].join("\n")

const permissionFlowDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<PermissionFlowSimulationResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    // Env-gate: claude-code-acp cannot drive a prompt turn without a key.
    // Fail FAST + explicitly when absent (mirrors dark-factory-pipeline)
    // instead of spawning the agent and hanging to the runner timeout
    // (~90s). The real-key path is untouched; this only fires keyless.
    if (env.processEnv.ANTHROPIC_API_KEY === undefined || env.processEnv.ANTHROPIC_API_KEY.length === 0) {
      return yield* Effect.fail(new Error(
        "permission-flow-pipeline requires ANTHROPIC_API_KEY for claude-code-acp",
      ))
    }
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid",
        id: env.runId,
      },
      runtime: local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-code-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload: promptForGatedToolCall(env.runId),
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

    const deadline = (yield* Clock.currentTimeMillis) + 320_000

    // Phase 1 — the factory human gate: wait for the durable
    // PermissionRequest observation surfaced through the public client.
    let sawPermissionRequest = false
    let respondedAllow = false
    let permissionRequestId = ""
    let permissionToolUseId = ""
    let gateSequence: number | undefined

    while (!respondedAllow) {
      if ((yield* Clock.currentTimeMillis) >= deadline) break
      const gate = yield* session.wait.forPermissionRequest({
        timeoutMs: 15_000,
      }).pipe(
        Effect.retry(
          Schedule.intersect(
            Schedule.spaced("1000 millis"),
            Schedule.recurs(5),
          ),
        ),
      )
      if (!gate.matched) continue
      sawPermissionRequest = true
      permissionRequestId = gate.request.permissionRequestId
      permissionToolUseId = gate.request.toolUseId
      gateSequence = gate.request.sequence
      // PermissionResponse resume durability: the public client appends the
      // decision; the host workflow durably consumes it and the codec
      // resolves the ACP permission deferred so the agent proceeds.
      yield* session.permissions.respond({
        permissionRequestId,
        decision: { _tag: "Allow" },
      }).pipe(
        Effect.retry(
          Schedule.intersect(
            Schedule.spaced("1000 millis"),
            Schedule.recurs(5),
          ),
        ),
      )
      respondedAllow = true
    }

    // Phase 2 — prove the resume actually propagated: observe agent output
    // strictly AFTER the gate sequence until the post-permission result
    // line appears (or time out).
    let sawReady = false
    let sawPostResumeOutput = false
    let resultText = ""
    let afterSequence = gateSequence

    while (
      respondedAllow &&
      !resultText.includes("FIREGRID_PERMISSION_RESULT")
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
      sawPostResumeOutput = true
      const event = observation.event
      if (event._tag === "Ready") sawReady = true
      if (event._tag === "TextChunk") resultText += event.part.delta
    }

    return {
      sawReady,
      sawPermissionRequest,
      respondedAllow,
      sawPostResumeOutput,
      permissionRequestId,
      permissionToolUseId,
      resultText,
    }
  })

export const permissionFlowSimulation = {
  id: "permission-flow-pipeline",
  description:
    "Self-contained host compose + tool-enumerating claude-code-acp agent driven through the public Firegrid client to exercise the factory human-gate path: durable PermissionRequest observation -> PermissionResponse(Allow) resume -> post-resume agent output.",
  makeHost: env => permissionFlowHost(env),
  driver: permissionFlowDriver,
  summarize: result => ({
    sawReady: result.sawReady,
    sawPermissionRequest: result.sawPermissionRequest,
    respondedAllow: result.respondedAllow,
    sawPostResumeOutput: result.sawPostResumeOutput,
    permissionRequestId: result.permissionRequestId,
    permissionToolUseId: result.permissionToolUseId,
    resultTextExcerpt: result.resultText.slice(0, 600),
  }),
  localize: result => {
    if (!result.sawPermissionRequest) {
      return [
        "No durable PermissionRequest was surfaced through session.wait.forPermissionRequest.",
        "Trace localization (run 2026-05-19T10-37-28-891Z): the Firegrid substrate path is sound end to end — client prompt -> control plane -> runtime-context workflow -> ACP codec -> local-process spawn -> acp.initialize -> acp.new_session (session_id returned) -> acp.session_update(available_commands_update) -> acp.prompt(turn-1). The external claude-code-acp agent then exited (acp.exit) with ZERO model output, ZERO tool call, ZERO session/request_permission.",
        "session/new succeeding proves the nested-session CLAUDECODE guard did NOT fire and env was sufficient to create a session; the gap is the agent-internal model-invocation/auth boundary host tracing cannot see (claude-code-acp advertises only the claude-login OAuth authMethod; ANTHROPIC_API_KEY alone created a session but did not drive a prompt turn in the clean sandbox env). See FINDINGS artifact tf-ahk for the verification matrix and tiering.",
      ]
    }
    if (result.respondedAllow && !result.sawPostResumeOutput) {
      return [
        "A PermissionRequest was observed and a PermissionResponse(Allow) was appended, but no agent output was observed after the gate sequence.",
        "Inspect runtime-context.permission.response / firegrid.runtime_context.workflow.permission_response.await spans and the ACP permission_response span to determine whether the durable PermissionResponse resumed the codec deferred (resume durability gap).",
      ]
    }
    if (
      result.sawPostResumeOutput &&
      !result.resultText.includes("FIREGRID_PERMISSION_RESULT")
    ) {
      return [
        "The gate resumed and post-permission output flowed, but the deterministic completion line was not observed.",
        "This is an agent-behavior divergence, not a substrate gap; inspect the captured text excerpt and ToolUse spans.",
      ]
    }
    return [
      "Full factory human-gate path observed end to end. Inspect the DuckDB span tables for the durable PermissionRequest persistence, PermissionResponse resume, and post-resume output path taken by this run.",
    ]
  },
} satisfies TinyFiregridSimulation<PermissionFlowSimulationResult>

/* eslint-enable local/no-fixed-polling */
