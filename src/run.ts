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
 *    execution exit code.
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.3 — reuse
 *    FiregridRuntimeHostWithWorkflowFromConfig so the same control-plane,
 *    ingress, output, workflow engine, and local-process provider layers
 *    drive this entrypoint as drive normal runtime execution. We do NOT
 *    construct a parallel layer composition.
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.4 — secrets are taken
 *    only through the existing Effect Config / env-backed
 *    FIREGRID_DURABLE_STREAMS_TOKEN redacted config; this entrypoint adds no
 *    --token / --auth-token / --secret CLI flags.
 *  - firegrid-workflow-driven-runtime.VALIDATION.2 — exercising this path
 *    against a real Durable Streams server proves a local-process command can
 *    be launched and observed through RuntimeOutputTable using the same
 *    runtime-context path. See the runbook in
 *    docs/runbooks/firegrid-run-sync-mvp.md for the smoke command.
 */

import { startRuntime } from "@firegrid/runtime/runtime-host"
import { RuntimeControlPlaneTable } from "@firegrid/protocol/launch"
import {
  local,
  normalizeRuntimeIntent,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { FiregridRuntimeHostWithWorkflowFromConfig } from "@firegrid/runtime"
import { Clock, Console, Effect, Layer } from "effect"
import process from "node:process"

class FiregridRunUsageError extends Error {
  override readonly name = "FiregridRunUsageError"
}

/**
 * Parse argv looking for the "--" separator. Everything after the separator is
 * the agent command. Anything before the separator is reserved for a future
 * flag-set; for the Phase 2 MVP we accept zero flags before "--".
 */
const parseAgentCommand = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const separatorIndex = argv.indexOf("--")
  if (separatorIndex === -1) {
    throw new FiregridRunUsageError(
      "firegrid:run requires `--` followed by an agent command. Example: pnpm firegrid:run -- node -e 'console.log(\"hello\")'",
    )
  }
  const before = argv.slice(0, separatorIndex)
  if (before.length > 0) {
    throw new FiregridRunUsageError(
      `firegrid:run does not accept arguments before "--" in this MVP. Got: ${before.join(" ")}. Configure the host through env (DURABLE_STREAMS_BASE_URL, FIREGRID_RUNTIME_NAMESPACE, FIREGRID_DURABLE_STREAMS_TOKEN).`,
    )
  }
  const after = argv.slice(separatorIndex + 1)
  if (after.length === 0) {
    throw new FiregridRunUsageError(
      "firegrid:run requires at least one argument after `--` (the agent command).",
    )
  }
  return after
}

const makeContextId = (): string => `ctx_${crypto.randomUUID()}`

const buildRuntimeContextRow = (
  argv: ReadonlyArray<string>,
): Effect.Effect<RuntimeContext> =>
  Effect.map(Clock.currentTimeMillis, (millis): RuntimeContext => ({
    contextId: makeContextId(),
    createdAt: new Date(millis).toISOString(),
    createdBy: "firegrid-run",
    runtime: normalizeRuntimeIntent(local.jsonl({ argv: [...argv] })),
  }))

/**
 * firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1
 * firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.2
 *
 * Build the row, append it through the same control-plane table the runtime
 * host owns, then call startRuntime and propagate its result. Returns the
 * child runtime exit code.
 */
const program = (agentArgv: ReadonlyArray<string>) =>
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

const handleUsageError = (error: FiregridRunUsageError): never => {
  // Synchronous CLI boundary: print usage and exit 2 (POSIX convention for
  // misuse). This runs before any Effect program is started, so a direct
  // throw / process.exit is the right shape.
  process.stderr.write(`${error.message}\n`)
  return process.exit(2) as never
}

const runFiregridRun = async (): Promise<void> => {
  let agentArgv: ReadonlyArray<string>
  try {
    agentArgv = parseAgentCommand(process.argv.slice(2))
  } catch (error) {
    if (error instanceof FiregridRunUsageError) {
      handleUsageError(error)
      return
    }
    throw error
  }

  const exit = await Effect.runPromiseExit(
    Effect.scoped(program(agentArgv).pipe(Effect.provide(layer))),
  )

  if (exit._tag === "Success") {
    process.exit(exit.value)
  }

  // Surface the failure cause so the operator can debug; non-zero exit
  // matches normal Node CLI failure semantics.
  process.stderr.write(`firegrid:run failed:\n`)
  process.stderr.write(`${String(exit.cause)}\n`)
  process.exit(1)
}

void runFiregridRun()
