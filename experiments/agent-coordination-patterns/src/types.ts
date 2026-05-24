export type ExperimentArm = "single" | "central" | "choreography"

export interface ParticipantRuntime {
  readonly agent: string
  readonly agentProtocol: "acp" | "stdio-jsonl"
  readonly command: ReadonlyArray<string>
  readonly secretEnv: ReadonlyArray<string>
}

export interface RunOptions {
  readonly runId: string
  readonly runDir: string
  readonly taskPath: string
  readonly arms: ReadonlyArray<ExperimentArm>
  readonly runtime: ParticipantRuntime
  readonly timeoutMs: number
}

export interface ArmCommandArtifact {
  readonly arm: ExperimentArm
  readonly command: ReadonlyArray<string>
  readonly cwd: string
  readonly tracePath: string
  readonly promptPath: string
  readonly startedAt: string
}

export interface ArmSummary {
  readonly arm: ExperimentArm
  readonly status: "completed" | "failed" | "blocked"
  readonly startedAt: string
  readonly finishedAt: string
  readonly exitCode?: number
  readonly signal?: string
  readonly durationMs: number
  readonly reason?: string
}

export interface TraceScore {
  readonly spans: number
  readonly errorSpans: number
  readonly agentSilentErrors: number
  readonly unknownChannelErrors: number
  readonly toolsCallSpans: number
  readonly permissionRequestSpans: number
  readonly sessionAgentOutputSpans: number
}

export interface ArmScore {
  readonly arm: string
  readonly summary?: ArmSummary
  readonly trace?: TraceScore
}
