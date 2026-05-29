import { Effect, Either, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  mcpHeaderSecretBindingName,
  ResolveEnvBindingError,
  resolveMcpServerHeaders,
  RuntimeEnvResolverPolicy,
  resolveSpawnEnvVars,
} from "../../../src/sources/sandbox/secrets.ts"

const policyLayer = (
  authorized: ReadonlyArray<readonly [string, string]>,
  env: Record<string, string>,
) =>
  Layer.succeed(
    RuntimeEnvResolverPolicy,
    RuntimeEnvResolverPolicy.make({
      authorizedBindings: authorized,
      lookupEnv: (name) => env[name],
    }),
  )

describe("runtime providers/sandboxes secrets resolver", () => {
  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 resolves an allowed env binding via injected lookup", async () => {
    const out = await Effect.runPromise(
      resolveSpawnEnvVars([
        { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
      ]).pipe(
        Effect.provide(policyLayer(
          [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
          { ANTHROPIC_API_KEY: "sk-test-value" },
        )),
      ),
    )
    expect(out).toEqual({ ANTHROPIC_API_KEY: "sk-test-value" })
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 resolves a renamed binding (child sees binding name, value comes from a different host env var)", async () => {
    const out = await Effect.runPromise(
      resolveSpawnEnvVars([
        { name: "ANTHROPIC_API_KEY", ref: "env:PARENT_ANTHROPIC_KEY" },
      ]).pipe(
        Effect.provide(policyLayer(
          [["ANTHROPIC_API_KEY", "PARENT_ANTHROPIC_KEY"]],
          { PARENT_ANTHROPIC_KEY: "sk-renamed" },
        )),
      ),
    )
    expect(out).toEqual({ ANTHROPIC_API_KEY: "sk-renamed" })
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 denies a binding whose target name is not on the authorized pair map", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        resolveSpawnEnvVars([
          { name: "AWS_ACCESS_KEY_ID", ref: "env:AWS_ACCESS_KEY_ID" },
        ]).pipe(
          Effect.provide(policyLayer(
            [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
            { AWS_ACCESS_KEY_ID: "must-never-be-read" },
          )),
        ),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ResolveEnvBindingError)
      expect(result.left.op).toBe("resolveSpawnEnvVars")
      expect(result.left.message).toContain("not authorized")
    }
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 rejects a row that maps an authorized source value into an unapproved child target (NODE_OPTIONS exfil pattern)", async () => {
    // Operator authorized only (ANTHROPIC_API_KEY, ANTHROPIC_API_KEY).
    // A malicious / untrusted upstream writes a row that asks for the
    // same source env but routes it into the child's NODE_OPTIONS,
    // which Node treats as command-line flags — code execution via
    // env exfil. The resolver must refuse even though the *source*
    // envName is authorized for a different target.
    const result = await Effect.runPromise(
      Effect.either(
        resolveSpawnEnvVars([
          { name: "NODE_OPTIONS", ref: "env:ANTHROPIC_API_KEY" },
        ]).pipe(
          Effect.provide(policyLayer(
            [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
            { ANTHROPIC_API_KEY: "should-never-end-up-in-NODE_OPTIONS" },
          )),
        ),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.op).toBe("resolveSpawnEnvVars")
      expect(result.left.bindingName).toBe("NODE_OPTIONS")
      expect(result.left.message).toContain("not authorized")
    }
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 rejects an authorized binding-name paired with an unauthorized source env", async () => {
    // Operator authorized (ANTHROPIC_API_KEY, PARENT_ANTHROPIC_KEY). A
    // row reusing the same target name but pointing at a different host
    // env must be refused — the authorization is over the exact pair.
    const result = await Effect.runPromise(
      Effect.either(
        resolveSpawnEnvVars([
          { name: "ANTHROPIC_API_KEY", ref: "env:AWS_SECRET_ACCESS_KEY" },
        ]).pipe(
          Effect.provide(policyLayer(
            [["ANTHROPIC_API_KEY", "PARENT_ANTHROPIC_KEY"]],
            {
              PARENT_ANTHROPIC_KEY: "ok",
              AWS_SECRET_ACCESS_KEY: "must-never-be-read",
            },
          )),
        ),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.op).toBe("resolveSpawnEnvVars")
      expect(result.left.bindingName).toBe("ANTHROPIC_API_KEY")
      expect(result.left.envName).toBe("AWS_SECRET_ACCESS_KEY")
      expect(result.left.message).toContain("does not match the authorized pair")
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
        ]).pipe(Effect.provide(policyLayer(
          [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
          {},
        ))),
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
        ]).pipe(Effect.provide(policyLayer(
          [["ANTHROPIC_API_KEY", "ONE"]],
          { ONE: "1", TWO: "2" },
        ))),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("duplicate env binding")
    }
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 rejects a binding whose target name is not a valid env-var identifier", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        resolveSpawnEnvVars([
          { name: "BAD;NAME", ref: "env:ANTHROPIC_API_KEY" },
        ]).pipe(Effect.provide(policyLayer(
          [["BAD;NAME", "ANTHROPIC_API_KEY"]],
          { ANTHROPIC_API_KEY: "secret" },
        ))),
      ),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("not a valid env-var identifier")
    }
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 rejects unknown ref shapes loudly (forward-compat for vault: / secret:)", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        resolveSpawnEnvVars([
          { name: "ANTHROPIC_API_KEY", ref: "vault:secret/anthropic" },
        ]).pipe(Effect.provide(policyLayer(
          [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
          {},
        ))),
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

  it("firegrid-local-mcp-run.LAUNCH_CONFIG.10 resolves MCP header refs through the same host env policy", async () => {
    const out = await Effect.runPromise(
      resolveMcpServerHeaders("smithery", {
        authorization: { ref: "env:SMITHERY_SERVICE_TOKEN" },
        "x-routing-hint": "public-value",
      }).pipe(
        Effect.provide(policyLayer(
          [[mcpHeaderSecretBindingName("smithery", "authorization"), "SMITHERY_SERVICE_TOKEN"]],
          { SMITHERY_SERVICE_TOKEN: "Bearer runtime-only" },
        )),
      ),
    )

    expect(out).toEqual({
      authorization: "Bearer runtime-only",
      "x-routing-hint": "public-value",
    })
  })

  it("firegrid-local-mcp-run.LAUNCH_CONFIG.9 rejects literal MCP header secrets at the resolver boundary", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        resolveMcpServerHeaders("smithery", {
          authorization: "Bearer should-not-enter-durable-plane",
        }).pipe(
          Effect.provide(RuntimeEnvResolverPolicy.denyAll),
        ),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ResolveEnvBindingError)
      expect(result.left.op).toBe("resolveMcpServerHeaders")
      expect(result.left.bindingName).toBe(mcpHeaderSecretBindingName("smithery", "authorization"))
    }
  })

  it("firegrid-local-mcp-run.LAUNCH_CONFIG.10 denies unauthorized MCP header refs", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        resolveMcpServerHeaders("smithery", {
          authorization: { ref: "env:SMITHERY_SERVICE_TOKEN" },
        }).pipe(
          Effect.provide(RuntimeEnvResolverPolicy.denyAll),
        ),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.op).toBe("resolveMcpServerHeaders")
      expect(result.left.message).toContain("not authorized")
    }
  })
})
