#!/usr/bin/env tsx
import { Terminal } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Option, Redacted } from "effect"

type RuntimeMode = "dev" | "prod"

interface LaunchConfig {
  readonly mode: RuntimeMode
  readonly streamUrl: Redacted.Redacted<string>
}

class CliUsageError extends Error {
  readonly _tag = "CliUsageError"
}

const streamUrlFromEnv = Config.option(Config.redacted("DURABLE_STREAMS_URL"))

const usage = [
  "usage: firegrid <command> [options]",
  "",
  "commands:",
  "  run       Validate attached runtime config and keep the process alive.",
  "  config    Print the resolved attached runtime config.",
  "  dev       Alias for: run --mode dev.",
  "  prod      Alias for: run --mode prod.",
  "",
  "options:",
  "  --mode <dev|prod>        Runtime config profile. Defaults to prod.",
  "  --stream-url <url>       Durable Streams URL. Overrides DURABLE_STREAMS_URL.",
  "",
  "env:",
  "  DURABLE_STREAMS_URL      Durable Streams URL for attached mode.",
].join("\n")

const write = (line: string) =>
  Effect.flatMap(Terminal.Terminal, (terminal) => terminal.display(`${line}\n`))

const failUsage = (message: string) =>
  Effect.fail(new CliUsageError(`${message}\n\n${usage}`))

const parseMode = (value: string | undefined): Effect.Effect<RuntimeMode, CliUsageError> => {
  if (value === undefined) return Effect.succeed("prod")
  if (value === "dev" || value === "prod") return Effect.succeed(value)
  return failUsage(`invalid --mode: ${value}`)
}

const parseArgs = (
  argv: ReadonlyArray<string>,
): Effect.Effect<{ readonly command: string; readonly mode: RuntimeMode; readonly streamUrl?: string }, CliUsageError> =>
  Effect.gen(function* () {
    const command = argv[0] ?? "run"
    let modeArg: string | undefined
    let streamUrl: string | undefined

    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index]
      switch (arg) {
        case "--mode": {
          const value = argv[index + 1]
          if (value === undefined) return yield* failUsage("--mode requires a value")
          modeArg = value
          index += 1
          break
        }
        case "--stream-url": {
          const value = argv[index + 1]
          if (value === undefined) return yield* failUsage("--stream-url requires a value")
          streamUrl = value
          index += 1
          break
        }
        default:
          return yield* failUsage(`unknown option: ${arg}`)
      }
    }

    const mode = command === "dev" ? "dev" : command === "prod" ? "prod" : yield* parseMode(modeArg)
    return { command, mode, ...(streamUrl !== undefined ? { streamUrl } : {}) }
  })

const resolveLaunchConfig = (
  args: { readonly mode: RuntimeMode; readonly streamUrl?: string },
) =>
  Effect.gen(function* () {
    if (args.streamUrl !== undefined && args.streamUrl.length > 0) {
      return {
        mode: args.mode,
        streamUrl: Redacted.make(args.streamUrl),
      }
    }
    const envUrl = yield* streamUrlFromEnv
    if (Option.isSome(envUrl)) {
      return {
        mode: args.mode,
        streamUrl: envUrl.value,
      }
    }
    return yield* failUsage("attached mode requires --stream-url or DURABLE_STREAMS_URL")
  })

const printConfig = (config: LaunchConfig) =>
  Effect.gen(function* () {
    yield* write(`mode:       ${config.mode}`)
    yield* write(`streamUrl:  ${Redacted.value(config.streamUrl)}`)
  })

const runCommand = (config: LaunchConfig) =>
  Effect.gen(function* () {
    yield* printConfig(config)
    yield* write("firegrid runtime launch boundary ready")
    yield* write("runtime graph execution will be attached here by DurableStreamsWorkflowEngine.layer")
    return yield* Effect.never
  })

const program = Effect.gen(function* () {
  const parsed = yield* parseArgs(process.argv.slice(2))
  switch (parsed.command) {
    case "run":
    case "dev":
    case "prod":
      return yield* runCommand(yield* resolveLaunchConfig(parsed))
    case "config":
      return yield* printConfig(yield* resolveLaunchConfig(parsed))
    case "help":
    case "--help":
    case "-h":
      return yield* write(usage)
    default:
      return yield* failUsage(`unknown command: ${parsed.command}`)
  }
})

NodeRuntime.runMain(
  program.pipe(Effect.provide(NodeContext.layer)),
)
