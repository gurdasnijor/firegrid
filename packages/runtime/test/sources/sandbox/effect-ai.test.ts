import { LanguageModel, Response, type Prompt } from "@effect/ai"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  SandboxProvider,
  type ProcessOutputChunk,
} from "../../../src/producers/sandbox/SandboxProvider.ts"
import {
  effectAi,
  EffectAiSandboxProvider,
} from "../../../src/producers/sandbox/effect-ai.ts"

const promptText = (prompt: Prompt.RawInput): string =>
  typeof prompt === "string" ? prompt : "[structured prompt]"

const FakeLanguageModel = Layer.succeed(LanguageModel.LanguageModel, {
  generateText: options =>
    Effect.succeed(
      new LanguageModel.GenerateTextResponse([
        Response.textPart({ text: `generated:${promptText(options.prompt)}` }),
      ]),
    ),
  generateObject: () => Effect.dieMessage("not implemented"),
  streamText: options =>
    Stream.fromIterable([
      Response.textDeltaPart({
        id: "fake-stream",
        delta: "stream:",
      }),
      Response.textDeltaPart({
        id: "fake-stream",
        delta: promptText(options.prompt),
      }),
    ]),
} satisfies LanguageModel.Service)

const Live = EffectAiSandboxProvider.layer().pipe(
  Layer.provide(FakeLanguageModel),
)

describe("runtime providers/sandboxes effect-ai", () => {
  it("firegrid-effect-ai-inprocess-provider.SANDBOX_PROVIDER.1 firegrid-effect-ai-inprocess-provider.SANDBOX_PROVIDER.2 firegrid-effect-ai-inprocess-provider.SANDBOX_PROVIDER.3 exposes runtime-local sandbox identity", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SandboxProvider
        const created = yield* provider.create({
          labels: { purpose: "effect-ai-session" },
          providerConfig: { test: true },
        })
        const found = yield* provider.find({ purpose: "effect-ai-session" })
        const same = yield* provider.getOrCreate({
          labels: { purpose: "effect-ai-session" },
        })
        const destroyed = yield* provider.destroy(created)
        const missing = yield* provider.find({ purpose: "effect-ai-session" })
        return { provider, created, found, same, destroyed, missing }
      }).pipe(Effect.provide(Live)),
    )

    expect(result.provider.name).toBe("effect-ai")
    expect(result.provider.capabilities).toEqual({
      persistent: false,
      snapshot: false,
      streaming: true,
      fileUpload: false,
      interactiveShell: false,
      gpu: false,
    })
    expect(result.created).toMatchObject({
      provider: "effect-ai",
      state: "running",
      labels: { purpose: "effect-ai-session" },
      connectionInfo: {},
      metadata: {
        provider: "effect-ai",
        test: true,
      },
    })
    expect(result.found?.id).toEqual(result.created.id)
    expect(result.same.id).toEqual(result.created.id)
    expect(result.destroyed).toBe(true)
    expect(result.missing).toBeUndefined()
  })

  it("firegrid-effect-ai-inprocess-provider.SANDBOX_PROVIDER.4 treats empty-label lookup as match-none and no-label getOrCreate as fresh", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SandboxProvider
        const first = yield* provider.create({})
        const emptyFind = yield* provider.find({})
        const second = yield* provider.getOrCreate({})
        return { first, emptyFind, second }
      }).pipe(Effect.provide(Live)),
    )

    expect(result.emptyFind).toBeUndefined()
    expect(result.second.id).not.toEqual(result.first.id)
  })

  it("firegrid-effect-ai-inprocess-provider.EXECUTION.1 firegrid-effect-ai-inprocess-provider.BOUNDARIES.1 firegrid-effect-ai-inprocess-provider.BOUNDARIES.2 executes through injected LanguageModel.generateText", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SandboxProvider
        const sandbox = yield* provider.create({})
        return yield* provider.execute(sandbox, {
          argv: ["hello", "model"],
          stdin: "with stdin",
        })
      }).pipe(Effect.provide(Live)),
    )

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "generated:hello model\nwith stdin",
      stderr: "",
      truncated: false,
      timedOut: false,
    })
    expect(typeof result.durationMs).toBe("number")
  })

  it("firegrid-effect-ai-inprocess-provider.EXECUTION.1-1 joins argv with spaces and trims string stdin before prompting", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SandboxProvider
        const sandbox = yield* provider.create({})
        return yield* provider.execute(sandbox, {
          argv: ["  alpha", "beta  ", "gamma"],
          stdin: "  delta\n",
        })
      }).pipe(Effect.provide(Live)),
    )

    expect(result.stdout).toBe("generated:alpha beta   gamma\ndelta")
  })

  it("firegrid-effect-ai-inprocess-provider.EXECUTION.2 streams Effect AI text deltas as stdout and one exit chunk", async () => {
    const chunks = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SandboxProvider
        const sandbox = yield* provider.create({})
        return yield* provider.stream(sandbox, {
          argv: ["stream", "prompt"],
        }).pipe(
          Stream.runCollect,
          Effect.map(collected => Array.from(collected)),
        )
      }).pipe(Effect.provide(Live)),
    )

    expect(chunks).toEqual([
      {
        type: "output",
        channel: "stdout",
        text: "stream:",
      },
      {
        type: "output",
        channel: "stdout",
        text: "stream prompt",
      },
      {
        type: "exit",
        exitCode: 0,
      },
    ] satisfies ReadonlyArray<ProcessOutputChunk>)
  })

  it("firegrid-effect-ai-inprocess-provider.EXECUTION.3 preserves executeMany ordering through execute", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SandboxProvider
        const sandbox = yield* provider.create({})
        return yield* provider.executeMany(sandbox, [
          { argv: ["first"] },
          { argv: ["second"] },
        ])
      }).pipe(Effect.provide(Live)),
    )

    expect(result.map(item => item.stdout)).toEqual([
      "generated:first",
      "generated:second",
    ])
  })

  it("firegrid-effect-ai-inprocess-provider.EXECUTION.4 fails unsupported process-shaped operations explicitly", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SandboxProvider
        const sandbox = yield* provider.create({})
        const cwd = yield* provider.execute(sandbox, {
          argv: ["prompt"],
          cwd: "/tmp",
        }).pipe(Effect.either)
        const env = yield* provider.execute(sandbox, {
          argv: ["prompt"],
          envVars: { SHOULD_NOT_APPEAR: "1" },
        }).pipe(Effect.either)
        const streamStdin = yield* provider.execute(sandbox, {
          argv: ["prompt"],
          stdin: Stream.empty,
        }).pipe(Effect.either)
        const bytePipe = yield* Effect.scoped(
          provider.openBytePipe(sandbox, { argv: ["prompt"] }).pipe(Effect.either),
        )
        const upload = yield* provider.upload(sandbox, "local", "remote").pipe(Effect.either)
        const download = yield* provider.download(sandbox, "remote", "local").pipe(Effect.either)
        return { cwd, env, streamStdin, bytePipe, upload, download }
      }).pipe(Effect.provide(Live)),
    )

    expect(result.cwd).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "SandboxProviderError",
        provider: "effect-ai",
        op: "command.cwd",
      },
    })
    expect(result.bytePipe).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "SandboxProviderError",
        provider: "effect-ai",
        op: "openBytePipe",
      },
    })
    expect(result.env).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "SandboxProviderError",
        provider: "effect-ai",
        op: "command.env",
      },
    })
    expect(result.streamStdin).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "SandboxProviderError",
        provider: "effect-ai",
        op: "command.stdin",
        message: "effect-ai provider supports string stdin but not stream-shaped stdin",
      },
    })
    expect(result.upload).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "SandboxProviderError",
        provider: "effect-ai",
        op: "upload",
      },
    })
    expect(result.download).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "SandboxProviderError",
        provider: "effect-ai",
        op: "download",
      },
    })
  })

  it("firegrid-effect-ai-inprocess-provider.VALIDATION.1 firegrid-effect-ai-inprocess-provider.VALIDATION.2 provides a helper shape without provider credentials", () => {
    expect(effectAi({
      labels: { app: "example" },
      providerConfig: { model: "fake" },
    })).toEqual({
      provider: "effect-ai",
      config: {
        labels: { app: "example" },
        providerConfig: { model: "fake" },
      },
    })
  })
})
