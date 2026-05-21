import type {
  RuntimeAgentOutputObservationSchema,
} from "../session-facade/schema.ts"
import { Context } from "effect"
import {
  makeChannelTarget,
  type IngressChannel,
} from "./core.ts"

export const SessionAgentOutputChannelTarget = makeChannelTarget(
  "session.agent_output",
)

export type SessionAgentOutputChannelRegistration =
  IngressChannel<typeof RuntimeAgentOutputObservationSchema>

export interface SessionAgentOutputChannelService {
  readonly forContext: (
    contextId: string,
  ) => SessionAgentOutputChannelRegistration
}

export class SessionAgentOutputChannel extends Context.Tag(
  "firegrid/protocol/channels/session.agent_output",
)<
  SessionAgentOutputChannel,
  SessionAgentOutputChannelService
>() {}
