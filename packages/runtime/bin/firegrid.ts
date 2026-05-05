#!/usr/bin/env tsx
import { Command, CommandExecutor, Terminal } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { FiregridRuntime, FiregridRuntimeBoot } from "../src/index.ts"

// firegrid-runtime-process.RUNTIME_PACKAGE.1
// firegrid-runtime-process.BINARIES.1
// firegrid-runtime-process.BINARIES.2
// firegrid-runtime-process.BINARIES.3
// firegrid-runtime-process.BINARIES.4
// firegrid-runtime-process.BINARIES.5
// firegrid-runtime-process.BINARIES.6
// firegrid-runtime-process.DEV_ENV_INJECTION.1
// firegrid-runtime-process.DEV_ENV_INJECTION.2
// firegrid-runtime-process.DEV_ENV_INJECTION.3
// firegrid-runtime-process.DEV_ENV_INJECTION.4
// firegrid-runtime-process.DEV_ENV_INJECTION.5
// firegrid-runtime-process.DEV_ENV_INJECTION.6
// firegrid-runtime-process.EFFECT_PLATFORM.1
// firegrid-runtime-process.EFFECT_PLATFORM.2
// firegrid-runtime-process.EFFECT_PLATFORM.3
// firegrid-runtime-process.EFFECT_PLATFORM.4
// firegrid-runtime-process.EFFECT_PLATFORM.5
// firegrid-runtime-process.CONFIG_SURFACE.1
// firegrid-runtime-process.CONFIG_SURFACE.3
// firegrid-runtime-process.CONFIG_SURFACE.5
//
// `firegrid` (and the short alias `fg`) is the runtime process
// binary. Two subcommands:
//
//   firegrid                       Attached when DURABLE_STREAMS_URL
//                                  is set; otherwise embedded-dev.
//                                  Blocks until SIGINT/SIGTERM.
//
//   firegrid dev -- <command...>   Always embedded-dev. Boots a
//                                  DurableStreamTestServer, resolves
//                                  the actual stream URL (including
//                                  OS-assigned port), spawns the
//                                  child via @effect/platform Command,
//                                  injects DURABLE_STREAMS_URL and
//                                  VITE_DURABLE_STREAMS_URL into
//                                  the child env, inherits stdio,
//                                  and tears down the embedded
//                                  server when the child exits.

interface ParsedArgs {
  readonly subcommand: "default" | "dev"
  readonly child: ReadonlyArray<string>
}

const parseArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  if (argv[0] !== "dev") {
    return { subcommand: "default", child: [] }
  }
  const dashDash = argv.indexOf("--", 1)
  if (dashDash === -1) {
    return { subcommand: "dev", child: [] }
  }
  return { subcommand: "dev", child: argv.slice(dashDash + 1) }
}

const writeStdout = (line: string) =>
  Effect.flatMap(Terminal.Terminal, (terminal) =>
    terminal.display(`${line}\n`),
  )

const runDefault = Effect.scoped(
  Effect.gen(function* () {
    const attachedUrl = process.env["DURABLE_STREAMS_URL"]
    const runtimeLayer =
      attachedUrl !== undefined && attachedUrl.length > 0
        ? FiregridRuntimeBoot.attached({ streamUrl: attachedUrl })
        : FiregridRuntimeBoot.embeddedDev({ streamName: "firegrid" })

    yield* Effect.gen(function* () {
      const runtime = yield* FiregridRuntime
      yield* writeStdout(runtime.streamIdentity.streamUrl)
      yield* writeStdout(
        `firegrid runtime ready (${runtime.bootMode}); Ctrl-C to stop`,
      )
      yield* Effect.never
    }).pipe(Effect.provide(runtimeLayer))
  }),
)

const runDev = (childArgs: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (childArgs.length === 0) {
        yield* writeStdout(
          "usage: firegrid dev -- <command...>",
        )
        yield* writeStdout(
          "  Boots embedded Durable Streams and runs <command> with",
        )
        yield* writeStdout(
          "  DURABLE_STREAMS_URL + VITE_DURABLE_STREAMS_URL injected.",
        )
        return
      }

      const runtimeLayer = FiregridRuntimeBoot.embeddedDev({
        streamName: "firegrid",
      })

      yield* Effect.gen(function* () {
        const runtime = yield* FiregridRuntime
        const streamUrl = runtime.streamIdentity.streamUrl

        yield* writeStdout(streamUrl)
        yield* writeStdout(
          "firegrid dev: embedded Durable Streams ready; spawning child",
        )

        const [head, ...rest] = childArgs as readonly [
          string,
          ...ReadonlyArray<string>,
        ]
        const command = Command.make(head, ...rest).pipe(
          Command.env({
            DURABLE_STREAMS_URL: streamUrl,
            VITE_DURABLE_STREAMS_URL: streamUrl,
          }),
          Command.stdin("inherit"),
          Command.stdout("inherit"),
          Command.stderr("inherit"),
        )

        const exitCode = yield* Command.exitCode(command)
        if (exitCode !== 0) {
          yield* Effect.fail(
            new Error(`child exited with code ${exitCode}`),
          )
        }
      }).pipe(Effect.provide(runtimeLayer))
    }),
  )

const program = Effect.gen(function* () {
  const args = parseArgs(process.argv.slice(2))
  if (args.subcommand === "dev") {
    yield* runDev(args.child)
  } else {
    yield* runDefault
  }
}) satisfies Effect.Effect<
  void,
  unknown,
  Terminal.Terminal | CommandExecutor.CommandExecutor
>

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))
