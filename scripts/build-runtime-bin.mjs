import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const binDir = resolve(import.meta.dirname, "..", "packages", "runtime", "dist", "bin")
const binPath = resolve(binDir, "firegrid.js")

mkdirSync(binDir, { recursive: true })

writeFileSync(
  binPath,
  `#!/usr/bin/env node
import { Terminal } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Config, Data, Effect } from "effect"
import { FiregridRuntime, FiregridRuntimeBoot } from "../index.js"

class UsageError extends Data.TaggedError("firegrid/UsageError") {}

const writeStdout = (line) =>
  Effect.flatMap(Terminal.Terminal, (terminal) =>
    terminal.display(\`\${line}\\n\`),
  )

const streamUrlFromConfig = Config.string("DURABLE_STREAMS_URL").pipe(
  Config.validate({
    message: "DURABLE_STREAMS_URL must not be empty",
    validation: (value) => value.length > 0,
  }),
)

const runAttached = Effect.scoped(
  Effect.gen(function* () {
    const streamUrl = yield* streamUrlFromConfig
    const runtimeLayer = FiregridRuntimeBoot.attached({ streamUrl })

    return yield* Effect.gen(function* () {
      const runtime = yield* FiregridRuntime
      yield* writeStdout(runtime.streamIdentity.streamUrl)
      yield* writeStdout(
        \`firegrid runtime ready (\${runtime.bootMode}); Ctrl-C to stop\`,
      )
      return yield* Effect.never
    }).pipe(Effect.provide(runtimeLayer))
  }),
)

const program = Effect.gen(function* () {
  const args = process.argv.slice(2)
  if (args.length > 0) {
    yield* writeStdout("usage: DURABLE_STREAMS_URL=<url> firegrid")
    return yield* new UsageError({
      message: "firegrid has no dev-server launcher subcommands",
    })
  }

  return yield* runAttached
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))
`,
)

chmodSync(binPath, 0o755)
