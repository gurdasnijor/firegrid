import { Effect, Layer } from "effect"
import {
  EventProjector,
} from "../event-pipeline.ts"

export {
  projectRuntimeOutputToSessionState,
  RuntimeOutputSessionProjectorLive,
} from "./runtime-output-session-projector.ts"

export const IdentityEventProjectorLive = (
  options: {
    readonly name: string
    readonly version: string
  },
) =>
  Layer.succeed(
    EventProjector,
    EventProjector.of({
      name: options.name,
      version: options.version,
      project: event =>
        Effect.succeed({
          _tag: "Projected",
          events: [event],
        }),
    }),
  )

