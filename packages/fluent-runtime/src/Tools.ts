/**
 * The "out" half of the non-invasive binding (SDD Appendix D/E;
 * fluent-mcp-tools-out.feature): Firegrid's durable tools are exposed to the
 * agent's own harness through the harness's OWN tool-call mechanism.
 *
 * This is built ON `@effect/ai` — the tool surface is NOT reinvented:
 *  - `Tool.make` defines each tool (name, parameter + success schemas);
 *  - `Toolkit.make` groups them; `Toolkit.toLayer` provides the handlers;
 *  - `Toolkit.WithHandler.handle` does decode → validate → execute → encode;
 *  - `McpServer.registerToolkit` / `McpServer.toolkit` give the real MCP
 *    list/call behavior (one transport).
 *
 * Firegrid-specific code is ONLY:
 *  1. `DurableToolRecorder` + the handler wrap that records a durable invocation
 *     fact after each execution (transport-agnostic — recorded once per call);
 *  2. `handleDurableToolCall` — adapting a durable-stream-delivered tool call to
 *     `Toolkit.WithHandler.handle`.
 *
 * The handlers run only when the harness invokes (via MCP or the durable-stream
 * adapter); Firegrid never injects an `agent.run` / owned model loop.
 */
import { McpServer, Tool, Toolkit } from "@effect/ai"
import { Context, Effect, Schema } from "effect"

/** The durable fact recorded for every served tool invocation. */
export interface ToolInvocationRecord {
  readonly name: string
  readonly params: unknown
  readonly result: unknown
  /** Provenance: the call arrived through the harness's own tool-call path. */
  readonly via: "harness"
}

/** Records durable tool-invocation facts (e.g. onto the session stream). */
export class DurableToolRecorder extends Context.Tag(
  "@firegrid/fluent-runtime/Tools/DurableToolRecorder",
)<
  DurableToolRecorder,
  { readonly recordInvocation: (record: ToolInvocationRecord) => Effect.Effect<void> }
>() {}

// ── Tool definitions (Tool.make) — the durable tool catalog. ──
export const WaitForTool = Tool.make("wait_for", {
  description: "Wait until a host-declared channel emits a matching row.",
  parameters: { channel: Schema.String },
  success: Schema.Struct({
    matched: Schema.Boolean,
    event: Schema.optional(Schema.Unknown),
  }),
})

/** The Firegrid durable-tool toolkit exposed to the harness. */
export const FluentToolkit = Toolkit.make(WaitForTool)

/** The concrete tool semantics (provided per deployment; e.g. wired to waits). */
export interface FluentToolHandlers {
  readonly wait_for: (
    params: { readonly channel: string },
  ) => Effect.Effect<{ readonly matched: boolean; readonly event?: unknown }>
}

/**
 * The Firegrid wrap: provide the toolkit's handlers, each recording a durable
 * invocation fact after execution. Requires `DurableToolRecorder`. The recording
 * is at the handler level, so it fires once per execution regardless of which
 * transport (MCP server / durable-stream adapter) drove the call.
 */
export const fluentToolkitLayer = (handlers: FluentToolHandlers) =>
  FluentToolkit.toLayer(
    Effect.gen(function* () {
      const recorder = yield* DurableToolRecorder
      return {
        wait_for: (params) =>
          handlers.wait_for(params).pipe(
            Effect.tap((result) =>
              recorder.recordInvocation({ name: "wait_for", params, result, via: "harness" })),
          ),
      }
    }),
  )

/**
 * The MCP transport: register the toolkit so a real harness gets MCP list/call
 * over the connected server. Compose with `McpServer.layer*` + `fluentToolkitLayer`
 * + a `DurableToolRecorder`. One transport; the non-invasive property is the
 * invariant, not the protocol.
 */
export const fluentMcpServerLayer = McpServer.toolkit(FluentToolkit)

/**
 * The durable-stream transport adapter: drive a durable-stream-delivered tool
 * call through `Toolkit.WithHandler.handle` (decode/validate/execute/encode +
 * the durable-recording wrap). Same handlers as the MCP path → identical
 * semantics; the transport is replaceable.
 */
export const handleDurableToolCall = <Name extends keyof typeof FluentToolkit.tools>(
  name: Name,
  params: Tool.Parameters<(typeof FluentToolkit.tools)[Name]>,
) => Effect.flatMap(FluentToolkit, (withHandler) => withHandler.handle(name, params))
