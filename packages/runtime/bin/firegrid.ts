#!/usr/bin/env tsx
import { Terminal } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Config, Effect } from "effect"

const write = (line: string) =>
  Effect.flatMap(Terminal.Terminal, (terminal) =>
    terminal.display(`${line}\n`),
  )

const streamUrl = Config.string("DURABLE_STREAMS_URL").pipe(
  Config.validate({
    message: "DURABLE_STREAMS_URL must not be empty",
    validation: (value) => value.length > 0,
  }),
)

const program = Effect.gen(function* () {
  if (process.argv.slice(2).length > 0) {
    yield* write("usage: DURABLE_STREAMS_URL=<url> firegrid")
    return
  }

  const url = yield* streamUrl
  yield* write(url)
  yield* write("firegrid durable stream ready; Ctrl-C to stop")
  return yield* Effect.never
}) satisfies Effect.Effect<void, unknown, Terminal.Terminal>

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))
