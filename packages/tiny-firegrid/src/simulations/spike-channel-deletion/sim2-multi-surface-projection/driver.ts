/**
 * tf-35f4 Sim 2 — driver.
 *
 * Drives TWO projections of the SAME callable channel and reports the
 * substrate / response evidence the FINDING cites:
 *
 *   1. typed client-method projection: `firegrid.sessions.createOrLoad`
 *   2. sim-local MCP-tool projection: a thin tool-shaped wrapper that
 *      resolves `HostSessionsCreateOrLoadChannel` directly (no Firegrid
 *      client) and calls `binding.call(req)`
 *
 * For each projection the driver invokes the channel with a distinct
 * externalKey, then queries the substrate (`RuntimeControlPlaneTable
 * .contextRequests`) to compare the resulting rows.
 */

import { Firegrid } from "@firegrid/client-sdk/firegrid"
import { local } from "@firegrid/client-sdk/firegrid"
import {
  HostSessionsCreateOrLoadChannel,
  type HostSessionsCreateOrLoadRequest,
  type HostSessionsCreateOrLoadResponse,
} from "@firegrid/protocol/channels"
import {
  RuntimeControlPlaneTable,
  type RuntimeContextRequestRow,
} from "@firegrid/protocol/launch"
import { Effect } from "effect"

const claudeAgentArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const runtimeIntent = () =>
  local.jsonl({
    argv: [...claudeAgentArgv],
    agent: "claude-acp",
    agentProtocol: "acp",
    cwd: globalThis.process.cwd(),
    envBindings: [
      { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
    ],
  })

const buildRequest = (id: string): HostSessionsCreateOrLoadRequest => ({
  externalKey: {
    source: "tf-35f4-sim2",
    id,
  },
  runtime: runtimeIntent(),
  createdBy: "tf-35f4-sim2-driver",
})

interface ProjectionRunReport {
  readonly request: HostSessionsCreateOrLoadRequest
  readonly response: HostSessionsCreateOrLoadResponse
  readonly substrateRow: RuntimeContextRequestRow
}

/**
 * Projection A — typed client-method surface.
 * Invokes `firegrid.sessions.createOrLoad`, which (post-tf-35f4 rewire)
 * dispatches via `HostSessionsCreateOrLoadChannel.binding.call`.
 */
export const runClientMethodProjection = (
  request: HostSessionsCreateOrLoadRequest,
): Effect.Effect<
  ProjectionRunReport,
  unknown,
  Firegrid | RuntimeControlPlaneTable
> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad(request)
    // sessionId === contextId in v1 per session-facade schema; the
    // handle exposes sessionId as the branded FiregridSessionId. The
    // channel response shape uses the brand for both.
    const response: HostSessionsCreateOrLoadResponse = {
      sessionId: session.sessionId,
      contextId: session.sessionId,
    }
    const substrateRow = yield* requireContextRequestRow(response.contextId)
    return { request, response, substrateRow }
  }).pipe(
    Effect.withSpan(
      "tf-35f4.sim2.projection.client_method.run",
      {
        kind: "internal",
        attributes: {
          "tf-35f4.projection.name": "client-method",
          "tf-35f4.projection.entry":
            "firegrid.sessions.createOrLoad",
          "tf-35f4.channel.target":
            "host.sessions.create_or_load",
        },
      },
    ),
  )

/**
 * Projection B — sim-local MCP-tool-style projection.
 * Resolves the SAME `HostSessionsCreateOrLoadChannel` Tag directly and
 * invokes `binding.call`. Stands in for the
 * not-yet-shipped `session.create_or_load` MCP tool implementation,
 * which would lower to exactly this call.
 */
export const runMcpToolProjection = (
  request: HostSessionsCreateOrLoadRequest,
): Effect.Effect<
  ProjectionRunReport,
  unknown,
  HostSessionsCreateOrLoadChannel | RuntimeControlPlaneTable
> =>
  Effect.gen(function*() {
    const channel = yield* HostSessionsCreateOrLoadChannel
    const response = yield* channel.binding.call(request)
    const substrateRow = yield* requireContextRequestRow(response.contextId)
    return { request, response, substrateRow }
  }).pipe(
    Effect.withSpan(
      "tf-35f4.sim2.projection.mcp_tool.run",
      {
        kind: "internal",
        attributes: {
          "tf-35f4.projection.name": "mcp-tool",
          "tf-35f4.projection.entry":
            "session.create_or_load (MCP tool shape)",
          "tf-35f4.channel.target":
            "host.sessions.create_or_load",
        },
      },
    ),
  )

const requireContextRequestRow = (
  contextId: string,
): Effect.Effect<
  RuntimeContextRequestRow,
  unknown,
  RuntimeControlPlaneTable
> =>
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    const rows = yield* control.contextRequests.query((coll) =>
      coll.toArray.filter(row => row.contextId === contextId))
    const row = rows[0]
    if (row === undefined) {
      return yield* Effect.fail(
        new Error(
          `tf-35f4 Sim 2: no contextRequests row found for contextId ${contextId}`,
        ),
      )
    }
    if (rows.length !== 1) {
      return yield* Effect.fail(
        new Error(
          `tf-35f4 Sim 2: expected exactly 1 contextRequests row for contextId ${contextId}, got ${rows.length}`,
        ),
      )
    }
    return row
  })

export const buildRequestForProjection = (
  projectionName: "client-method" | "mcp-tool",
): HostSessionsCreateOrLoadRequest =>
  buildRequest(`projection-${projectionName}`)
