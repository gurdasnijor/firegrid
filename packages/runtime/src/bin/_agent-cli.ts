import {
  decodeLaunchSecretEnvCliValue,
  local,
  type LaunchSecretEnvCliBinding,
  type PublicLaunchRuntimeIntent,
  type RuntimeAgentProtocol,
} from "@firegrid/protocol/launch"
import { Effect, Either } from "effect"
import {
  FiregridCliUsageError,
  resolveFiregridCliCwd,
  type FiregridCliCompositionOptions,
} from "./_compose.ts"

export interface AgentProcessCliOptions {
  readonly agent?: string
  readonly agentProtocol: RuntimeAgentProtocol
  readonly secretEnv: ReadonlyArray<string>
  readonly cwd?: string
  readonly otelFile?: string
  readonly agentArgv: ReadonlyArray<string>
}

interface MutableAgentProcessCliOptions {
  agent?: string
  agentProtocol: RuntimeAgentProtocol
  secretEnv: Array<string>
  cwd?: string
  otelFile?: string
}

interface ParseAgentProcessCliArgsOptions<A extends object> {
  readonly argv: ReadonlyArray<string>
  readonly usage: string
  readonly commandName: string
  readonly defaultAgentProtocol: RuntimeAgentProtocol
  readonly allowedAgentProtocols: ReadonlyArray<RuntimeAgentProtocol>
  readonly extra: A
  readonly parseExtra?: (
    arg: string,
    next: () => Effect.Effect<string, FiregridCliUsageError>,
    extra: A,
  ) => Effect.Effect<number, FiregridCliUsageError>
}

const flagNeedsValue = (flag: string, usage: string): FiregridCliUsageError =>
  new FiregridCliUsageError({ message: `${flag} expects a value\n${usage}` })

const isAllowedProtocol = (
  value: string,
  allowed: ReadonlyArray<RuntimeAgentProtocol>,
): value is RuntimeAgentProtocol =>
  allowed.some(protocol => protocol === value)

const protocolList = (values: ReadonlyArray<RuntimeAgentProtocol>): string =>
  values.join(", ")

export const parseAgentProcessCliArgs = <A extends object>({
  argv,
  usage,
  commandName,
  defaultAgentProtocol,
  allowedAgentProtocols,
  extra,
  parseExtra,
}: ParseAgentProcessCliArgsOptions<A>): Effect.Effect<AgentProcessCliOptions & A, FiregridCliUsageError> =>
  Effect.gen(function*() {
    const state: MutableAgentProcessCliOptions = {
      agentProtocol: defaultAgentProtocol,
      secretEnv: [],
    }
    let index = 0
    while (index < argv.length) {
      const arg = argv[index]!
      if (arg === "--") {
        const agentArgv = argv.slice(index + 1)
        if (agentArgv.length === 0) {
          return yield* new FiregridCliUsageError({
            message: `agent argv after -- must be non-empty\n${usage}`,
          })
        }
        const resolvedCwd = resolveFiregridCliCwd(state.cwd)
        return {
          ...(state.agent === undefined ? {} : { agent: state.agent }),
          agentProtocol: state.agentProtocol,
          secretEnv: state.secretEnv,
          ...(resolvedCwd === undefined ? {} : { cwd: resolvedCwd }),
          ...(state.otelFile === undefined ? {} : { otelFile: state.otelFile }),
          agentArgv,
          ...extra,
        }
      }

      const next = (): Effect.Effect<string, FiregridCliUsageError> =>
        index + 1 >= argv.length
          ? Effect.fail(flagNeedsValue(arg, usage))
          : Effect.succeed(argv[index + 1]!)

      switch (arg) {
        case "--agent":
          state.agent = yield* next()
          index += 2
          break
        case "--agent-protocol": {
          const value = yield* next()
          if (!isAllowedProtocol(value, allowedAgentProtocols)) {
            return yield* new FiregridCliUsageError({
              message:
                `--agent-protocol must be one of ${protocolList(allowedAgentProtocols)}\n${usage}`,
            })
          }
          state.agentProtocol = value
          index += 2
          break
        }
        case "--secret-env":
          state.secretEnv.push(yield* next())
          index += 2
          break
        case "--cwd":
          state.cwd = yield* next()
          index += 2
          break
        case "--otel-file":
          state.otelFile = yield* next()
          index += 2
          break
        case "--help":
        case "-h":
          return yield* new FiregridCliUsageError({ message: usage })
        default: {
          const step = parseExtra === undefined ? 0 : yield* parseExtra(arg, next, extra)
          if (step > 0) {
            index += step
            break
          }
          return yield* new FiregridCliUsageError({
            message: `unknown firegrid ${commandName} argument: ${arg}\n${usage}`,
          })
        }
      }
    }

    return yield* new FiregridCliUsageError({
      message: `missing -- <agent-argv>\n${usage}`,
    })
  })

export const decodeAgentSecretEnv = (
  values: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<LaunchSecretEnvCliBinding>, FiregridCliUsageError> =>
  Effect.forEach(values, (value) =>
    Either.match(decodeLaunchSecretEnvCliValue(value), {
      onLeft: (message) =>
        Effect.fail(new FiregridCliUsageError({ message })),
      onRight: Effect.succeed,
    }))

export const localJsonlRuntimeFromAgentOptions = (
  options: AgentProcessCliOptions,
  bindings: ReadonlyArray<LaunchSecretEnvCliBinding>,
): PublicLaunchRuntimeIntent =>
  local.jsonl({
    argv: [...options.agentArgv],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    agentProtocol: options.agentProtocol,
    envBindings: bindings.map(binding => binding.envBinding),
    runtimeContextMcp: { enabled: true },
  })

export const compositionOptionsFromAgentOptions = (
  options: Pick<AgentProcessCliOptions, "cwd" | "otelFile">,
  bindings: ReadonlyArray<LaunchSecretEnvCliBinding>,
): FiregridCliCompositionOptions => ({
  ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  ...(options.otelFile === undefined ? {} : { otelFile: options.otelFile }),
  authorizedBindings: bindings.map(binding => binding.authorizedBinding),
})
