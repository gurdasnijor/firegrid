# Runtime Sandbox Providers

`SandboxProvider` is Firegrid's runtime boundary for "run this work somewhere".
Providers keep the same lifecycle surface (`create`, `find`, `getOrCreate`,
`execute`, `stream`, `openBytePipe`, `destroy`) while choosing a different
execution substrate.

Import the provider surface from:

```ts
import {
  EffectAiSandboxProvider,
  LocalProcessSandboxProvider,
  SandboxProvider,
} from "@firegrid/runtime/producers/sandbox"
```

> The legacy `@firegrid/runtime/sources/sandbox` subpath is preserved as a
> back-compat alias and will be removed in a future cleanup wave. New code
> should import from `@firegrid/runtime/producers/sandbox` to match the
> canonical tier name.

## Local Process

`LocalProcessSandboxProvider` starts an operating-system process through
`@effect/platform`'s command executor. Use it when a runtime context should run
an actual command and expose stdout, stderr, exit, and optional byte-pipe stdio.

```ts
import { NodeContext } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import {
  LocalProcessSandboxProvider,
  SandboxProvider,
} from "@firegrid/runtime/producers/sandbox"

const Live = LocalProcessSandboxProvider.layer().pipe(
  Layer.provide(NodeContext.layer),
)

const program = Effect.gen(function* () {
  const provider = yield* SandboxProvider
  const sandbox = yield* provider.create({
    labels: { kind: "local-demo" },
  })
  return yield* provider.execute(sandbox, {
    argv: [process.execPath, "--eval", "console.log('hello')"],
  })
})

const result = await Effect.runPromise(program.pipe(Effect.provide(Live)))
```

## Effect AI In-Process

`EffectAiSandboxProvider` does not start a child process. It adapts
`SandboxProvider.execute` and `SandboxProvider.stream` to an injected
`@effect/ai` `LanguageModel.LanguageModel` service:

- `execute` calls `LanguageModel.generateText`.
- `stream` calls `LanguageModel.streamText` and maps text deltas to stdout
  chunks.
- `openBytePipe`, file upload/download, cwd, env, and stream-shaped stdin are
  rejected with `SandboxProviderError`.

```ts
import { Effect, Layer } from "effect"
import { LanguageModel } from "@effect/ai"
import {
  EffectAiSandboxProvider,
  SandboxProvider,
} from "@firegrid/runtime/producers/sandbox"

declare const AiLanguageModelLive: Layer.Layer<LanguageModel.LanguageModel>

const Live = EffectAiSandboxProvider.layer().pipe(
  Layer.provide(AiLanguageModelLive),
)

const program = Effect.gen(function* () {
  const provider = yield* SandboxProvider
  const sandbox = yield* provider.getOrCreate({
    labels: { kind: "in-process-ai" },
  })
  return yield* provider.execute(sandbox, {
    argv: ["Summarize this event"],
    stdin: "  user clicked publish  ",
  })
})
```

The command-to-prompt transform is intentionally small for this slice:
`argv` is joined with spaces, string `stdin` is trimmed and appended after a
newline, and argv boundaries are not preserved.

## Supplying an Effect AI Provider

Firegrid depends on the `@effect/ai` contracts, not a concrete model vendor.
Choose and install one of the Effect AI provider packages in the consuming app,
then provide its `LanguageModel` layer to `EffectAiSandboxProvider.layer()`.

The Effect AI repo currently includes provider packages such as:

- `@effect/ai-openai`
- `@effect/ai-anthropic`
- `@effect/ai-google`
- `@effect/ai-openrouter`
- `@effect/ai-amazon-bedrock`

For example, with OpenAI:

```ts
import { NodeHttpClient } from "@effect/platform-node"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Layer, Redacted } from "effect"
import { EffectAiSandboxProvider } from "@firegrid/runtime/producers/sandbox"

const OpenAiLanguageModelLive = OpenAiLanguageModel.layer({
  model: "gpt-4.1-mini",
}).pipe(
  Layer.provide(OpenAiClient.layer({
    apiKey: Redacted.make("app-owned-api-key"),
  })),
  Layer.provide(NodeHttpClient.layer),
)

const RuntimeProviderLive = EffectAiSandboxProvider.layer().pipe(
  Layer.provide(OpenAiLanguageModelLive),
)
```

Provider credentials stay in the app's Effect AI layer. Firegrid runtime code
does not read provider credentials or select provider-specific model names.
