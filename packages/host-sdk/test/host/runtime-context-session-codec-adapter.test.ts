import { Prompt } from "@effect/ai"
import {
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  type HostId,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import {
  RuntimeEnvResolverPolicy,
  SandboxProvider,
  SandboxProviderError,
  SandboxStdinEmissionClaim,
  type AgentByteStream,
  type ExecutionResult,
  type Sandbox,
  type SandboxCommand,
} from "@firegrid/runtime/sources/sandbox"
import {
  Effect,
  Layer,
  Ref,
} from "effect"
import { describe, expect, it } from "vitest"
import {
  PerContextRuntimeOutputWriter,
} from "../../src/host/per-context-runtime-output.ts"
import {
  CodecRuntimeContextWorkflowSessionLive,
} from "../../src/host/runtime-context-session/codec-adapter.ts"
import {
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
} from "../../src/host/runtime-context-workflow-core.ts"

const decoder = new TextDecoder()

const context = (
  contextId: string,
): RuntimeContext => ({
  contextId,
  createdAt: new Date().toISOString(),
  runtime: normalizeRuntimeIntent(local.jsonl({
    argv: ["node", "-e", "unused by fake byte-pipe provider"],
    agentProtocol: "stdio-jsonl",
  })),
  host: {
    hostId: "host-a" as HostId,
    streamPrefix: makeHostStreamPrefix({
      namespace: `codec-adapter-${contextId}`,
      hostId: "host-a" as HostId,
    }),
    boundAtMs: Date.now(),
  },
})

const promptCommand = (
  commandId: string,
  text: string,
): RuntimeContextSessionCommand => ({
  _tag: "AgentInput",
  commandId,
  event: {
    _tag: "Prompt",
    correlationId: commandId,
    prompt: Prompt.userMessage({
      content: [Prompt.textPart({ text })],
    }),
  },
})

const fakeSandbox = (id: string): Sandbox => ({
  id,
  provider: "fake",
  state: "running",
  labels: {},
  connectionInfo: {},
  metadata: {},
})

const fakeExecution: ExecutionResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  truncated: false,
  timedOut: false,
}

const waitUntil = (
  predicate: () => boolean,
  label: string,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (predicate()) return
      yield* Effect.sleep("25 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${label}`))
  })

const readLine = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
) =>
  Effect.promise(async () => {
    const result = await reader.read()
    if (result.done || result.value === undefined) {
      throw new Error("expected stdin bytes")
    }
    return decoder.decode(result.value).trim()
  })

interface Harness {
  readonly bytes: AgentByteStream
  readonly stdinReader: ReadableStreamDefaultReader<Uint8Array>
  readonly stdoutWriter: WritableStreamDefaultWriter<Uint8Array>
}

const makeHarness = (): Harness => {
  const stdin = new TransformStream<Uint8Array, Uint8Array>()
  const stdout = new TransformStream<Uint8Array, Uint8Array>()
  const stderr = new TransformStream<Uint8Array, Uint8Array>()
  return {
    bytes: {
      stdin: stdin.writable,
      stdout: stdout.readable,
      stderr: stderr.readable,
      exit: Effect.never,
    },
    stdinReader: stdin.readable.getReader(),
    stdoutWriter: stdout.writable.getWriter(),
  }
}

const testLayer = (state: {
  readonly events: Array<RuntimeEventRow>
  readonly logs: Array<RuntimeLogLineRow>
  readonly harnesses: Array<Harness>
  readonly claims: Set<string>
}) =>
  CodecRuntimeContextWorkflowSessionLive.pipe(
    Layer.provideMerge(Layer.succeed(
      PerContextRuntimeOutputWriter,
      PerContextRuntimeOutputWriter.of({
        appendAgentEvent: (_runtimeContext, activityAttempt, sequence, event) =>
          Effect.sync(() => {
            const row: RuntimeEventRow = {
              eventId: {
                contextId: _runtimeContext.contextId,
                activityAttempt,
                target: "events",
                sequence,
              },
              contextId: _runtimeContext.contextId,
              activityAttempt,
              sequence,
              source: "stdout",
              format: "jsonl",
              receivedAt: new Date().toISOString(),
              raw: JSON.stringify(event),
            }
            state.events.push(row)
            return row
          }),
        appendEventRow: (_runtimeContext, row) =>
          Effect.sync(() => {
            state.events.push(row)
            return row
          }),
        appendLogLine: (_runtimeContext, row) =>
          Effect.sync(() => {
            state.logs.push(row)
            return row
          }),
      }),
    )),
    Layer.provideMerge(Layer.succeed(
      SandboxStdinEmissionClaim,
      SandboxStdinEmissionClaim.of({
        claim: command =>
          Effect.sync(() => {
            if (state.claims.has(command.commandId)) return false
            state.claims.add(command.commandId)
            return true
          }),
      }),
    )),
    Layer.provideMerge(SandboxProvider.layer({
      name: "fake",
      capabilities: {
        persistent: false,
        snapshot: false,
        streaming: true,
        fileUpload: false,
        interactiveShell: false,
        gpu: false,
      },
      create: config => Effect.succeed(fakeSandbox(JSON.stringify(config.labels ?? {}))),
      getOrCreate: config => Effect.succeed(fakeSandbox(JSON.stringify(config.labels ?? {}))),
      find: () => Effect.succeed(undefined),
      execute: () => Effect.succeed(fakeExecution),
      executeMany: () => Effect.succeed([]),
      stream: () => Effect.die("not used by codec adapter tests") as never,
      openBytePipe: () =>
        Effect.sync(() => {
          const harness = makeHarness()
          state.harnesses.push(harness)
          return harness.bytes
        }),
      upload: () => Effect.void,
      download: () => Effect.void,
      destroy: () => Effect.succeed(true),
    })),
    Layer.provideMerge(RuntimeEnvResolverPolicy.denyAll),
  )

describe("CodecRuntimeContextWorkflowSessionLive", () => {
  it("lazily reattaches from send and writes through AgentSession byte stdin", async () => {
    const state = {
      events: [] as Array<RuntimeEventRow>,
      logs: [] as Array<RuntimeLogLineRow>,
      harnesses: [] as Array<Harness>,
      claims: new Set<string>(),
    }
    const runtimeContext = context(`ctx_${crypto.randomUUID()}`)

    const line = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* RuntimeContextWorkflowSession
          yield* session.send(runtimeContext, 1, promptCommand("input-1", "hello codec"))
          yield* waitUntil(() => state.harnesses.length === 1, "codec byte pipe")
          return yield* readLine(state.harnesses[0]!.stdinReader)
        }).pipe(Effect.provide(testLayer(state))),
      ),
    )

    expect(JSON.parse(line) as unknown).toMatchObject({
      type: "prompt",
      correlationId: "input-1",
    })
    expect(state.harnesses).toHaveLength(1)
  })

  it("uses the durable command claim so duplicate sends do not write duplicate codec stdin", async () => {
    const state = {
      events: [] as Array<RuntimeEventRow>,
      logs: [] as Array<RuntimeLogLineRow>,
      harnesses: [] as Array<Harness>,
      claims: new Set<string>(),
    }
    const runtimeContext = context(`ctx_${crypto.randomUUID()}`)
    const command = promptCommand("input-once", "only once")

    const line = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* RuntimeContextWorkflowSession
          yield* session.startOrAttach(runtimeContext, 1)
          yield* waitUntil(() => state.harnesses.length === 1, "codec byte pipe")
          yield* session.send(runtimeContext, 1, command)
          yield* session.send(runtimeContext, 1, command)
          return yield* readLine(state.harnesses[0]!.stdinReader)
        }).pipe(Effect.provide(testLayer(state))),
      ),
    )

    expect(JSON.parse(line) as unknown).toMatchObject({
      type: "prompt",
      correlationId: "input-once",
    })
    expect([...state.claims]).toEqual(["input-once"])
  })

  it("journals AgentSession output through PerContextRuntimeOutputWriter", async () => {
    const state = {
      events: [] as Array<RuntimeEventRow>,
      logs: [] as Array<RuntimeLogLineRow>,
      harnesses: [] as Array<Harness>,
      claims: new Set<string>(),
    }
    const runtimeContext = context(`ctx_${crypto.randomUUID()}`)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* RuntimeContextWorkflowSession
          yield* session.startOrAttach(runtimeContext, 1)
          yield* waitUntil(() => state.harnesses.length === 1, "codec byte pipe")
          yield* Effect.promise(() =>
            state.harnesses[0]!.stdoutWriter.write(
              new TextEncoder().encode(`${JSON.stringify({
                type: "text",
                text: "hello from codec",
                messageId: "m-1",
              })}\n`),
            ),
          )
          yield* waitUntil(() => state.events.length >= 2, "codec output rows")
        }).pipe(Effect.provide(testLayer(state))),
      ),
    )

    expect(state.events.map(row => JSON.parse(row.raw) as { readonly _tag: string })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _tag: "Ready" }),
        expect.objectContaining({ _tag: "TextChunk" }),
      ]),
    )
  })
})
