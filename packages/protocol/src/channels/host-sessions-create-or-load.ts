/**
 * Per-channel contract: `host.sessions.createOrLoad` — callable channel
 * that takes a `SessionCreateOrLoadInput` and returns a stable session-
 * handle identity (`{sessionId, contextId}`).
 *
 * This module is the CONTRACT side only. It declares the channel target,
 * the request/response schemas, and the per-channel `Context.Tag` service
 * identity. It does NOT bind to DurableTable, control plane, or any
 * runtime substrate — those live in host-sdk/runtime Live Layer
 * packages (per the channel placement rule: contracts in protocol, live
 * bindings below the contract line).
 *
 * tf-35f4 / tf-kddg finish-line contribution: this is the first concrete
 * callable channel pair to land its CONTRACT in `@firegrid/protocol` and
 * its DEFAULT Live Layer in host-sdk, with two projections (typed client
 * method + sim-local MCP tool) lowering through the SAME contract.
 */

import { Context } from "effect"
import {
  SessionCreateOrLoadInputSchema,
  SessionHandleReferenceSchema,
} from "../session-facade/schema.ts"
import {
  makeChannelTarget,
  type CallableChannel,
  type ChannelTarget,
} from "./core.ts"

export const HostSessionsCreateOrLoadChannelTarget: ChannelTarget =
  makeChannelTarget("host.sessions.create_or_load")

export const HostSessionsCreateOrLoadRequestSchema =
  SessionCreateOrLoadInputSchema
export type HostSessionsCreateOrLoadRequest =
  typeof HostSessionsCreateOrLoadRequestSchema.Type

export const HostSessionsCreateOrLoadResponseSchema =
  SessionHandleReferenceSchema
export type HostSessionsCreateOrLoadResponse =
  typeof HostSessionsCreateOrLoadResponseSchema.Type

export type HostSessionsCreateOrLoadChannelShape = CallableChannel<
  typeof HostSessionsCreateOrLoadRequestSchema,
  typeof HostSessionsCreateOrLoadResponseSchema
>

export class HostSessionsCreateOrLoadChannel extends Context.Tag(
  "@firegrid/protocol/channels/HostSessionsCreateOrLoadChannel",
)<HostSessionsCreateOrLoadChannel, HostSessionsCreateOrLoadChannelShape>() {}
