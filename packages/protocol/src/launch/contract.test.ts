import { Effect, Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  decodeLaunchConfig,
  envBinding,
  firegridRuntimeContextMcpDeclaration,
  firegridRuntimeContextMcpName,
  injectLaunchMcpDeclaration,
  local,
  McpServerDeclarationSchema,
  normalizeRuntimeIntent,
  PublicLaunchRequestSchema,
  RuntimeEventSchema,
} from "./index.ts"

describe("@firegrid/protocol launch schema", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 rejects public launch requests with env or journal fields", () => {
    const decoded = Schema.decodeUnknownEither(PublicLaunchRequestSchema)({
      runtime: {
        provider: "local-process",
        config: {
          argv: ["node", "--version"],
          env: {
            ANTHROPIC_API_KEY: "must-not-persist",
          },
        },
        journal: [
          { source: "stdout", format: "jsonl", target: "events" },
          { source: "stderr", format: "text-lines", target: "logs" },
        ],
      },
    })

    expect(Either.isLeft(decoded)).toBe(true)
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.8 keeps local JSONL defaults out of public helper output until normalization", () => {
    const publicRuntime = local.jsonl({
      argv: ["node", "--version"],
    })
    expect("journal" in publicRuntime).toBe(false)

    const normalized = normalizeRuntimeIntent(publicRuntime)
    expect(normalized.journal).toContainEqual({
      source: "stdout",
      format: "jsonl",
      target: "events",
    })
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 accepts envBindings on a public launch request as durable refs", () => {
    const decoded = Schema.decodeUnknownSync(PublicLaunchRequestSchema)({
      runtime: {
        provider: "local-process",
        config: {
          argv: ["node", "agent.mjs"],
          envBindings: [
            { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
            { name: "ANTHROPIC_API_KEY_ALT", ref: "env:PARENT_ANTHROPIC_KEY" },
          ],
        },
      },
    })

    expect(decoded.runtime.config.envBindings).toEqual([
      { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
      { name: "ANTHROPIC_API_KEY_ALT", ref: "env:PARENT_ANTHROPIC_KEY" },
    ])
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 envBinding helper produces a durable ref-only binding", () => {
    expect(envBinding("ANTHROPIC_API_KEY")).toEqual({
      name: "ANTHROPIC_API_KEY",
      ref: "env:ANTHROPIC_API_KEY",
    })
    expect(envBinding("ANTHROPIC_API_KEY", "PARENT_ANTHROPIC_KEY")).toEqual({
      name: "ANTHROPIC_API_KEY",
      ref: "env:PARENT_ANTHROPIC_KEY",
    })
  })

  it("firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5 normalization preserves envBindings on the runtime intent", () => {
    const intent = normalizeRuntimeIntent(local.jsonl({
      argv: ["node", "agent.mjs"],
      envBindings: [{ name: "X", ref: "env:Y" }],
    }))
    expect(intent.config.envBindings).toEqual([{ name: "X", ref: "env:Y" }])
  })

  it("firegrid-local-mcp-run.LAUNCH_CONFIG.3 firegrid-factory-aligned-agent-tools.RUNTIME_CODEC.1 decodes schema-owned runtime agent protocol selection", () => {
    const decoded = Schema.decodeUnknownSync(PublicLaunchRequestSchema)({
      runtime: {
        provider: "local-process",
        config: {
          argv: ["node", "agent.mjs"],
          agentProtocol: "stdio-jsonl",
        },
      },
    })

    expect(decoded.runtime.config.agentProtocol).toBe("stdio-jsonl")
    expect(normalizeRuntimeIntent(decoded.runtime).config.agentProtocol).toBe("stdio-jsonl")
  })

  it("firegrid-local-mcp-run.LAUNCH_CONFIG.3 rejects unknown runtime agent protocols", () => {
    const decoded = Schema.decodeUnknownEither(PublicLaunchRequestSchema)({
      runtime: {
        provider: "local-process",
        config: {
          argv: ["node", "agent.mjs"],
          agentProtocol: "provider-config-hidden-codec",
        },
      },
    })

    expect(Either.isLeft(decoded)).toBe(true)
  })

  it("firegrid-local-mcp-run.LAUNCH_CONFIG.1 decodes Firegrid-neutral URL MCP declarations and rejects ACP-specific http lowering", () => {
    const decoded = Schema.decodeUnknownEither(McpServerDeclarationSchema)({
      name: "custom-tools",
      server: {
        type: "url",
        url: "http://127.0.0.1:54321/mcp/runtime-context/ctx_test",
        headers: { "x-test": "1" },
      },
    })
    expect(Either.isRight(decoded)).toBe(true)

    const acpLowered = Schema.decodeUnknownEither(McpServerDeclarationSchema)({
      type: "http",
      name: "custom-tools",
      url: "http://127.0.0.1:54321/mcp/runtime-context/ctx_test",
      headers: [],
    })
    expect(Either.isLeft(acpLowered)).toBe(true)
  })

  it("firegrid-local-mcp-run.LAUNCH_CONFIG.3 firegrid-local-mcp-run.LAUNCH_CONFIG.4 decodes CLI launch config in protocol", async () => {
    const decoded = await Effect.runPromise(decodeLaunchConfig({
      agent: "codex-acp",
      agentArgv: ["npx", "-y", "@zed-industries/codex-acp@0.14.0"],
      prompt: "summarize",
    }))

    expect(decoded).toMatchObject({
      agent: "codex-acp",
      agentArgv: ["npx", "-y", "@zed-industries/codex-acp@0.14.0"],
      prompt: "summarize",
    })
  })

  it("firegrid-local-mcp-run.MCP_ROUTE.3 firegrid-local-mcp-run.MCP_ROUTE.4 firegrid-local-mcp-run.LAUNCH_CONFIG.5 injects the generated runtime-context MCP declaration by default", async () => {
    const decoded = await Effect.runPromise(decodeLaunchConfig({
      agentArgv: ["node", "agent.mjs"],
      mcpServers: [
        {
          name: "caller-tools",
          server: {
            type: "url",
            url: "http://127.0.0.1:5555/mcp",
          },
        },
      ],
    }))
    const normalized = injectLaunchMcpDeclaration(
      decoded,
      firegridRuntimeContextMcpDeclaration("http://127.0.0.1:54321/mcp/runtime-context/ctx_test"),
    )

    expect(normalized.mcpServers).toEqual([
      {
        name: firegridRuntimeContextMcpName,
        server: {
          type: "url",
          url: "http://127.0.0.1:54321/mcp/runtime-context/ctx_test",
        },
      },
      {
        name: "caller-tools",
        server: {
          type: "url",
          url: "http://127.0.0.1:5555/mcp",
        },
      },
    ])
  })

  it("firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.3 decodes runtime event rows without parsing provider JSON", () => {
    const event = Schema.decodeUnknownSync(RuntimeEventSchema)({
      eventId: {
        contextId: "ctx-1",
        activityAttempt: 1,
        target: "events",
        sequence: 0,
      },
      contextId: "ctx-1",
      activityAttempt: 1,
      sequence: 0,
      source: "stdout",
      format: "jsonl",
      receivedAt: "2026-05-07T00:00:00.000Z",
      raw: "{\"type\":\"assistant\"}",
    })

    expect(event).toMatchObject({
      raw: "{\"type\":\"assistant\"}",
    })
  })
})
