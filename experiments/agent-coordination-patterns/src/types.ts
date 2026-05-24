import type { RuntimeAgentOutputObservation } from "@firegrid/client-sdk/firegrid"

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
  readonly runner: "client-host"
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly tracePath: string
  readonly promptPath: string
  readonly startedAt: string
}

export interface ArmSessionArtifact {
  readonly role: string
  readonly sessionId: string
  readonly contextId: string
  readonly outputCount: number
  readonly outputs: ReadonlyArray<RuntimeAgentOutputObservation>
}

export interface ArmSummary {
  readonly arm: ExperimentArm
  readonly status: "completed" | "failed" | "blocked"
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly reason?: string
  readonly sessionCount?: number
  readonly outputCount?: number
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
