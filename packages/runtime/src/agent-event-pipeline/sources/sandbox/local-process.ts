import { Command } from "@effect/platform"
import {
  CommandExecutor as CommandExecutorTag,
  type CommandExecutor,
  type Process,
} from "@effect/platform/CommandExecutor"
import { Effect, Layer, Queue, Runtime, type Scope, Stream } from "effect"
import type { AgentByteStream } from "../byte-stream.ts"
import {
  type ExecutionResult,
  type ProcessOutputChunk,
  type Sandbox,
  type SandboxCommand,
  type SandboxConfig,
  SandboxProvider,
  type SandboxProviderError,
  type SandboxProviderService,
} from "./SandboxProvider.ts"
import {
  makeInMemorySandboxStore,
  makeSandboxProviderService,
  sandboxProviderError,
  withExecutionDuration,
} from "./internal-provider.ts"

const providerName = "local-process"

interface LocalProcessSandboxConfig {
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly labels?: Record<string, string>
  readonly providerConfig?: Record<string, unknown>
}

interface LocalProcessSandboxProviderHelper {
  readonly provider: typeof providerName
  readonly config: LocalProcessSandboxConfig
}

export interface LocalProcessSandboxProviderOptions {
  readonly inheritedEnvKeys?: ReadonlyArray<string>
  readonly baselineEnvVars?: Record<string, string>
}

export const localProcess = (
  config: LocalProcessSandboxConfig = {},
): LocalProcessSandboxProviderHelper => ({
  provider: providerName,
  config,
})

// tf-pgn (TFIND-054): `buildCommand` unsets ALL inherited host env, then
// re-applies only this allow-list + explicit bindings. PATH alone is
// insufficient for a packaged npx/node agent (e.g. claude-agent-acp run
// via `npx`): npx/node resolution, cache, and tempfiles need HOME,
// TMPDIR, and npm_config_* or the packaged agent mis-behaves. This is an
// explicit, named, non-secret allow-list — NOT an arbitrary host-env
// passthrough. Secrets stay out (they flow only through explicit
// envBindings / RuntimeEnvResolverPolicy). `NODE_OPTIONS` is
// deliberately excluded: it injects arbitrary node behavior into the
// spawned agent and is not needed for npx/node resolution; a host that
// needs it must bind it explicitly.
const LOCAL_PROCESS_BASELINE_ENV_NAMES = [
  // Executable + shell resolution (cross-platform).
  "PATH",
  "Path",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
  "SHELL",
  // Home / profile — node, npm, and npx read config + cache from here.
  "HOME",
  "USERPROFILE",
  // Temp dirs — npx extracts/downloads packages here; node os.tmpdir().
  "TMPDIR",
  "TMP",
  "TEMP",
  // Benign identity — some node tooling requires a user/login name.
  "USER",
  "LOGNAME",
  "USERNAME",
  // Locale — some node CLIs misbehave with an unset locale.
  "LANG",
  "LC_ALL",
  // Node module resolution / corporate TLS trust.
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  // npm/npx package resolution + cache (both casings npm emits).
  // The npm REGISTRY override is deliberately NOT baseline-passed: npx
  // resolves the default public registry without it, and pointing a
  // spawned agent at a private/alternate registry is a deliberate
  // per-host choice that must be an explicit binding (same rationale as
  // the NODE_OPTIONS exclusion) — not a blanket baseline.
  "NPM_CONFIG_CACHE",
  "npm_config_cache",
  "NPM_CONFIG_PREFIX",
  "npm_config_prefix",
  "NPM_CONFIG_USERCONFIG",
  "npm_config_userconfig",
  // XDG base dirs — used by some packaged node tools for cache/config.
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const

export const localProcessSpawnEnvFromHostEnv = (
  env: Record<string, string | undefined>,
): LocalProcessSandboxProviderOptions => {
  const baselineEnvVars: Record<string, string> = {}
  let index = 0
  while (index < LOCAL_PROCESS_BASELINE_ENV_NAMES.length) {
    const name = LOCAL_PROCESS_BASELINE_ENV_NAMES[index]!
    const value = env[name]
    if (value !== undefined && value.length > 0) baselineEnvVars[name] = value
    index += 1
  }
  return {
    inheritedEnvKeys: Object.keys(env),
    baselineEnvVars,
  }
}

const commandError = (
  op: string,
  message: string,
  cause?: unknown,
): SandboxProviderError =>
  sandboxProviderError(providerName, op, message, cause)

const buildCommand = (
  options: LocalProcessSandboxProviderOptions,
  config: SandboxConfig,
  command: SandboxCommand,
): Effect.Effect<Command.Command, SandboxProviderError> =>
  Effect.gen(function* () {
    const [executable, ...args] = command.argv
    if (executable === undefined) {
      return yield* commandError("buildCommand", "command argv is empty")
    }
    const inheritedEnvUnset: Record<string, string | undefined> = Object.fromEntries(
      (options.inheritedEnvKeys ?? []).map(key => [key, undefined]),
    )
    let built = Command.make(executable, ...args).pipe(
      // firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5-1
      Command.env({
        ...inheritedEnvUnset,
        ...options.baselineEnvVars,
        ...config.envVars,
        ...command.envVars,
      }),
    )
    if (typeof command.stdin === "string") {
      built = built.pipe(Command.feed(command.stdin))
    }
    const cwd = command.cwd ?? config.workingDir
    if (cwd !== undefined) built = built.pipe(Command.workingDirectory(cwd))
    return built
  })

const commandSpanAttributes = (
  sandbox: Sandbox,
  command: SandboxCommand,
): Record<string, unknown> => ({
  "firegrid.process.provider": providerName,
  "firegrid.process.id": sandbox.id,
  "firegrid.command.executable": command.argv[0] ?? "",
  "firegrid.command.arg_count": command.argv.length,
  "firegrid.command.stdin_configured": command.stdin !== undefined,
})

// tf-ofq: Subprocess wire capture as OTel span attributes.
//
// Each chunk crossing the codec ↔ subprocess byte boundary already gets its
// own per-chunk producer span via `Stream.withSpan`. We annotate that span
// with the chunk's decoded raw text + byte count, so the wire content rides
// on the existing trace structure — no separate JSONL file, no out-of-band
// channel, no cross-correlation work.
//
// Why span attributes, not span events:
//   - Already-existing one-span-per-chunk shape gives natural carriers.
//   - jq queries can filter wire spans directly: `select(.name | endswith("_bytes"))`
//     groups all wire activity; events would require a span-level scan.
//   - Frame sizes are typically <1KB (ACP NDJSON); well under OTel's default
//     ~64KB attribute-value cap. Truncation is a paper concern.
//
// Why not a long-lived "subprocess.lifetime" parent span carrying events:
//   - Would reintroduce exactly the orphan-parent shape tf-gc7 catalogs
//     (open span not yet flushed → consumers reference a phantom parent).
//   - The producer-span lifetime discipline says: keep producer spans
//     short-lived. Per-chunk spans already are.
const ATTR_WIRE_RAW = "firegrid.wire.raw"
const ATTR_WIRE_BYTES = "firegrid.wire.bytes"
const ATTR_WIRE_DIRECTION = "firegrid.wire.direction"

const wireDecoder = new TextDecoder("utf-8", { fatal: false })

const annotateWireChunk = (
  direction: "in" | "out" | "stderr",
  chunk: Uint8Array,
): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({
    [ATTR_WIRE_DIRECTION]: direction,
    [ATTR_WIRE_BYTES]: chunk.byteLength,
    [ATTR_WIRE_RAW]: wireDecoder.decode(chunk, { stream: true }),
  })

// firegrid agent-io: convert an @effect/platform Process's Effect-shaped
// stdio into the WHATWG web streams that codecs consume. stdout/stderr
// are Effect Streams; we run them through Stream.toReadableStream.
// stdin is an Effect Sink; we feed it from a Queue that backs a
// WritableStream the caller writes into.
const makeAgentByteStreamFromProcess = (
  process: Process,
): Effect.Effect<AgentByteStream, SandboxProviderError, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const runPromise = Runtime.runPromise(runtime)
    const stdinQueue = yield* Queue.unbounded<Uint8Array>()
    yield* Stream.fromQueue(stdinQueue, { shutdown: true }).pipe(
      Stream.run(process.stdin),
      Effect.ignore,
      Effect.forkScoped,
    )
    const stdin: WritableStream<Uint8Array> = new WritableStream<Uint8Array>({
      async write(chunk) {
        // tf-ofq: each stdin write becomes its own short-lived producer
        // span so wire content is carried in trace, not as an
        // out-of-band file. Mirrors the existing stdout/stderr shape.
        await runPromise(
          Effect.gen(function* () {
            yield* annotateWireChunk("in", chunk)
            yield* Queue.offer(stdinQueue, chunk)
          }).pipe(
            Effect.withSpan("firegrid.agent_event_pipeline.source.local_process.stdin_bytes", {
              kind: "producer",
            }),
          ),
        )
      },
      async close() {
        await runPromise(Queue.shutdown(stdinQueue))
      },
      async abort() {
        await runPromise(Queue.shutdown(stdinQueue))
      },
    })
    // tf-ofq + tf-gc7 fix in-place: `Stream.withSpan` wraps the WHOLE
    // stream's evaluation in ONE long-lived span. That span stays open
    // for the entire subprocess lifetime, never flushes during the run,
    // and (per the tf-gc7 analysis) leaves consumer spans referencing
    // unexported parents. Replace with per-chunk `Effect.withSpan` inside
    // a `Stream.tap` so each chunk gets a short-lived producer span that
    // carries the wire content directly and flushes promptly.
    const stdout: ReadableStream<Uint8Array> = Stream.toReadableStreamRuntime(runtime)(
      process.stdout.pipe(
        Stream.tap(chunk =>
          annotateWireChunk("out", chunk).pipe(
            Effect.withSpan("firegrid.agent_event_pipeline.source.local_process.stdout_bytes", {
              kind: "producer",
            }),
          )),
      ),
    ) as ReadableStream<Uint8Array>
    const stderr: ReadableStream<Uint8Array> = Stream.toReadableStreamRuntime(runtime)(
      process.stderr.pipe(
        Stream.tap(chunk =>
          annotateWireChunk("stderr", chunk).pipe(
            Effect.withSpan("firegrid.agent_event_pipeline.source.local_process.stderr_bytes", {
              kind: "producer",
            }),
          )),
      ),
    ) as ReadableStream<Uint8Array>
    const exit = process.exitCode.pipe(
      Effect.map(exitCode => ({ exitCode: Number(exitCode) })),
      Effect.tap(exit =>
        Effect.annotateCurrentSpan({
          "firegrid.process.exit_code": exit.exitCode,
        })),
      Effect.mapError(cause =>
        commandError("openBytePipe.exit", "local process failed while waiting for exit", cause),
      ),
      Effect.withSpan("firegrid.agent_event_pipeline.source.local_process.exit", {
        kind: "internal",
      }),
    )
    return { stdin, stdout, stderr, exit } satisfies AgentByteStream
  }).pipe(
    Effect.withSpan("firegrid.agent_event_pipeline.source.local_process.byte_stream", {
      kind: "internal",
    }),
  )

const makeLocalProcessSandboxProvider = (
  commandExecutor: CommandExecutor,
  options: LocalProcessSandboxProviderOptions = {},
): SandboxProviderService => {
  const store = makeInMemorySandboxStore(providerName)

  const stream = (
    sandbox: Sandbox,
    command: SandboxCommand,
  ): Stream.Stream<ProcessOutputChunk, SandboxProviderError> =>
    Stream.unwrapScoped(
      Effect.gen(function* () {
        const config = yield* store.configFor(sandbox, "stream")
        const built = yield* buildCommand(options, config, command)
        const process = yield* commandExecutor.start(built).pipe(
          Effect.mapError(cause =>
            commandError("stream", "local process command failed to start", cause),
          ),
        )
        const stdout = process.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.map(text => ({
            type: "output",
            channel: "stdout",
            text,
          }) satisfies ProcessOutputChunk),
        )
        const stderr = process.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.map(text => ({
            type: "output",
            channel: "stderr",
            text,
          }) satisfies ProcessOutputChunk),
        )
        const output = Stream.merge(stdout, stderr).pipe(
          Stream.mapError(cause =>
            commandError("stream", "failed while reading local process output", cause),
          ),
        )
        const stdin = command.stdin !== undefined && typeof command.stdin !== "string"
          ? Stream.fromEffect(
            command.stdin.pipe(
              Stream.interruptWhen(process.exitCode.pipe(Effect.ignore)),
              Stream.run(process.stdin),
              Effect.mapError(cause =>
                commandError("stream.stdin", "failed while writing local process stdin", cause),
              ),
            ),
          ).pipe(Stream.drain)
          : Stream.empty
        const exit = Stream.fromEffect(
          process.exitCode.pipe(
            Effect.map(exitCode => ({
              type: "exit",
              exitCode: Number(exitCode),
            }) satisfies ProcessOutputChunk),
            Effect.mapError(cause =>
              commandError("stream", "local process failed while waiting for exit", cause),
            ),
          ),
        )
        // firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.6
        return output.pipe(
          Stream.merge(stdin),
          Stream.concat(exit),
        )
      }).pipe(Effect.annotateSpans("firegrid.side", "subprocess")),
    ).pipe(
      Stream.withSpan("firegrid.agent_event_pipeline.source.local_process.stream", {
        kind: "producer",
        attributes: commandSpanAttributes(sandbox, command),
      }),
    )

  // firegrid agent-io: byte-pipe variant.
  //
  // Launch the process and expose its stdio as web streams so codecs
  // (ACP, future protocol-aware agents) can do byte-level framing
  // without bypassing the SandboxProvider boundary. The line-split
  // `stream` API stays for jsonl agents; the two methods coexist.
  //
  // Scope semantics: the returned `AgentByteStream` is tied to the
  // caller's Scope through `Effect.acquireRelease`; closing the scope
  // kills the launched process.
  const openBytePipe = (
    sandbox: Sandbox,
    command: SandboxCommand,
  ) =>
    Effect.gen(function* () {
      const config = yield* store.configFor(sandbox, "openBytePipe")
      const built = yield* buildCommand(options, config, command)
      const process = yield* Effect.acquireRelease(
        commandExecutor.start(built).pipe(
          Effect.mapError(cause =>
            commandError(
              "openBytePipe",
              "local process command failed to start",
              cause,
            ),
          ),
        ),
        (p) => p.kill().pipe(Effect.ignore),
      )
      return yield* makeAgentByteStreamFromProcess(process)
    }).pipe(
      Effect.withSpan("firegrid.agent_event_pipeline.source.local_process.open_byte_pipe", {
        kind: "producer",
        attributes: commandSpanAttributes(sandbox, command),
      }),
      Effect.annotateSpans("firegrid.side", "subprocess"),
    )

  const execute = (
    sandbox: Sandbox,
    command: SandboxCommand,
  ): Effect.Effect<ExecutionResult, SandboxProviderError> =>
    withExecutionDuration(Effect.gen(function* () {
      const stdout: Array<string> = []
      const stderr: Array<string> = []
      let exitCode = 1
      yield* stream(sandbox, command).pipe(
        Stream.runForEach(chunk =>
          Effect.sync(() => {
            if (chunk.type === "exit") {
              exitCode = chunk.exitCode
            } else if (chunk.channel === "stdout") {
              stdout.push(chunk.text)
            } else {
              stderr.push(chunk.text)
            }
          }),
        ),
      )
      return {
        exitCode,
        stdout: stdout.join("\n"),
        stderr: stderr.join("\n"),
      }
    }).pipe(
      Effect.tap(result =>
        Effect.annotateCurrentSpan({
          "firegrid.process.exit_code": result.exitCode,
        })),
      Effect.withSpan("firegrid.agent_event_pipeline.source.local_process.execute", {
        kind: "producer",
        attributes: commandSpanAttributes(sandbox, command),
      }),
      Effect.annotateSpans("firegrid.side", "subprocess"),
    ))

  return makeSandboxProviderService({
    name: providerName,
    capabilities: {
      streaming: true,
    },
    // firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.1
    // firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.4
    // firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.5
    store,
    execute,
    stream,
    openBytePipe,
  })
}

export const LocalProcessSandboxProvider = {
  layer: (
    options: LocalProcessSandboxProviderOptions = {},
  ): Layer.Layer<SandboxProvider, never, CommandExecutor> =>
    Layer.effect(
      SandboxProvider,
      Effect.map(CommandExecutorTag, commandExecutor =>
        makeLocalProcessSandboxProvider(commandExecutor, options),
      ),
    ).pipe(Layer.annotateSpans("firegrid.side", "subprocess")),
}
