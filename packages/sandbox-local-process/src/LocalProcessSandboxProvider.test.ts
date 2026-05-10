import { NodeContext } from "@effect/platform-node"
import {
  SandboxProvider,
  type ProcessOutputChunk,
} from "@firegrid/sandboxes-core"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  localProcess,
  LocalProcessSandboxProvider,
} from "./LocalProcessSandboxProvider.ts"

const Live = LocalProcessSandboxProvider.layer().pipe(
  Layer.provide(NodeContext.layer),
)

describe("@firegrid/sandbox-local-process", () => {
  it("firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.1 firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.2 firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.3 firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.4 firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.5 exposes a local-process SandboxProvider slot implementation", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SandboxProvider
        const sandbox = yield* provider.getOrCreate({
          workingDir: process.cwd(),
          envVars: { FIREGRID_SANDBOX_TEST: "1" },
          labels: { purpose: "sandbox-slot-test" },
          providerConfig: { source: "unit-test" },
        })
        const found = yield* provider.find({ purpose: "sandbox-slot-test" })
        return {
          provider,
          sandbox,
          found,
        }
      }).pipe(Effect.provide(Live)),
    )

    expect(result.provider.name).toBe("local-process")
    expect(result.provider.capabilities).toMatchObject({
      streaming: true,
      persistent: false,
      fileUpload: false,
      gpu: false,
    })
    expect(result.sandbox).toMatchObject({
      provider: "local-process",
      state: "running",
      labels: { purpose: "sandbox-slot-test" },
      connectionInfo: {},
      metadata: {},
    })
    expect(result.found?.id).toEqual(result.sandbox.id)
  })

  it("firegrid-durable-launch-runtime-operator.SANDBOX_PROVIDERS.6 streams stdout stderr and exit chunks without durable authority", async () => {
    const chunks = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SandboxProvider
        const sandbox = yield* provider.create({})
        return yield* provider.stream(sandbox, {
          argv: [
            process.execPath,
            "--input-type=module",
            "-e",
            "console.log('out'); console.error('err')",
          ],
        }).pipe(
          Stream.runCollect,
          Effect.map(collected => Array.from(collected)),
        )
      }).pipe(Effect.provide(Live)),
    )

    expect(chunks).toContainEqual({
      type: "output",
      channel: "stdout",
      text: "out",
    } satisfies ProcessOutputChunk)
    expect(chunks).toContainEqual({
      type: "output",
      channel: "stderr",
      text: "err",
    } satisfies ProcessOutputChunk)
    expect(chunks).toContainEqual({
      type: "exit",
      exitCode: 0,
    } satisfies ProcessOutputChunk)
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 sketches a provider helper without host stream or process authority", () => {
    expect(localProcess({
      cwd: "/workspace",
      env: { NODE_ENV: "test" },
      labels: { app: "example" },
    })).toEqual({
      provider: "local-process",
      config: {
        cwd: "/workspace",
        env: { NODE_ENV: "test" },
        labels: { app: "example" },
      },
    })
  })
})
