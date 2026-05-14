// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5..8
//
// Unit coverage for the sync-run RunConfig DTO and its builders. The
// argv-side parser lives in src/run.ts; this file exercises the decoded
// shape and the downstream RuntimeContext / ingress request the binary
// emits from it.

import { Effect, Either } from "effect"
import { describe, expect, it } from "vitest"
import {
  decodeRunConfig,
  runConfigRequiresInput,
  runConfigToIngressRequest,
  runConfigToRuntimeContextIntent,
  type RunConfig,
} from "./sync-run.ts"

const validBase: RunConfig = {
  agentArgv: ["node", "agent.mjs"],
}

const decode = (input: unknown): Either.Either<RunConfig, unknown> =>
  Effect.runSync(Effect.either(decodeRunConfig(input)))

describe("RunConfig schema decoding", () => {
  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1 accepts a minimal config with just agentArgv", () => {
    const decoded = decode({ agentArgv: ["node", "agent.mjs"] })
    expect(Either.isRight(decoded)).toBe(true)
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1 rejects an empty agentArgv", () => {
    const decoded = decode({ agentArgv: [] })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.7 accepts a non-empty cwd", () => {
    const decoded = decode({
      agentArgv: ["node"],
      cwd: "/work/agent",
    })
    expect(Either.isRight(decoded)).toBe(true)
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.7 rejects an empty-string cwd", () => {
    const decoded = decode({
      agentArgv: ["node"],
      cwd: "",
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8 accepts a prompt as plain text", () => {
    const decoded = decode({
      agentArgv: ["node"],
      prompt: "summarize the diff",
    })
    expect(Either.isRight(decoded)).toBe(true)
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 rejects an authorizedBindings pair whose target is not an env-var identifier", () => {
    const decoded = decode({
      agentArgv: ["node"],
      authorizedBindings: [["BAD;NAME", "ANTHROPIC_API_KEY"]],
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6 rejects an authorizedBindings pair whose source is not an env-var identifier", () => {
    const decoded = decode({
      agentArgv: ["node"],
      authorizedBindings: [["ANTHROPIC_API_KEY", "BAD;SOURCE"]],
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })
})

describe("runConfigToRuntimeContextIntent", () => {
  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.7 threads --cwd into RuntimeContextIntent.config.cwd", () => {
    const intent = runConfigToRuntimeContextIntent({
      ...validBase,
      cwd: "/work/agent",
    })
    expect(intent.config.cwd).toBe("/work/agent")
    expect(intent.provider).toBe("local-process")
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 threads envBindings through the durable intent", () => {
    const intent = runConfigToRuntimeContextIntent({
      ...validBase,
      envBindings: [{ name: "ANTHROPIC_API_KEY", ref: "env:PARENT_ANTHROPIC_KEY" }],
    })
    expect(intent.config.envBindings).toEqual([
      { name: "ANTHROPIC_API_KEY", ref: "env:PARENT_ANTHROPIC_KEY" },
    ])
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1 omits cwd/envBindings when not set", () => {
    const intent = runConfigToRuntimeContextIntent(validBase)
    expect("cwd" in intent.config).toBe(false)
    expect("envBindings" in intent.config).toBe(false)
  })
})

describe("runConfigToIngressRequest", () => {
  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8 returns a client-authored message request when --prompt is set", () => {
    const request = runConfigToIngressRequest(
      { ...validBase, prompt: "summarize" },
      "ctx_abc",
    )
    expect(request).toBeDefined()
    expect(request).toMatchObject({
      contextId: "ctx_abc",
      kind: "message",
      authoredBy: "client",
      payload: "summarize",
    })
    expect(request?.idempotencyKey).toBe("firegrid-run-prompt:ctx_abc")
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8 returns undefined when --prompt is absent", () => {
    expect(runConfigToIngressRequest(validBase, "ctx_abc")).toBeUndefined()
  })
})

describe("runConfigRequiresInput", () => {
  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8 returns true iff a --prompt is set", () => {
    expect(runConfigRequiresInput(validBase)).toBe(false)
    expect(runConfigRequiresInput({ ...validBase, prompt: "hi" })).toBe(true)
  })
})
