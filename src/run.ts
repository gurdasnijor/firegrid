/**
 * Synchronous Firegrid run entrypoint (Phase 2 MVP).
 *
 * Usage:
 *
 *   pnpm firegrid:run -- node -e 'console.log(JSON.stringify({hello:"firegrid"}))'
 *
 *   pnpm firegrid:run \
 *     --secret-env ANTHROPIC_API_KEY \
 *     -- node agent.mjs
 *
 *   pnpm firegrid:run \
 *     --secret-env ANTHROPIC_API_KEY=PARENT_ANTHROPIC_KEY \
 *     -- node agent.mjs
 *
 * The --secret-env flag does TWO things:
 *   1. Adds a binding `{ name, ref: "env:<envName>" }` to
 *      RuntimeContext.runtime.config.envBindings so the durable row records
 *      *which* host env var the child will see — but never the value.
 *   2. Authorizes the runtime resolver to actually read that host env var
 *      at spawn time. The default runtime policy denies every env binding;
 *      authorization is an explicit operator grant at the binary boundary.
 *
 * Implements:
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.2
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.3
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.4 — no raw-secret
 *    flag exists; --secret-env names host env vars only.
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 — durable
 *    envBindings; values resolved only at spawn time.
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 — host operator
 *    authorizes specific env vars; default resolver denies all refs.
 *  - firegrid-workflow-driven-runtime.VALIDATION.2 — see the runbook in
 *    docs/runbooks/firegrid-run-sync-mvp.md for the smoke command.
 */

import { NodeRuntime } from "@effect/platform-node"
import {
  RuntimeControlPlaneTable,
  envBinding,
  local,
  normalizeRuntimeIntent,
  type RuntimeEnvBinding,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import {
  FiregridRuntimeHostWithWorkflowFromConfigWithEnvPolicy,
  RuntimeEnvResolverPolicy,
} from "@firegrid/runtime"
import { startRuntime } from "@firegrid/runtime/runtime-host"
import { Cause, Clock, Console, Data, Effect, Exit, Layer } from "effect"

class FiregridRunUsageError extends Data.TaggedError("FiregridRunUsageError")<{
  readonly message: string
}> {}

const usage =
  "firegrid:run requires `--` followed by an agent command.\n" +
  "Example: pnpm firegrid:run -- node -e 'console.log(\"hello\")'\n" +
  "Optional secret authorization (env-var name only, never the value):\n" +
  "  pnpm firegrid:run --secret-env ANTHROPIC_API_KEY -- node agent.mjs\n" +
  "  pnpm firegrid:run --secret-env ANTHROPIC_API_KEY=PARENT_KEY -- node agent.mjs"

// argv is read from the ambient `process` global. The lint guard bans
// `import process from "node:process"`; the global is allowed and is what
// NodeRuntime itself reads internally.
const readArgv = Effect.sync(() => globalThis.process.argv.slice(2))

interface ParsedRunCommand {
  readonly agentArgv: ReadonlyArray<string>
  readonly bindings: ReadonlyArray<RuntimeEnvBinding>
  readonly allowedEnvVars: ReadonlyArray<string>
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const usageError = (message: string): FiregridRunUsageError =>
  new FiregridRunUsageError({ message })

// Parse a single --secret-env value. Accepts:
//   NAME          → binding { name: NAME, ref: env:NAME }
//   NAME=ENV_NAME → binding { name: NAME, ref: env:ENV_NAME }
// The flag never accepts a literal secret value; both halves are env var
// identifiers only. Anything that doesn't look like an env-var identifier
// is rejected loudly — that's the line that prevents a slip from turning
// --secret-env into a raw-value flag.
const parseSecretEnvFlag = (
  raw: string,
): Effect.Effect<RuntimeEnvBinding, FiregridRunUsageError> => {
  const equalsIndex = raw.indexOf("=")
  const name = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex)
  const envName = equalsIndex === -1 ? raw : raw.slice(equalsIndex + 1)
  if (!ENV_NAME_PATTERN.test(name)) {
    return Effect.fail(usageError(
      `--secret-env expects an env-var identifier, got "${name}". ` +
        "Use --secret-env NAME or --secret-env NAME=ENV_NAME; values are never accepted on the command line.",
    ))
  }
  if (!ENV_NAME_PATTERN.test(envName)) {
    return Effect.fail(usageError(
      `--secret-env right-hand side "${envName}" is not a valid env-var identifier. ` +
        "--secret-env names host env vars; it does not accept secret values.",
    ))
  }
  return Effect.succeed(envBinding(name, envName))
}

const parseCommand = (
  argv: ReadonlyArray<string>,
): Effect.Effect<ParsedRunCommand, FiregridRunUsageError> =>
  Effect.gen(function* () {
    const separatorIndex = argv.indexOf("--")
    if (separatorIndex === -1) {
      return yield* Effect.fail(usageError(usage))
    }
    const before = argv.slice(0, separatorIndex)
    const after = argv.slice(separatorIndex + 1)
    if (after.length === 0) {
      return yield* Effect.fail(usageError(
        "firegrid:run requires at least one argument after `--` (the agent command).",
      ))
    }

    const bindings: Array<RuntimeEnvBinding> = []
    const allowedEnvVars: Array<string> = []
    let index = 0
    while (index < before.length) {
      const token = before[index]!
      if (token === "--secret-env") {
        const value = before[index + 1]
        if (value === undefined) {
          return yield* Effect.fail(usageError(
            "--secret-env requires a value (NAME or NAME=ENV_NAME).",
          ))
        }
        const binding = yield* parseSecretEnvFlag(value)
        // Pull the env name back out of the ref. Bindings only ever take
        // shape "env:VAR" here because parseSecretEnvFlag constructs them.
        const envName = binding.ref.slice("env:".length)
        bindings.push(binding)
        allowedEnvVars.push(envName)
        index += 2
        continue
      }
      if (token.startsWith("--secret-env=")) {
        const value = token.slice("--secret-env=".length)
        const binding = yield* parseSecretEnvFlag(value)
        const envName = binding.ref.slice("env:".length)
        bindings.push(binding)
        allowedEnvVars.push(envName)
        index += 1
        continue
      }
      return yield* Effect.fail(usageError(
        `firegrid:run does not recognize the option "${token}" before "--". ` +
          "Supported flags before \"--\": --secret-env NAME[=ENV_NAME].",
      ))
    }

    return {
      agentArgv: after,
      bindings,
      allowedEnvVars,
    }
  })

const buildRuntimeContextRow = (
  parsed: ParsedRunCommand,
): Effect.Effect<RuntimeContext> =>
  Effect.map(Clock.currentTimeMillis, (millis): RuntimeContext => ({
    contextId: `ctx_${crypto.randomUUID()}`,
    createdAt: new Date(millis).toISOString(),
    createdBy: "firegrid-run",
    runtime: normalizeRuntimeIntent(local.jsonl({
      argv: [...parsed.agentArgv],
      ...(parsed.bindings.length === 0 ? {} : { envBindings: parsed.bindings }),
    })),
  }))

const runWithLayer = (parsed: ParsedRunCommand) =>
  Effect.gen(function* () {
    const control = yield* RuntimeControlPlaneTable
    const context = yield* buildRuntimeContextRow(parsed)

    yield* control.contexts.upsert(context)
    yield* Console.log(
      `firegrid:run: launched context ${context.contextId} (${parsed.agentArgv.join(" ")})`,
    )

    const result = yield* startRuntime({ contextId: context.contextId })

    yield* Console.log(
      `firegrid:run: context ${context.contextId} exited (attempt ${result.activityAttempt}, exitCode ${result.exitCode}${
        result.signal === undefined ? "" : `, signal ${result.signal}`
      })`,
    )

    return result.exitCode
  })

// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
//
// The env policy layer is constructed here, at the binary boundary, so
// that globalThis.process.env reads never leak into library code. The
// allowlist is derived from --secret-env flags exclusively; nothing else
// can authorize an env-binding ref.
const envPolicyLayer = (
  allowedEnvVars: ReadonlyArray<string>,
) =>
  Layer.succeed(
    RuntimeEnvResolverPolicy,
    RuntimeEnvResolverPolicy.make({
      allowedEnvVars,
      lookupEnv: (name: string) => globalThis.process.env[name],
    }),
  )

const programWithExitCode: Effect.Effect<number, never, never> = Effect.gen(
  function* () {
    const argv = yield* readArgv
    const parsed = yield* parseCommand(argv)
    return yield* runWithLayer(parsed).pipe(
      Effect.provide(
        FiregridRuntimeHostWithWorkflowFromConfigWithEnvPolicy(
          envPolicyLayer(parsed.allowedEnvVars),
        ),
      ),
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
