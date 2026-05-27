/**
 * Tests for LocalProcessSandboxProvider.openBytePipe — the byte-pipe
 * variant codecs (ACP, future protocol-aware agents) consume.
 */

import { NodeContext } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { SandboxProvider } from "../../../src/producers/sandbox/SandboxProvider.ts"
import { LocalProcessSandboxProvider } from "../../../src/producers/sandbox/local-process.ts"

const Live = LocalProcessSandboxProvider.layer().pipe(
  Layer.provide(NodeContext.layer),
)

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) buffer += decoder.decode(value, { stream: true })
  }
  buffer += decoder.decode()
  return buffer
}

describe("LocalProcessSandboxProvider.openBytePipe", () => {
  it("exposes child stdout as a web ReadableStream<Uint8Array>", async () => {
    const stdout = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* SandboxProvider
          const sandbox = yield* provider.create({})
          const bytes = yield* provider.openBytePipe(sandbox, {
            argv: [
              process.execPath,
              "-e",
              "process.stdout.write('byte-pipe ok\\n')",
            ],
          })
          return yield* Effect.promise(() => readAll(bytes.stdout))
        }),
      ).pipe(Effect.provide(Live)),
    )

    expect(stdout).toContain("byte-pipe ok")
  })

  it("delivers writes from the WritableStream<Uint8Array> stdin into the child", async () => {
    const stdout = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* SandboxProvider
          const sandbox = yield* provider.create({})
          const bytes = yield* provider.openBytePipe(sandbox, {
            argv: [
              process.execPath,
              "-e",
              `process.stdin.setEncoding('utf8');
               let buf = '';
               process.stdin.on('data', c => {
                 buf += c
                 if (buf.includes('\\n')) {
                   process.stdout.write('echo:' + buf.trim() + '\\n')
                   process.stdin.destroy()
                 }
               })`,
            ],
          })
          const writer = bytes.stdin.getWriter()
          yield* Effect.promise(() => writer.write(encoder.encode("hello\n")))
          yield* Effect.promise(() => writer.close())
          return yield* Effect.promise(() => readAll(bytes.stdout))
        }),
      ).pipe(Effect.provide(Live)),
    )

    expect(stdout).toContain("echo:hello")
  })

  it("acquireRelease wires the scope so the byte pipe completes cleanly", async () => {
    // Long-lived child that never exits on its own; closing the
    // scope must drive the release callback (which kills the process)
    // so the scoped Effect resolves rather than hanging.
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* SandboxProvider
          const sandbox = yield* provider.create({})
          const bytes = yield* provider.openBytePipe(sandbox, {
            argv: [process.execPath, "-e", "setInterval(()=>{}, 60000)"],
          })
          return bytes.stdout instanceof ReadableStream
        }),
      ).pipe(Effect.provide(Live)),
    )
    expect(result).toBe(true)
  })

  it("reports the child process exit code", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* SandboxProvider
          const sandbox = yield* provider.create({})
          const bytes = yield* provider.openBytePipe(sandbox, {
            argv: [process.execPath, "-e", "process.exit(7)"],
          })
          return yield* bytes.exit
        }),
      ).pipe(Effect.provide(Live)),
    )

    expect(exit).toEqual({ exitCode: 7 })
  })
})
