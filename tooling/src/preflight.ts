// firegrid-quality-gates.PREFLIGHT.1
//
// Local PR preflight runner. Runs every gate, keeps going after failures, and
// reports each failing gate's captured output in one pass.
//
// Gates run over a weighted Semaphore (heavy gates cost more permits) scheduled
// longest-first, so wall-clock time approaches the optimal makespan rather than
// sum(gate). A forked reporter fiber drains a Queue of gate events to give live
// start/finish feedback while full output is buffered (bounded tail) for replay.

// Dependency guard. `pnpm preflight` delegates to this runner; in a fresh
// worktree without node_modules the @effect/* imports below would throw
// ERR_MODULE_NOT_FOUND before any of our code runs, surfacing as a cryptic pnpm
// ELIFECYCLE + a buried "node_modules missing" WARN. ESM resolves static imports
// before module evaluation, so the check must run first with builtins only and
// the runtime libraries must be loaded AFTER it via dynamic import(). (task-enter.sh
// installs on worktree creation; this covers the paths that bypass it.)
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type * as EffectNS from "effect"

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "../..")
const missingDeps = ["node_modules", "tooling/node_modules"].filter(
  (rel) => !existsSync(join(workspaceRoot, rel)),
)
if (missingDeps.length > 0) {
  process.stderr.write(
    `\npreflight: dependencies are not installed (missing: ${missingDeps.join(", ")}).\n` +
      `Run \`pnpm install\` in this worktree, then re-run \`pnpm preflight\`.\n\n`,
  )
  process.exit(1)
}

// Deps confirmed present — load the runtime libraries now. Deferred via dynamic
// import() so the guard above runs first (static imports would be hoisted).
const { Command } = await import("@effect/platform")
const { NodeContext, NodeRuntime } = await import("@effect/platform-node")
const { Console, Data, Effect, Fiber, Queue, Ref, Stream } = await import("effect")

// Grandchild workers (e.g. tinypool under vitest) can still be writing to a
// stdio pipe at the moment a gate's scope tears the child process down. That
// surfaces as a raw EPIPE rejection *outside* any fiber, so the per-stream
// catch below can't always reach it. Swallow EPIPE specifically; rethrow the
// rest so real bugs still crash loudly.
process.on("unhandledRejection", (reason) => {
  if ((reason as NodeJS.ErrnoException | undefined)?.code === "EPIPE") return
  throw reason
})

// weight = permits a gate consumes from the pool. The CPU-bound long poles get
// 2; everything else is light. Keep weight <= pool capacity (enforced below).
const gates = [
  { script: "test", description: "Workspace test suite", weight: 2 },
  { script: "typecheck", description: "TypeScript project references", weight: 2 },
  { script: "effect:diagnostics", description: "Effect language service diagnostics", weight: 2 },
  { script: "lint", description: "ESLint", weight: 1 },
  { script: "lint:dead", description: "Knip dead-code gate (strict-0)", weight: 1 },
  { script: "lint:dup", description: "jscpd duplicate-code gate (strict-0)", weight: 1 },
  { script: "lint:deps", description: "Dependency cruiser boundaries", weight: 1 },
  { script: "trace:seams:ukv", description: "UKV production trace seam gate", weight: 1 },
] as const

// Tag each gate with its declared position so the summary can restore the
// authored order even though we schedule heaviest-first.
const declared = gates.map((g, order) => ({ ...g, order }))
// Longest-processing-time-first: start the heavy gates in the first wave and
// let the light ones backfill around them.
const schedule = [...declared].sort((a, b) => b.weight - a.weight || a.order - b.order)

const requested = Number(process.env.PREFLIGHT_CONCURRENCY) || 4
const maxWeight = Math.max(...declared.map((g) => g.weight))
// withPermits(n) deadlocks if n exceeds total capacity, so floor the pool at
// the heaviest single gate.
const capacity = Math.max(requested, maxWeight)

const TAIL_LINES = 40

type GateEvent = EffectNS.Data.TaggedEnum<{
  Started: { readonly script: string }
  Finished: {
    readonly script: string
    readonly ok: boolean
    readonly ms: number
    readonly lines: number
  }
}>
const GateEvent = Data.taggedEnum<GateEvent>()

class GateResult extends Data.Class<{
  readonly script: string
  readonly description: string
  readonly order: number
  readonly ok: boolean
  readonly detail: string // exit code or spawn-error message
  readonly ms: number
  readonly tail: string // last TAIL_LINES of combined output, replayed on failure
}> {}

// Failing gates aren't a crash — this only exists to set a non-zero exit code.
class PreflightFailed extends Data.TaggedError("PreflightFailed")<{
  readonly count: number
}> {}

const render = (event: GateEvent) => {
  switch (event._tag) {
    case "Started":
      return Console.log(`▶  ${event.script}`)
    case "Finished": {
      const secs = (event.ms / 1000).toFixed(1)
      return Console.log(
        `${event.ok ? "✓" : "✗"}  ${event.script}  (${secs}s, ${event.lines} lines)`,
      )
    }
  }
}

const runGate = (
  events: EffectNS.Queue.Queue<GateEvent>,
  gate: (typeof schedule)[number],
) =>
  Effect.gen(function* () {
    yield* Queue.offer(events, GateEvent.Started({ script: gate.script }))
    const startedAt = yield* Effect.sync(() => Date.now())

    // Command inherits the parent process env by default. `-w` runs the ROOT
    // workspace script (this runner lives in the `tooling` package) and sets
    // cwd to the workspace root, which the gate scripts assume.
    const proc = yield* Command.start(Command.make("pnpm", "-w", "run", gate.script))

    // Bounded tail + line count instead of accumulating the whole log: a 10k
    // line failure stays cheap, and we get a free progress metric.
    const buf = yield* Ref.make({ count: 0, tail: [] as ReadonlyArray<string> })

    const drain = Stream.merge(proc.stdout, proc.stderr).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      // Defense-in-depth for the EPIPE-on-teardown case (see top-level guard).
      Stream.catchAllCause(() => Stream.empty),
      Stream.runForEach((line) =>
        Ref.update(buf, (s) => ({
          count: s.count + 1,
          tail: [...s.tail, line].slice(-TAIL_LINES),
        })),
      ),
    )

    // exitCode only resolves once the pipes drain, so run both together or the
    // child can block on a full stdout buffer.
    const [exitCode] = yield* Effect.all([proc.exitCode, drain], { concurrency: 2 })

    const { count, tail } = yield* Ref.get(buf)
    const ms = (yield* Effect.sync(() => Date.now())) - startedAt
    const ok = Number(exitCode) === 0

    yield* Queue.offer(
      events,
      GateEvent.Finished({ script: gate.script, ok, ms, lines: count }),
    )

    return new GateResult({
      script: gate.script,
      description: gate.description,
      order: gate.order,
      ok,
      detail: ok ? "ok" : `exit ${Number(exitCode)}`,
      ms,
      tail: tail.join("\n"),
    })
  }).pipe(
    Effect.scoped, // bound the running process to this gate's lifetime
    // A PlatformError means the process couldn't even spawn (e.g. pnpm missing).
    // Treat it as a failing gate instead of tearing down the whole pool.
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        yield* Queue.offer(
          events,
          GateEvent.Finished({ script: gate.script, ok: false, ms: 0, lines: 0 }),
        )
        return new GateResult({
          script: gate.script,
          description: gate.description,
          order: gate.order,
          ok: false,
          detail: error.message,
          ms: 0,
          tail: "",
        })
      }),
    ),
  )

const preflight = Effect.gen(function* () {
  // Reporter fiber drains the event queue independently of gate execution, so
  // ▶/✓/✗ lines stream out as gates actually start and finish.
  const events = yield* Queue.unbounded<GateEvent>()
  const reporter = yield* Stream.fromQueue(events).pipe(
    Stream.runForEach(render),
    Effect.fork,
  )

  yield* Console.log(`Running ${gates.length} gates (pool=${capacity})\n`)

  const pool = yield* Effect.makeSemaphore(capacity)
  // concurrency: "unbounded" forks every gate immediately; the semaphore is the
  // real limiter, weighting heavy gates so at most ~capacity permits are in use.
  const results = yield* Effect.forEach(
    schedule,
    (gate) => pool.withPermits(gate.weight)(runGate(events, gate)),
    { concurrency: "unbounded" },
  )

  // No more events coming; let the reporter finish, then continue.
  yield* Queue.shutdown(events)
  yield* Fiber.join(reporter)

  const ordered = [...results].sort((a, b) => a.order - b.order)
  const failures = ordered.filter((r) => !r.ok)

  // Timing table: shows where the preflight budget actually went.
  yield* Console.log("\n== timing (slowest first) ==")
  yield* Effect.forEach(
    [...ordered].sort((a, b) => b.ms - a.ms),
    (r) =>
      Console.log(
        `  ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.ok ? " " : "✗"} ${r.script}`,
      ),
  )

  if (failures.length === 0) {
    yield* Console.log("\nAll gates passed.")
    return
  }

  yield* Effect.forEach(failures, (f) =>
    Effect.gen(function* () {
      yield* Console.error(`\n----- ${f.script} (${f.detail}) -----`)
      if (f.tail.trim().length > 0) {
        yield* Console.error(f.tail)
      }
    }),
  )

  yield* Console.error(`\nPreflight failed: ${failures.length} gate(s) failed.`)
  return yield* new PreflightFailed({ count: failures.length })
})

// disableErrorReporting: we print our own summary; this just lets PreflightFailed
// set a non-zero exit code without dumping a stack trace.
NodeRuntime.runMain(preflight.pipe(Effect.provide(NodeContext.layer)), {
  disableErrorReporting: true,
})
