/**
 * Synchronous Firegrid run entrypoint (Phase 2 MVP).
 *
 * Usage:
 *
 *   pnpm firegrid:run -- node -e 'console.log(JSON.stringify({hello:"firegrid"}))'
 *
 *   pnpm firegrid:run \
 *     --secret-env ANTHROPIC_API_KEY \
 *     --cwd /work/agent \
 *     --prompt "summarize the diff" \
 *     -- node agent.mjs
 *
 *   pnpm firegrid:run \
 *     --secret-env ANTHROPIC_API_KEY=PARENT_ANTHROPIC_KEY \
 *     -- node agent.mjs
 *
 * Flags (all map 1:1 to RunConfigSchema fields):
 *   --secret-env NAME[=ENV_NAME]
 *     1. Adds a binding `{ name, ref: "env:<envName>" }` to
 *        RuntimeContext.runtime.config.envBindings.
 *     2. Authorizes the runtime resolver pair (NAME, ENV_NAME) at
 *        spawn time. The default runtime policy denies every env
 *        binding; authorization is an explicit operator grant.
 *   --cwd PATH
 *     RuntimeContext.runtime.config.cwd. The local-process sandbox
 *     spawns the child in this directory.
 *   --prompt TEXT
 *     Appends an initial RuntimeIngressTable input row (kind=message,
 *     authoredBy=client) BEFORE startRuntime, and forces the runtime
 *     host into inputEnabled=true so the workflow's stdin delivery
 *     stream picks it up.
 *
 * Argv parsing is hand-rolled (the `--` split makes @effect/cli's
 * positional handling awkward), but the parsed shape is decoded
 * through `RunConfigSchema` so the durable row + ingress row + policy
 * layer all read from one validated DTO. See ./run-config.ts.
 *
 * Implements:
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1..6
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.7 — --cwd
 *  - firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8 — --prompt
 *  - firegrid-workflow-driven-runtime.VALIDATION.2 — see the runbook in
 *    docs/runbooks/firegrid-run-sync-mvp.md for the smoke command.
 */

import { NodeRuntime } from "@effect/platform-node"
import {
  RuntimeControlPlaneTable,
  type RuntimeEnvBinding,
} from "@firegrid/protocol/launch"
import {
  FiregridRuntimeHostWithWorkflowLive,
  RuntimeEnvResolverPolicy,
  RuntimeHostTopologyFromConfig,
  appendRuntimeIngress,
  decodeRunConfig,
  runConfigRequiresInput,
  runConfigToIngressRequest,
  runConfigToRuntimeContext,
  startRuntime,
  type RunConfig,
} from "@firegrid/runtime"
import { Cause, Console, Data, Effect, Exit, Layer, ParseResult } from "effect"

class FiregridRunUsageError extends Data.TaggedError("FiregridRunUsageError")<{
  readonly message: string
}> {}

const usage =
  "firegrid:run requires `--` followed by an agent command.\n" +
  "Example: pnpm firegrid:run -- node -e 'console.log(\"hello\")'\n" +
  "Optional flags (all values are env-var names, paths, or prompt text — never raw secrets):\n" +
  "  --secret-env NAME[=ENV_NAME]  authorize and bind a host env var into the child\n" +
  "  --cwd PATH                    spawn the child in PATH\n" +
  "  --prompt TEXT                 deliver TEXT as the first RuntimeIngress input"

// argv is read from the ambient `process` global. The lint guard bans
// `import process from "node:process"`; the global is allowed and is what
// NodeRuntime itself reads internally.
const readArgv = Effect.sync(() => globalThis.process.argv.slice(2))

interface RawRunConfig {
  readonly agentArgv: ReadonlyArray<string>
  readonly cwd?: string
  readonly prompt?: string
  readonly envBindings?: ReadonlyArray<RuntimeEnvBinding>
  readonly authorizedBindings?: ReadonlyArray<readonly [string, string]>
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const usageError = (message: string): FiregridRunUsageError =>
  new FiregridRunUsageError({ message })

// Parse a single --secret-env value. Accepts:
//   NAME          → binding { name: NAME, ref: env:NAME }
//   NAME=ENV_NAME → binding { name: NAME, ref: env:ENV_NAME }
// The flag never accepts a literal secret value; both halves are env var
// identifiers only.
const parseSecretEnvFlag = (
  raw: string,
): Effect.Effect<readonly [string, string], FiregridRunUsageError> => {
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
  return Effect.succeed([name, envName] as const)
}

// Take an argv slice that's already had the `--` separator removed and
// build the raw (pre-decode) RunConfig shape. Decoding through
// RunConfigSchema is the next step.
const parseCommand = (
  argv: ReadonlyArray<string>,
): Effect.Effect<RawRunConfig, FiregridRunUsageError> =>
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

    const envBindings: Array<RuntimeEnvBinding> = []
    const authorizedBindings: Array<readonly [string, string]> = []
    const seenTargets = new Set<string>()
    let cwd: string | undefined
    let prompt: string | undefined

    const recordSecretEnv = (
      pair: readonly [string, string],
    ): Effect.Effect<void, FiregridRunUsageError> => {
      const [name, envName] = pair
      if (seenTargets.has(name)) {
        return Effect.fail(usageError(
          `--secret-env target ${name} was specified more than once; ` +
            "each child env-var name may be authorized at most once per invocation.",
        ))
      }
      seenTargets.add(name)
      envBindings.push({ name, ref: `env:${envName}` })
      authorizedBindings.push([name, envName])
      return Effect.void
    }

    const requireFlagValue = (
      flag: string,
      value: string | undefined,
    ): Effect.Effect<string, FiregridRunUsageError> =>
      value === undefined
        ? Effect.fail(usageError(`${flag} requires a value.`))
        : Effect.succeed(value)

    let index = 0
    while (index < before.length) {
      const token = before[index]!
      if (token === "--secret-env") {
        const value = yield* requireFlagValue("--secret-env", before[index + 1])
        const pair = yield* parseSecretEnvFlag(value)
        yield* recordSecretEnv(pair)
        index += 2
        continue
      }
      if (token.startsWith("--secret-env=")) {
        const value = token.slice("--secret-env=".length)
        const pair = yield* parseSecretEnvFlag(value)
        yield* recordSecretEnv(pair)
        index += 1
        continue
      }
      if (token === "--cwd") {
        if (cwd !== undefined) {
          return yield* Effect.fail(usageError("--cwd was specified more than once."))
        }
        cwd = yield* requireFlagValue("--cwd", before[index + 1])
        index += 2
        continue
      }
      if (token.startsWith("--cwd=")) {
        if (cwd !== undefined) {
          return yield* Effect.fail(usageError("--cwd was specified more than once."))
        }
        cwd = token.slice("--cwd=".length)
        index += 1
        continue
      }
      if (token === "--prompt") {
        if (prompt !== undefined) {
          return yield* Effect.fail(usageError("--prompt was specified more than once."))
        }
        prompt = yield* requireFlagValue("--prompt", before[index + 1])
        index += 2
        continue
      }
      if (token.startsWith("--prompt=")) {
        if (prompt !== undefined) {
          return yield* Effect.fail(usageError("--prompt was specified more than once."))
        }
        prompt = token.slice("--prompt=".length)
        index += 1
        continue
      }
      return yield* Effect.fail(usageError(
        `firegrid:run does not recognize the option "${token}" before "--". ` +
          "Supported flags before \"--\": --secret-env NAME[=ENV_NAME], --cwd PATH, --prompt TEXT.",
      ))
    }

    return {
      agentArgv: after,
      ...(cwd === undefined ? {} : { cwd }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(envBindings.length === 0 ? {} : { envBindings }),
      ...(authorizedBindings.length === 0 ? {} : { authorizedBindings }),
    }
  })

// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.2
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.7 — cwd into the row
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8 — prompt into ingress
const runWithLayer = (config: RunConfig) =>
  Effect.gen(function* () {
    const control = yield* RuntimeControlPlaneTable
    const context = yield* runConfigToRuntimeContext(config)
    yield* control.contexts.upsert(context)
    yield* Console.log(
      `firegrid:run: launched context ${context.contextId} (${config.agentArgv.join(" ")})`,
    )

    const ingressRequest = runConfigToIngressRequest(config, context.contextId)
    if (ingressRequest !== undefined) {
      // appendRuntimeIngress fails loudly if the host config has
      // inputEnabled=false; we enable it in envHostLayer below when the
      // config carries a prompt, so this call is allowed.
      yield* appendRuntimeIngress(ingressRequest)
      yield* Console.log(
        `firegrid:run: appended initial prompt input for ${context.contextId}`,
      )
    }

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
// pair-based authorization map is derived from --secret-env flags
// exclusively; nothing else can authorize an env-binding pair.
const envPolicyLayer = (
  authorizedBindings: ReadonlyArray<readonly [string, string]>,
) =>
  Layer.succeed(
    RuntimeEnvResolverPolicy,
    RuntimeEnvResolverPolicy.make({
      authorizedBindings,
      lookupEnv: (name: string) => globalThis.process.env[name],
    }),
  )

// Construct the host layer using the existing env-driven topology, then
// overlay the env policy + a forced input flag when --prompt is given.
// The "input forced" path is what unlocks RuntimeIngressTable.inputs
// writes and stdin delivery for the sync-run scope.
const envHostLayer = (config: RunConfig) =>
  Layer.unwrapEffect(
    Effect.map(RuntimeHostTopologyFromConfig, (topology) =>
      FiregridRuntimeHostWithWorkflowLive(
        runConfigRequiresInput(config) ? { ...topology, input: true } : topology,
        envPolicyLayer(config.authorizedBindings ?? []),
      )),
  )

const programWithExitCode: Effect.Effect<number, never, never> = Effect.gen(
  function* () {
    const argv = yield* readArgv
    const raw = yield* parseCommand(argv)
    const config = yield* decodeRunConfig(raw).pipe(
      Effect.mapError((error) =>
        usageError(`firegrid:run: invalid run-config: ${ParseResult.TreeFormatter.formatErrorSync(error)}`)),
    )
    return yield* runWithLayer(config).pipe(
      Effect.provide(envHostLayer(config)),
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
