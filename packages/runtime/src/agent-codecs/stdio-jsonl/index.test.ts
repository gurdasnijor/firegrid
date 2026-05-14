import { Chunk, Deferred, Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import type {
  AgentByteStream,
  AgentOutputEvent,
  AgentSession,
} from "../../agent-io/index.ts"
import {
  StdioJsonlCapabilities,
  StdioJsonlCodec,
} from "./index.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface Harness {
  readonly bytes: AgentByteStream
  readonly stdinReader: ReadableStreamDefaultReader<Uint8Array>
  readonly stdoutWriter: WritableStreamDefaultWriter<Uint8Array>
  readonly exit: Deferred.Deferred<{ readonly exitCode?: number; readonly signal?: string }, unknown>
}

const makeHarness = Effect.gen(function*() {
  const stdin = new TransformStream<Uint8Array, Uint8Array>()
  const stdout = new TransformStream<Uint8Array, Uint8Array>()
  const stderr = new TransformStream<Uint8Array, Uint8Array>()
  const exit = yield* Deferred.make<
    { readonly exitCode?: number; readonly signal?: string },
    unknown
  >()

  return {
    bytes: {
      stdin: stdin.writable,
      stdout: stdout.readable,
      stderr: stderr.readable,
      exit: Deferred.await(exit),
    },
    stdinReader: stdin.readable.getReader(),
    stdoutWriter: stdout.writable.getWriter(),
    exit,
  } satisfies Harness
})

const openSession = (bytes: AgentByteStream) =>
  StdioJsonlCodec.open(bytes, { toolCatalog: [] })

const collectOutputs = (
  session: AgentSession,
  count: number,
) =>
  session.outputs.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map(Chunk.toReadonlyArray),
  )

const writeStdoutLine = (
  writer: WritableStreamDefaultWriter<Uint8Array>,
  value: unknown,
) =>
  Effect.promise(() =>
    writer.write(
      encoder.encode(`${JSON.stringify(value)}\n`),
    ),
  )

const readStdinLine = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
) =>
  Effect.promise(async () => {
    const result = await reader.read()
    if (result.done || result.value === undefined) {
      throw new Error("expected stdin line")
    }
    return decoder.decode(result.value).trim()
  })

describe("StdioJsonlCodec", () => {
  it("emits Ready with stdio-jsonl capabilities on open", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          const session = yield* openSession(harness.bytes)
          return yield* collectOutputs(session, 1)
        }),
      ),
    )

    expect(events).toEqual([
      {
        _tag: "Ready",
        capabilities: StdioJsonlCapabilities,
      },
    ])
  })

  it("encodes Prompt input events as stdio JSON lines", async () => {
    const line = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          const session = yield* openSession(harness.bytes)
          const line = yield* readStdinLine(harness.stdinReader).pipe(Effect.fork)
          yield* session.send({
            _tag: "Prompt",
            correlationId: "prompt-1",
            content: [{ _tag: "Text", text: "hello agent" }],
          })
          return yield* Fiber.join(line)
        }),
      ),
    )

    expect(JSON.parse(line) as unknown).toEqual({
      type: "prompt",
      correlationId: "prompt-1",
      content: [{ _tag: "Text", text: "hello agent" }],
    })
  })

  it("decodes stdout text JSON lines into TextChunk output events", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          const session = yield* openSession(harness.bytes)
          const fiber = yield* collectOutputs(session, 2).pipe(Effect.fork)
          yield* writeStdoutLine(harness.stdoutWriter, {
            type: "text",
            text: "hello from stdout",
            messageId: "m-1",
          })
          return yield* Fiber.join(fiber)
        }),
      ),
    )

    expect(events[1]).toEqual({
      _tag: "TextChunk",
      text: "hello from stdout",
      messageId: "m-1",
    })
  })

  it("decodes stdout tool_use JSON lines into ToolUse output events", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          const session = yield* openSession(harness.bytes)
          const fiber = yield* collectOutputs(session, 2).pipe(Effect.fork)
          yield* writeStdoutLine(harness.stdoutWriter, {
            type: "tool_use",
            toolUseId: "tool-1",
            name: "lookup",
            input: { query: "firegrid" },
          })
          return yield* Fiber.join(fiber)
        }),
      ),
    )

    expect(events[1]).toEqual({
      _tag: "ToolUse",
      toolUseId: "tool-1",
      name: "lookup",
      input: { query: "firegrid" },
    })
  })

  it("encodes ToolResult input events back to stdin JSON lines", async () => {
    const line = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          const session = yield* openSession(harness.bytes)
          const line = yield* readStdinLine(harness.stdinReader).pipe(Effect.fork)
          yield* session.send({
            _tag: "ToolResult",
            toolUseId: "tool-1",
            content: { ok: true },
            isError: false,
          })
          return yield* Fiber.join(line)
        }),
      ),
    )

    expect(JSON.parse(line) as unknown).toEqual({
      type: "tool_result",
      toolUseId: "tool-1",
      content: { ok: true },
      isError: false,
    })
  })

  it("decodes stdout turn_complete JSON lines into TurnComplete output events", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          const session = yield* openSession(harness.bytes)
          const fiber = yield* collectOutputs(session, 2).pipe(Effect.fork)
          yield* writeStdoutLine(harness.stdoutWriter, {
            type: "turn_complete",
            stopReason: "end_turn",
            messageId: "m-1",
          })
          return yield* Fiber.join(fiber)
        }),
      ),
    )

    expect(events[1]).toEqual({
      _tag: "TurnComplete",
      stopReason: "end_turn",
      messageId: "m-1",
    })
  })

  it("emits Terminated from the byte stream exit signal", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const harness = yield* makeHarness
          const session = yield* openSession(harness.bytes)
          const fiber = yield* collectOutputs(session, 2).pipe(Effect.fork)
          yield* Deferred.succeed(harness.exit, { exitCode: 0 })
          return yield* Fiber.join(fiber)
        }),
      ),
    )

    expect(events[1]).toEqual({
      _tag: "Terminated",
      exitCode: 0,
    } satisfies AgentOutputEvent)
  })
})
