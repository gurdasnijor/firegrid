import { NodeContext } from "@effect/platform-node"
import {
  SandboxProvider,
  type ProcessOutputChunk,
} from "../../../src/producers/sandbox/SandboxProvider.ts"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  localProcess,
  localProcessSpawnEnvFromHostEnv,
  LocalProcessSandboxProvider,
} from "../../../src/producers/sandbox/local-process.ts"

const Live = LocalProcessSandboxProvider.layer().pipe(
  Layer.provide(NodeContext.layer),
)

describe("runtime providers/sandboxes local-process", () => {
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

  it("firegrid-agent-ingress.DELIVERY.5 accepts a stream-shaped stdin source while keeping output streaming provider-neutral", async () => {
    const chunks = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SandboxProvider
        const sandbox = yield* provider.create({})
        return yield* provider.stream(sandbox, {
          argv: [
            process.execPath,
            "--input-type=module",
            "-e",
            "process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => console.log('echo:' + chunk.trim()))",
          ],
          stdin: Stream.fromIterable([
            new TextEncoder().encode("hello from stream\n"),
          ]),
        }).pipe(
          Stream.runCollect,
          Effect.map(collected => Array.from(collected)),
        )
      }).pipe(Effect.provide(Live)),
    )

    expect(chunks).toContainEqual({
      type: "output",
      channel: "stdout",
      text: "echo:hello from stream",
    } satisfies ProcessOutputChunk)
  })

  it("firegrid-agent-ingress.DELIVERY.5 surfaces stream-shaped stdin failures through the provider stream", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SandboxProvider
        const sandbox = yield* provider.create({})
        return yield* provider.stream(sandbox, {
          argv: [
            process.execPath,
            "--input-type=module",
            "-e",
            "setTimeout(() => process.exit(0), 1000)",
          ],
          stdin: Stream.fail(new Error("stdin source failed")),
        }).pipe(
          Stream.runDrain,
          Effect.either,
        )
      }).pipe(Effect.provide(Live)),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "SandboxProviderError",
        op: "stream.stdin",
      })
    }
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5-1 allowlists child env to baseline plus SandboxCommand.envVars", async () => {
    const parentOnlyKey = `FIREGRID_LOCAL_PROCESS_PARENT_ONLY_${crypto.randomUUID().replaceAll("-", "_")}`
    const childOnlyValue = `child-${crypto.randomUUID()}`
    globalThis.process.env[parentOnlyKey] = `parent-${crypto.randomUUID()}`
    try {
      const chunks = await Effect.runPromise(
        Effect.gen(function* () {
          const provider = yield* SandboxProvider
          const sandbox = yield* provider.create({})
          return yield* provider.stream(sandbox, {
            argv: [
              process.execPath,
              "--input-type=module",
              "-e",
              "const [parentOnlyKey] = process.argv.slice(1); console.log(JSON.stringify({ parentOnly: process.env[parentOnlyKey], childOnly: process.env.CHILD_ONLY, hasPath: process.env.PATH !== undefined || process.env.Path !== undefined }))",
              parentOnlyKey,
            ],
            envVars: { CHILD_ONLY: childOnlyValue },
          }).pipe(
            Stream.runCollect,
            Effect.map(collected => Array.from(collected)),
          )
        }).pipe(
          Effect.provide(
            LocalProcessSandboxProvider.layer(
              localProcessSpawnEnvFromHostEnv(globalThis.process.env),
            ).pipe(Layer.provide(NodeContext.layer)),
          ),
        ),
      )

      const stdout = chunks.find(chunk =>
        chunk.type === "output" && chunk.channel === "stdout",
      )
      expect(stdout).toMatchObject({
        type: "output",
        channel: "stdout",
      })
      if (stdout?.type !== "output") throw new Error("expected stdout output")
      expect(JSON.parse(stdout.text)).toEqual({
        childOnly: childOnlyValue,
        hasPath: true,
      })
      expect(chunks).toContainEqual({
        type: "exit",
        exitCode: 0,
      } satisfies ProcessOutputChunk)
    } finally {
      delete globalThis.process.env[parentOnlyKey]
    }
  })

  it("tf-pgn TFIND-054 passes the npx/node-packaged-agent baseline through localProcessSpawnEnvFromHostEnv without leaking arbitrary host env or secrets", () => {
    const hostEnv: Record<string, string | undefined> = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/operator",
      TMPDIR: "/tmp/operator",
      USER: "operator",
      LOGNAME: "operator",
      LANG: "en_US.UTF-8",
      NODE_PATH: "/opt/node_modules",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      NPM_CONFIG_CACHE: "/home/operator/.npm",
      npm_config_cache: "/home/operator/.npm",
      XDG_CACHE_HOME: "/home/operator/.cache",
      // Must NOT pass through: arbitrary host var, a secret, the
      // deliberately-excluded behavior-injection vector, and the
      // deliberately-excluded npm registry override.
      ANTHROPIC_API_KEY: "sk-secret-should-not-leak",
      SOME_RANDOM_HOST_VAR: "should-not-leak",
      NODE_OPTIONS: "--require /tmp/evil.js",
      npm_config_registry: "https://private.example.com",
    }

    const baselineEnvVars =
      localProcessSpawnEnvFromHostEnv(hostEnv).baselineEnvVars ?? {}

    // Packaged npx/node agent baseline IS passed through.
    expect(baselineEnvVars).toMatchObject({
      PATH: "/usr/bin:/bin",
      HOME: "/home/operator",
      TMPDIR: "/tmp/operator",
      USER: "operator",
      LOGNAME: "operator",
      LANG: "en_US.UTF-8",
      NODE_PATH: "/opt/node_modules",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      NPM_CONFIG_CACHE: "/home/operator/.npm",
      npm_config_cache: "/home/operator/.npm",
      XDG_CACHE_HOME: "/home/operator/.cache",
    })
    // Secrets / arbitrary host env / NODE_OPTIONS / npm registry
    // override are NOT in the baseline (deliberate exclusions).
    expect(baselineEnvVars.ANTHROPIC_API_KEY).toBeUndefined()
    expect(baselineEnvVars.SOME_RANDOM_HOST_VAR).toBeUndefined()
    expect(baselineEnvVars.NODE_OPTIONS).toBeUndefined()
    expect(baselineEnvVars.npm_config_registry).toBeUndefined()
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
