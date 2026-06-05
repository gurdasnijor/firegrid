/**
 * The "out" half of the non-invasive binding (SDD Appendix D/E;
 * fluent-mcp-tools-out.feature): Firegrid's durable tools are exposed to the
 * agent's own harness through the harness's OWN tool-call mechanism. The harness
 * decides to call a tool; Firegrid only serves it and records the invocation.
 *
 * The **gateway** is transport-agnostic — it routes a harness-initiated
 * invocation to the tool handler and records a durable invocation fact. A
 * **transport** (MCP-over-durable-streams is one) carries the catalog out to the
 * harness and delivers invocations in. The non-invasive property is the
 * invariant; the transport is replaceable.
 *
 * Firegrid NEVER injects an `agent.run` / owned model loop — the gateway has no
 * harness reference and cannot initiate a turn. It only responds to
 * harness-initiated invocations.
 */
import { Data } from "effect"

/** A durable tool the harness can discover and call. */
export interface DurableTool<A = unknown, R = unknown> {
  readonly name: string
  readonly description: string
  /** Pure-ish handler over decoded args; no harness/loop access by construction. */
  readonly handler: (args: A) => Promise<R> | R
}

export type DurableToolCatalog = ReadonlyArray<DurableTool>

/** A harness-initiated invocation. `via: "harness"` records the provenance. */
export interface ToolInvocation {
  readonly name: string
  readonly args: unknown
  readonly via: "harness"
}

/** The durable fact recorded for every served invocation. */
export interface ToolInvocationRecord {
  readonly name: string
  readonly args: unknown
  readonly result: unknown
  readonly via: "harness"
  readonly transport: string
}

export class DurableToolError extends Data.TaggedError("DurableToolError")<{
  readonly message: string
}> {}

export interface ToolGatewayDeps {
  /** Append a durable tool-invocation fact (e.g. onto the session stream). */
  readonly recordInvocation: (record: ToolInvocationRecord) => void
}

export interface ToolGateway {
  /** Tool names the harness can discover (the exposed catalog). */
  readonly list: () => ReadonlyArray<string>
  /**
   * Run a harness-initiated invocation: route → handler → durable record →
   * result. Does NOT drive any model loop.
   */
  readonly invoke: (
    invocation: ToolInvocation,
    transport: string,
  ) => Promise<unknown>
}

export const makeToolGateway = (
  catalog: DurableToolCatalog,
  deps: ToolGatewayDeps,
): ToolGateway => {
  const byName = new Map(catalog.map((tool) => [tool.name, tool] as const))
  return {
    list: () => catalog.map((tool) => tool.name),
    invoke: async (invocation, transport) => {
      const tool = byName.get(invocation.name)
      if (tool === undefined) {
        throw new DurableToolError({ message: `unknown durable tool: ${invocation.name}` })
      }
      const result = await tool.handler(invocation.args)
      deps.recordInvocation({
        name: invocation.name,
        args: invocation.args,
        result,
        via: invocation.via,
        transport,
      })
      return result
    },
  }
}

/**
 * A transport exposes the catalog to a harness and delivers harness-initiated
 * invocations to the gateway. It is the replaceable part — any compatible
 * transport over the SAME gateway yields identical durable-tool semantics.
 */
export interface ToolTransport {
  readonly id: string
  /** Tool names discoverable over this transport (the harness "asks for tools"). */
  readonly listTools: () => ReadonlyArray<string>
  /** Deliver a harness tool-call to the gateway and return the result. */
  readonly invokeTool: (name: string, args: unknown) => Promise<unknown>
}

/**
 * MCP-over-durable-streams transport — Firegrid's durable tools served to the
 * harness as MCP tools. One transport; the non-invasive property is the
 * invariant, not the protocol.
 */
export const makeMcpToolTransport = (gateway: ToolGateway): ToolTransport =>
  makeToolTransport("mcp-over-durable-streams", gateway)

/** Build a transport of the given id over a gateway (transport is replaceable). */
export const makeToolTransport = (
  id: string,
  gateway: ToolGateway,
): ToolTransport => ({
  id,
  listTools: () => gateway.list(),
  invokeTool: (name, args) => gateway.invoke({ name, args, via: "harness" }, id),
})
