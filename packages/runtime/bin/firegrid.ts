#!/usr/bin/env tsx
import { Terminal } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Config, Duration, Effect, Schedule } from "effect"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/client"
import {
  clockLayer,
  DurableClock,
  DurableClockStoreError,
  makeDurableStreamClockStore,
} from "../src/durable-clock/durable-clock.ts"

// ============================================================================
// Config
// ============================================================================

const streamUrl = Config.string("DURABLE_STREAMS_URL").pipe(
  Config.validate({
    message: "DURABLE_STREAMS_URL must not be empty",
    validation: (value) => value.length > 0,
  }),
)

const scope = Config.string("FIREGRID_SCOPE").pipe(Config.withDefault("default"))

// How often the wall-clock driver ticks the durable clock forward. Each tick
// is a durable write, so don't crank this; 1s is fine for most agent
// workloads. Pure timer-driven applications can lower it.
const tickIntervalMs = Config.integer("FIREGRID_TICK_INTERVAL_MS").pipe(
  Config.withDefault(1_000),
)

// ============================================================================
// Helpers
// ============================================================================

const write = (line: string) =>
  Effect.flatMap(Terminal.Terminal, (terminal) => terminal.display(`${line}\n`))

// ============================================================================
// Wall-clock driver
// ============================================================================
//
// Drives the durable clock forward in real time. Forked into the layer's
// scope so it dies when the layer closes. Each iteration:
//   1. Read OS time.
//   2. Compute delta from durable nowMs.
//   3. If delta > 0, call advance(delta).
//
// `advance` itself persists the new tick + fires due wakeups, so a single
// schedule-based loop is sufficient. We use a fixed schedule rather than
// drift-correcting because the durable clock's source of truth is the log,
// not the OS.

const wallClockDriver = (intervalMs: number) =>
  Effect.gen(function* () {
    const dispatcher = yield* DurableClock
    const step = Effect.gen(function* () {
      const osNow = Date.now()
      const durableNow = yield* dispatcher.nowMs
      const delta = osNow - durableNow
      if (delta > 0) {
        yield* dispatcher.advance(delta).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning("wall-clock driver advance failed").pipe(
              Effect.annotateLogs({ cause: String(e.cause) }),
            ),
          ),
        )
      }
    })
    yield* Effect.repeat(
      step,
      Schedule.spaced(Duration.millis(intervalMs)),
    )
  })

// ============================================================================
// Subcommands
// ============================================================================

const usage = [
  "usage: firegrid <command>",
  "",
  "commands:",
  "  run     Boot the durable clock and stay alive until SIGINT.",
  "  status  Print the current durable nowMs and pending wakeup count, then exit.",
  "",
  "env:",
  "  DURABLE_STREAMS_URL       (required) Stream URL to back the clock log.",
  "  FIREGRID_SCOPE            (default: default) Scope key in the log.",
  "  FIREGRID_TICK_INTERVAL_MS (default: 1000) Wall-clock driver interval.",
].join("\n")

const acquireStore = (streamUrl: string) =>
  Effect.acquireRelease(
    makeDurableStreamClockStore({ streamUrl }),
    (store) => store.close,
  )

const devCommand = Effect.gen(function* () {
  const scopeName = yield* scope
  const interval = yield* tickIntervalMs
  const port = 4437

  const server = yield* Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const s = new DurableStreamTestServer({ port, host: "127.0.0.1" })
      await s.start()
      return s
    }),
    (s) => Effect.promise(() => s.stop()),
  )

  const streamUrl = `${server.url}/v1/stream/firegrid-${scopeName}`

  yield* Effect.tryPromise(async () =>
    await DurableStream.create({
      url: streamUrl,
      contentType: "application/json",
    }),
  ).pipe(Effect.ignore)

  yield* write(`firegrid dev: server on ${server.url}`)
  yield* write(`firegrid dev: stream ${streamUrl}`)

  const store = yield* acquireStore(streamUrl)
  const initialDurableTimeMs = Date.now()

  const main = Effect.gen(function* () {
    yield* write(`firegrid dev: clock ready (scope=${scopeName})`)
    yield* Effect.forkScoped(wallClockDriver(interval))
    return yield* Effect.never
  })

  return yield* main.pipe(
    Effect.provide(
      clockLayer({ store, scope: scopeName, initialDurableTimeMs }),
    ),
  )
})

const runCommand = Effect.gen(function* () {
  const url = yield* streamUrl
  const scopeName = yield* scope
  const interval = yield* tickIntervalMs

  const store = yield* acquireStore(url)

  // initialDurableTimeMs only matters on first boot for this scope. After
  // the first run, recovery reads nowMs from the durable log.
  const initialDurableTimeMs = Date.now()

  const program = Effect.gen(function* () {
    yield* write(`firegrid: clock ready (scope=${scopeName})`)
    yield* write(`firegrid: wall-clock driver running every ${interval}ms`)
    yield* write("firegrid: Ctrl-C to stop")
    yield* Effect.forkScoped(wallClockDriver(interval))
    return yield* Effect.never
  })

  return yield* program.pipe(
    Effect.provide(
      clockLayer({ store, scope: scopeName, initialDurableTimeMs }),
    ),
  )
})

const statusCommand = Effect.gen(function* () {
  const url = yield* streamUrl
  const scopeName = yield* scope

  const store = yield* acquireStore(url)

  const tick = yield* store.latestTick(scopeName)
  const wakeups = yield* store.snapshot(scopeName)
  const pending = wakeups.filter((w) => w.status === "pending").length
  const dispatched = wakeups.filter((w) => w.status === "dispatched").length
  const cancelled = wakeups.filter((w) => w.status === "cancelled").length

  yield* write(`scope:      ${scopeName}`)
  yield* write(`durableNow: ${tick?.nowMs ?? "(uninitialized)"}`)
  yield* write(`wakeups:    ${wakeups.length} total`)
  yield* write(`            ${pending} pending`)
  yield* write(`            ${dispatched} dispatched`)
  yield* write(`            ${cancelled} cancelled`)
})

// ============================================================================
// Entrypoint
// ============================================================================

const program = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case "run":
      return yield* runCommand
    case "dev":                      // <-- add this
      return yield* devCommand
    case "status":
      return yield* statusCommand
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return yield* write(usage)
    default:
      yield* write(`unknown command: ${command}`)
      yield* write(usage)
      return yield* new DurableClockStoreError({ op: "unknownCommand", cause: command })
  }
})

NodeRuntime.runMain(
  Effect.scoped(program).pipe(Effect.provide(NodeContext.layer)),
)
