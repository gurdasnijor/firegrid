/**
 * tf-v7t: Project-local `.mcp.json` writer at the agent-cwd boundary.
 *
 * Replaces the codec's `_meta.claudeCode.options.mcpServers` injection
 * (the `-alwaysload` alias hack documented in
 * `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts` §
 * `claudeAgentAcpAlwaysLoadMeta`). Spike `tf-s8y` (PR #444) verified the
 * native `.mcp.json` path: claude-agent-sdk loads it via
 * `settingSources: ["user","project","local"]` (set by
 * `claude-agent-acp@0.36.1` `acp-agent.js:1414`), tools surface under
 * natural names (`mcp__firegrid__<tool>`), and the agent invokes them.
 *
 * Shape:
 *   ```json
 *   {
 *     "mcpServers": {
 *       "firegrid-runtime-context": {
 *         "type": "http",
 *         "url": "http://127.0.0.1:<port>/mcp/runtime-context/<contextId>",
 *         "alwaysLoad": true
 *       }
 *     }
 *   }
 *   ```
 *
 * `alwaysLoad: true` is a first-class field of `McpHttpServerConfig`
 * (`@anthropic-ai/claude-agent-sdk@0.3.143/sdk.d.ts:951-961`), not a
 * codec-side workaround. No alias renaming.
 *
 * Called from `codec-adapter.ts:resolveEffectiveMcpServers` when the
 * `runtimeContextMcp` marker is enabled. The codec adapter holds the
 * materialized URL (from `FiregridRuntimeContextMcpBaseUrl` +
 * `runtimeContextMcpUrlForContext`); this writer just persists it.
 *
 * `.claude/settings.json` with `enableAllProjectMcpServers: true` is
 * also written so the agent auto-approves the server without an
 * interactive prompt
 * (`@anthropic-ai/claude-agent-sdk@0.3.143/sdk.d.ts:4019-4021`).
 */

import { Data, Effect } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { McpServerDeclaration } from "@firegrid/protocol/launch"

class McpJsonWriteError extends Data.TaggedError("McpJsonWriteError")<{
  readonly op: string
  readonly cwd: string
  readonly cause: unknown
}> {
  get message(): string {
    return `mcp-json-writer/${this.op} failed in cwd=${this.cwd}: ${String(this.cause)}`
  }
}

const mcpJsonContents = (
  declarations: ReadonlyArray<McpServerDeclaration>,
): string => {
  const mcpServers = Object.fromEntries(
    declarations.map(declaration => {
      const server = declaration.server
      return [
        declaration.name,
        {
          type: "http" as const,
          url: server.url,
          ...(server.headers === undefined ? {} : { headers: server.headers }),
          alwaysLoad: true as const,
        },
      ] as const
    }),
  )
  return JSON.stringify({ mcpServers }, null, 2) + "\n"
}

const claudeSettingsContents = (): string =>
  JSON.stringify({ enableAllProjectMcpServers: true }, null, 2) + "\n"

/**
 * Writes `.mcp.json` and `.claude/settings.json` into `cwd`. Both files
 * are project-local SDK configuration; the SDK loads them via
 * `settingSources` and approves servers via `enableAllProjectMcpServers`.
 *
 * Idempotent: re-writes on each call. Caller (codec-adapter) gates this
 * to once per session-start path.
 */
export const writeFiregridMcpJson = (params: {
  readonly cwd: string
  readonly declarations: ReadonlyArray<McpServerDeclaration>
}): Effect.Effect<void, McpJsonWriteError> =>
  Effect.gen(function*() {
    yield* Effect.tryPromise({
      try: () => mkdir(join(params.cwd, ".claude"), { recursive: true }),
      catch: (cause) => new McpJsonWriteError({ op: "mkdir", cwd: params.cwd, cause }),
    })
    yield* Effect.tryPromise({
      try: () =>
        writeFile(join(params.cwd, ".mcp.json"), mcpJsonContents(params.declarations)),
      catch: (cause) =>
        new McpJsonWriteError({ op: "write-mcp-json", cwd: params.cwd, cause }),
    })
    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          join(params.cwd, ".claude", "settings.json"),
          claudeSettingsContents(),
        ),
      catch: (cause) =>
        new McpJsonWriteError({ op: "write-claude-settings", cwd: params.cwd, cause }),
    })
  }).pipe(
    Effect.withSpan("firegrid.host.codec.write_mcp_json", {
      kind: "internal",
      attributes: {
        "firegrid.codec.mcp_json.cwd": params.cwd,
        "firegrid.codec.mcp_json.server_count": params.declarations.length,
        "firegrid.codec.mcp_json.server_names": params.declarations
          .map(d => d.name)
          .sort()
          .join(","),
      },
    }),
  )
