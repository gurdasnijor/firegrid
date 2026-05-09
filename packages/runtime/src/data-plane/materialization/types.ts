import type {
  RuntimeEvent,
  RuntimeOutputCursor,
} from "@firegrid/protocol/launch"
import type {
  MessageProjection,
  SessionProjection,
} from "@firegrid/protocol/session"

export type MaterializerFailure = {
  readonly sourceRuntimeEventId: string
  readonly reason: string
  readonly cause?: unknown
}

export type MaterializerChange =
  | {
    readonly kind: "upsertSession"
    readonly value: SessionProjection
  }
  | {
    readonly kind: "upsertMessage"
    readonly value: MessageProjection
  }

export type MaterializerProjectResult = {
  readonly changes: ReadonlyArray<MaterializerChange>
  readonly failures: ReadonlyArray<MaterializerFailure>
}

export type RuntimeOutputMaterializer = {
  readonly name: string
  readonly version: string
  readonly project: (
    row: RuntimeEvent,
  ) => MaterializerProjectResult
}

export type MaterializerSummary = {
  readonly rowsRead: number
  readonly rowsProjected: number
  /**
   * Schema-valid runtime rows passed to the materializer that it chose not to
   * project, usually because the provider payload was not a supported shape.
   */
  readonly rowsIgnored: number
  /**
   * Reserved for future materializers that explicitly distinguish successful
   * zero-change projections from unsupported rows.
   */
  readonly rowsEmpty: number
  readonly rowsFailed: number
  readonly changesEmitted: number
  readonly failures: ReadonlyArray<MaterializerFailure>
}

export interface MaterializeRuntimeOutputToSessionOptions {
  readonly sourceDataPlaneStreamUrl: string
  readonly targetSessionStreamUrl: string
  readonly contextId: string
  readonly materializer: RuntimeOutputMaterializer
  readonly since?: RuntimeOutputCursor
}
