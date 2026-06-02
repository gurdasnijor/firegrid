import { local, decodeLaunchSecretEnvCliValue, type RuntimeAgentProtocol } from "@firegrid/protocol/launch"
import { Context, Effect, Either, Layer, Logger } from "effect"
import { Readable, Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import {
  AcpStdioEdge,
  AcpStdioEdgeLive,
  acpPermissionPolicies,
  defaultAcpPermissionPolicy,
  type AcpPermissionPolicy,
} from "../sources/codecs/acp/stdio-edge.ts"
import {
  FiregridCliCompositionLive,
  FiregridCliUsageError,
  resolveFiregridCliCwd,
} from "./_compose.ts"
import { runFiregridBinMain } from "./_main.ts"

interface AcpCliOptions {
  readonly agent?: string
  readonly agentProtocol: RuntimeAgentProtocol
  readonly secretEnv: ReadonlyArray<string>
  readonly cwd?: string
  readonly otelFile?: string
  readonly permission: AcpPermissionPolicy
  readonly agentArgv: ReadonlyArray<string>
}

const usage = [
  "Usage: firegrid acp [--agent NAME] [--agent-protocol acp] [--secret-env NAME[=HOST_NAME]] [--cwd PATH] [--otel-file PATH] [--permission forward|deny|allow] -- <agent-argv>",
].join("\n")

const flagNeedsValue = (flag: string): FiregridCliUsageError =>
  new FiregridCliUsageError({ message: `${flag} expects a value\n${usage}` })

const parseArgs = (
  argv: ReadonlyArray<string>,
): Effect.Effect<AcpCliOptions, FiregridCliUsageError> =>
  Effect.gen(function*() {
    const secretEnv: Array<string> = []
    let agent: string | undefined
    let agentProtocol: RuntimeAgentProtocol = "acp"
    let cwd: string | undefined
    let otelFile: string | undefined
    let permission: AcpPermissionPolicy = defaultAcpPermissionPolicy
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
        const resolvedCwd = resolveFiregridCliCwd(cwd)
        return {
          ...(agent === undefined ? {} : { agent }),
          agentProtocol,
          secretEnv,
          ...(resolvedCwd === undefined ? {} : { cwd: resolvedCwd }),
          ...(otelFile === undefined ? {} : { otelFile }),
          permission,
          agentArgv,
        }
      }
      const next = (): Effect.Effect<string, FiregridCliUsageError> =>
        index + 1 >= argv.length
          ? Effect.fail(flagNeedsValue(arg))
          : Effect.succeed(argv[index + 1]!)
      switch (arg) {
        case "--agent":
          agent = yield* next()
          index += 2
          break
        case "--agent-protocol": {
          const value = yield* next()
          if (value !== "acp") {
            return yield* new FiregridCliUsageError({
              message: `--agent-protocol must be acp for firegrid acp\n${usage}`,
            })
          }
          agentProtocol = value
          index += 2
          break
        }
        case "--secret-env":
          secretEnv.push(yield* next())
          index += 2
          break
        case "--cwd":
          cwd = yield* next()
          index += 2
          break
        case "--otel-file":
          otelFile = yield* next()
          index += 2
          break
        case "--permission": {
          const value = yield* next()
          if (!acpPermissionPolicies.includes(value as AcpPermissionPolicy)) {
            return yield* new FiregridCliUsageError({
              message: `--permission must be one of forward, deny, allow\n${usage}`,
            })
          }
          permission = value as AcpPermissionPolicy
          index += 2
          break
        }
        case "--help":
        case "-h":
          return yield* new FiregridCliUsageError({ message: usage })
        default:
          return yield* new FiregridCliUsageError({
            message: `unknown firegrid acp argument: ${arg}\n${usage}`,
          })
      }
    }
    return yield* new FiregridCliUsageError({
      message: `missing -- <agent-argv>\n${usage}`,
    })
  })

const decodeSecretEnv = (values: ReadonlyArray<string>) =>
  Effect.forEach(values, (value) =>
    Either.match(decodeLaunchSecretEnvCliValue(value), {
      onLeft: (message) =>
        Effect.fail(new FiregridCliUsageError({ message })),
      onRight: Effect.succeed,
    }))

export const acpProgram = (
  argv: ReadonlyArray<string>,
  inputStream: NodeJS.ReadStream = process.stdin,
  outputStream: NodeJS.WriteStream = process.stdout,
): Effect.Effect<void, unknown, never> =>
  Effect.gen(function*() {
    const options = yield* parseArgs(argv)
    const bindings = yield* decodeSecretEnv(options.secretEnv)
    const runtime = local.jsonl({
      argv: [...options.agentArgv],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      agentProtocol: options.agentProtocol,
      envBindings: bindings.map(binding => binding.envBinding),
      runtimeContextMcp: { enabled: true },
    })
    const input = Readable.toWeb(inputStream) as ReadableStream<Uint8Array>
    const output = Writable.toWeb(outputStream) as WritableStream<Uint8Array>
    const layer = AcpStdioEdgeLive({
      input,
      output,
      runtime: () => runtime,
      permissionPolicy: options.permission,
    }).pipe(
      Layer.provideMerge(
        FiregridCliCompositionLive({
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.otelFile === undefined ? {} : { otelFile: options.otelFile }),
          authorizedBindings: bindings.map(binding => binding.authorizedBinding),
        }),
      ),
    ) as unknown as Layer.Layer<AcpStdioEdge, unknown, never>
    const services = yield* Layer.build(layer)
    const edge = Context.get(services, AcpStdioEdge)
    yield* edge.closed
  }).pipe(Effect.scoped)

export const runAcpMain = (
  argv: ReadonlyArray<string> = process.argv.slice(2),
): void => {
  runFiregridBinMain(
    acpProgram(argv).pipe(
      Effect.provide(Logger.replace(Logger.defaultLogger, Logger.none)),
    ),
  )
}

const isDirectRun = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  runAcpMain()
}
