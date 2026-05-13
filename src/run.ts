/**
 * Synchronous Firegrid run entrypoint (Phase 2 MVP).
 *
 * Usage:
 *
 *   pnpm firegrid:run -- node -e 'console.log(JSON.stringify({hello:"firegrid"}))'
 *
 * Implements:
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1 — read argv after the
 *    "--" separator, build a RuntimeContext row, insert it into
 *    RuntimeControlPlaneTable, and call startRuntime(contextId).
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.2 — block until
 *    startRuntime / RuntimeContextWorkflow returns and exit with the runtime
 *    execution exit code via NodeRuntime.runMain's teardown boundary.
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.3 — reuse
 *    FiregridRuntimeHostWithWorkflowFromConfig so the same control-plane,
 *    ingress, output, workflow engine, and local-process provider layers
 *    drive this entrypoint as drive normal runtime execution.
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.4 — secrets are taken
 *    only through the existing Effect Config / env-backed
 *    FIREGRID_DURABLE_STREAMS_TOKEN redacted config; this entrypoint adds no
 *    --token / --auth-token / --secret CLI flags.
 *  - firegrid-workflow-driven-runtime.VALIDATION.2 — see the runbook in
 *    docs/runbooks/firegrid-run-sync-mvp.md for the smoke command.
 */

import { NodeRuntime } from "@effect/platform-node"
import {
  RuntimeControlPlaneTable,
  local,
  normalizeRuntimeIntent,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { FiregridRuntimeHostWithWorkflowFromConfig } from "@firegrid/runtime"
import { startRuntime } from "@firegrid/runtime/runtime-host"
import { Cause, Clock, Console, Data, Effect, Exit } from "effect"

class FiregridRunUsageError extends Data.TaggedError("FiregridRunUsageError")<{
  readonly message: string
}> {}

const usage =
  "firegrid:run requires `--` followed by an agent command. Example: pnpm firegrid:run -- node -e 'console.log(\"hello\")'"

// argv is read from the ambient `process` global. The lint guard bans
// `import process from "node:process"`; the global is allowed and is what
// NodeRuntime itself reads internally.
const readArgv = Effect.sync(() => globalThis.process.argv.slice(2))

const parseAgentCommand = (
  argv: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, FiregridRunUsageError> => {
  const separatorIndex = argv.indexOf("--")
  if (separatorIndex === -1) {
    return Effect.fail(new FiregridRunUsageError({ message: usage }))
  }
  const before = argv.slice(0, separatorIndex)
  if (before.length > 0) {
    return Effect.fail(new FiregridRunUsageError({
      message:
        `firegrid:run does not accept arguments before "--" in this MVP. Got: ${
          before.join(" ")
        }. Configure the host through env (DURABLE_STREAMS_BASE_URL, FIREGRID_RUNTIME_NAMESPACE, FIREGRID_DURABLE_STREAMS_TOKEN).`,
    }))
  }
  const after = argv.slice(separatorIndex + 1)
  if (after.length === 0) {
    return Effect.fail(new FiregridRunUsageError({
      message:
        "firegrid:run requires at least one argument after `--` (the agent command).",
    }))
  }
  return Effect.succeed(after)
}

const buildRuntimeContextRow = (
  argv: ReadonlyArray<string>,
): Effect.Effect<RuntimeContext> =>
  Effect.map(Clock.currentTimeMillis, (millis): RuntimeContext => ({
    contextId: `ctx_${crypto.randomUUID()}`,
    createdAt: new Date(millis).toISOString(),
    createdBy: "firegrid-run",
    runtime: normalizeRuntimeIntent(local.jsonl({ argv: [...argv] })),
  }))

/**
 * firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1
 * firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.2
 *
 * Build the row, append it through the same control-plane table the runtime
 * host owns, then call startRuntime and yield its exit code.
 *
 * The row insert lives at the caller — not inside startRuntime — so that
 * startRuntime stays a thin "start/resume by contextId" verb shared with
 * @firegrid/client.launch and any other launch path. See the design note in
 * the PR description.
 */
const runWithLayer = (agentArgv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const control = yield* RuntimeControlPlaneTable
    const context = yield* buildRuntimeContextRow(agentArgv)

    yield* control.contexts.upsert(context)
    yield* Console.log(
      `firegrid:run: launched context ${context.contextId} (${agentArgv.join(" ")})`,
    )

    const result = yield* startRuntime({ contextId: context.contextId })

    yield* Console.log(
      `firegrid:run: context ${context.contextId} exited (attempt ${result.activityAttempt}, exitCode ${result.exitCode}${
        result.signal === undefined ? "" : `, signal ${result.signal}`
      })`,
    )

    return result.exitCode
  })

/**
 * firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.3
 *
 * Reuse the env-driven host layer so this entrypoint does not introduce a
 * second layer composition. Headers (auth) flow through
 * FIREGRID_DURABLE_STREAMS_TOKEN — see PHASE_2_SYNC_RUN.4.
 */
const layer = FiregridRuntimeHostWithWorkflowFromConfig

/**
 * Argv parsing runs first — before layer construction — so a usage error
 * surfaces with exit 2 even when env-driven Config is missing. Layer
 * construction only happens once we have a real agent command to execute.
 *
 * Errors are mapped into the success channel as POSIX-style exit codes so
 * the teardown only has to translate `Exit<number, never>` → `onExit(code)`.
 *
 *   usage error           → exit 2 (POSIX convention for misuse)
 *   layer/runtime failure → exit 1 with the cause printed via Console.error
 *   child runtime exit    → that exit code (0 for success, anything else
 *                           for the agent command's own exit)
 */
const programWithExitCode: Effect.Effect<number, never, never> = Effect.gen(
  function* () {
    const argv = yield* readArgv
    const agentArgv = yield* parseAgentCommand(argv)
    return yield* runWithLayer(agentArgv).pipe(
      Effect.provide(layer),
      Effect.scoped,
    )
  },
).pipe(
  Effect.catchTag("FiregridRunUsageError", (error) =>
    Console.error(error.message).pipe(Effect.as(2))),
  Effect.catchAllCause((cause) =>
    Console.error(`firegrid:run failed: ${Cause.pretty(cause)}`).pipe(
      Effect.as(1),
    )),
)

/**
 * firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.2
 *
 * Custom teardown is the @effect/platform-node entry boundary for arbitrary
 * exit codes. `Exit.match` dispatches on the Exit's tagged shape: success
 * carries the exit code as a number; failure mirrors the upstream
 * defaultTeardown semantic — interruption-only causes exit 0, everything
 * else exits 1.
 */
function teardown<E, A>(
  exit: Exit.Exit<E, A>,
  onExit: (code: number) => void,
): void {
  Exit.match(exit, {
    onSuccess: (value) => onExit(typeof value === "number" ? value : 0),
    onFailure: (cause) => onExit(Cause.isInterruptedOnly(cause) ? 0 : 1),
  })
}

NodeRuntime.runMain(programWithExitCode, {
  disableErrorReporting: true,
  teardown,
})
