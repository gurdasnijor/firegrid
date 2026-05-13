import { Effect, Either, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  ResolveEnvBindingError,
  RuntimeEnvResolverPolicy,
  resolveSpawnEnvVars,
} from "./secrets.ts"

const policyLayer = (
  allowed: ReadonlyArray<string>,
  env: Record<string, string>,
) =>
  Layer.succeed(
    RuntimeEnvResolverPolicy,
    RuntimeEnvResolverPolicy.make({
      allowedEnvVars: allowed,
      lookupEnv: (name) => env[name],
    }),
  )

describe("runtime providers/sandboxes secrets resolver", () => {
  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 resolves an allowed env binding via injected lookup", async () => {
    const out = await Effect.runPromise(
      resolveSpawnEnvVars([
        { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
      ]).pipe(
        Effect.provide(policyLayer(["ANTHROPIC_API_KEY"], {
          ANTHROPIC_API_KEY: "sk-test-value",
        })),
      ),
    )
    expect(out).toEqual({ ANTHROPIC_API_KEY: "sk-test-value" })
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 resolves a renamed binding (child sees binding name, value comes from a different host env var)", async () => {
    const out = await Effect.runPromise(
      resolveSpawnEnvVars([
        { name: "ANTHROPIC_API_KEY", ref: "env:PARENT_ANTHROPIC_KEY" },
      ]).pipe(
        Effect.provide(policyLayer(["PARENT_ANTHROPIC_KEY"], {
          PARENT_ANTHROPIC_KEY: "sk-renamed",
        })),
      ),
    )
    expect(out).toEqual({ ANTHROPIC_API_KEY: "sk-renamed" })
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 denies a binding whose env ref is not on the allowlist", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        resolveSpawnEnvVars([
          { name: "ANTHROPIC_API_KEY", ref: "env:AWS_SECRET_ACCESS_KEY" },
        ]).pipe(
          // Allowlist authorizes ANTHROPIC_API_KEY only; the malicious row
          // names AWS_SECRET_ACCESS_KEY as the ref. The lookup will never
          // be consulted because authorization fails first.
          Effect.provide(policyLayer(["ANTHROPIC_API_KEY"], {
            AWS_SECRET_ACCESS_KEY: "must-never-be-read",
            ANTHROPIC_API_KEY: "ok",
          })),
        ),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ResolveEnvBindingError)
      expect(result.left.op).toBe("resolveSpawnEnvVars")
      expect(result.left.envName).toBe("AWS_SECRET_ACCESS_KEY")
      expect(result.left.message).toContain("not on the runtime host's authorized env allowlist")
    }
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 default deny-all policy rejects every env binding", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        resolveSpawnEnvVars([
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ]).pipe(Effect.provide(RuntimeEnvResolverPolicy.denyAll)),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.op).toBe("resolveSpawnEnvVars")
    }
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 fails when the authorized host env var is missing", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        resolveSpawnEnvVars([
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ]).pipe(Effect.provide(policyLayer(["ANTHROPIC_API_KEY"], {}))),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("host env var ANTHROPIC_API_KEY is not set")
    }
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 rejects duplicate binding target names", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        resolveSpawnEnvVars([
          { name: "ANTHROPIC_API_KEY", ref: "env:ONE" },
          { name: "ANTHROPIC_API_KEY", ref: "env:TWO" },
        ]).pipe(Effect.provide(policyLayer(["ONE", "TWO"], { ONE: "1", TWO: "2" }))),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("duplicate env binding")
    }
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 rejects unknown ref shapes loudly (forward-compat for vault: / secret:)", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        resolveSpawnEnvVars([
          { name: "ANTHROPIC_API_KEY", ref: "vault:secret/anthropic" },
        ]).pipe(Effect.provide(policyLayer(["ANTHROPIC_API_KEY"], {}))),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.op).toBe("parseRef")
      expect(result.left.message).toContain("unsupported env binding ref shape")
    }
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 returns an empty map when there are no bindings", async () => {
    const out = await Effect.runPromise(
      resolveSpawnEnvVars([]).pipe(
        Effect.provide(RuntimeEnvResolverPolicy.denyAll),
      ),
    )
    expect(out).toEqual({})
  })
})
