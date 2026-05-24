export const boardChannels = [
  "coordination.work",
  "coordination.claims",
  "coordination.findings",
  "coordination.questions",
  "coordination.reviews",
  "coordination.final",
] as const

export interface CoordinationBoardRow {
  readonly rowId: string
  readonly runId: string
  readonly arm: string
  readonly channel: typeof boardChannels[number]
  readonly kind: string
  readonly workId?: string
  readonly claimId?: string
  readonly claimantSessionId?: string
  readonly observedCursor?: number
  readonly status?: string
  readonly title?: string
  readonly body?: string
  readonly createdAt: string
}

export const boardChannelStatus = {
  status: "specified-not-yet-registered",
  reason:
    "The live harness must not fake choreography with private file state. Register these as Firegrid channels before enabling the choreography arm.",
  channels: boardChannels,
} as const
