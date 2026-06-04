import { Effect, Layer, Logger } from "effect"
import { Readable, Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import {
  AcpStdioEdge,
  AcpStdioEdgeLive,
  acpPermissionPolicies,
  defaultAcpPermissionPolicy,
  type AcpPermissionPolicy,
} from "../sources/codecs/acp/stdio-edge.ts"
import { firegridNodeHost } from "../node.ts"
import {
  FiregridCliUsageError,
  resolveNodeHostOptions,
} from "./_resolve.ts"
import {
  compositionOptionsFromAgentOptions,
  decodeAgentSecretEnv,
  localJsonlRuntimeFromAgentOptions,
  parseAgentProcessCliArgs,
  type AgentProcessCliOptions,
} from "./_agent-cli.ts"
import { runFiregridBinMain } from "./_main.ts"

export interface AcpCliOptions extends AgentProcessCliOptions {
  readonly permission: AcpPermissionPolicy
}

const usage = [
  "Usage: firegrid acp [--agent NAME] [--agent-protocol acp] [--secret-env NAME[=HOST_NAME]] [--cwd PATH] [--otel-file PATH] [--permission forward|deny|allow] -- <agent-argv>",
].join("\n")

const parseArgs = (
  argv: ReadonlyArray<string>,
): Effect.Effect<AcpCliOptions, FiregridCliUsageError> =>
  parseAgentProcessCliArgs<{ permission: AcpPermissionPolicy }>({
    argv,
    usage,
    commandName: "acp",
    defaultAgentProtocol: "acp",
    allowedAgentProtocols: ["acp"],
    extra: { permission: defaultAcpPermissionPolicy },
    parseExtra: (arg, next, extra) =>
      Effect.gen(function*() {
        switch (arg) {
          case "--permission": {
            const value = yield* next()
            if (!acpPermissionPolicies.includes(value as AcpPermissionPolicy)) {
              return yield* new FiregridCliUsageError({
                message: `--permission must be one of forward, deny, allow\n${usage}`,
              })
            }
            extra.permission = value as AcpPermissionPolicy
            return 2
          }
          default:
            return 0
        }
      }),
  })

export const acpProgramFromOptions = (
  options: AcpCliOptions,
  inputStream: NodeJS.ReadStream = process.stdin,
  outputStream: NodeJS.WriteStream = process.stdout,
): Effect.Effect<void, unknown, never> =>
  Effect.gen(function*() {
    const bindings = yield* decodeAgentSecretEnv(options.secretEnv)
    const runtime = localJsonlRuntimeFromAgentOptions(options, bindings)
    const input = Readable.toWeb(inputStream) as ReadableStream<Uint8Array>
    const output = Writable.toWeb(outputStream) as WritableStream<Uint8Array>
    // The edge composition is launchable by construction (tf-0awo.21 §6): the
    // CLI composition provides every channel the edge requires (R → never) and
    // its only error — OTel acquisition — is orDie'd at its boundary in
    // `firegridNodeHost` (E → never). No `as unknown as` cast. The launchability gate
    // (acp-edge-launchable.type-test.ts) asserts the `never, never` shape.
    const edgeLayer = AcpStdioEdgeLive({
      input,
      output,
      runtime: () => runtime,
      permissionPolicy: options.permission,
    }).pipe(
      Layer.provide(
        firegridNodeHost(resolveNodeHostOptions(compositionOptionsFromAgentOptions(options, bindings))),
      ),
    )
    yield* Effect.gen(function*() {
      const edge = yield* AcpStdioEdge
      yield* edge.closed
    }).pipe(Effect.provide(edgeLayer))
  }).pipe(Effect.scoped)

export const acpProgram = (
  argv: ReadonlyArray<string>,
  inputStream: NodeJS.ReadStream = process.stdin,
  outputStream: NodeJS.WriteStream = process.stdout,
): Effect.Effect<void, unknown, never> =>
  parseArgs(argv).pipe(
    Effect.flatMap(options => acpProgramFromOptions(options, inputStream, outputStream)),
  )

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
