import type { RuntimeAgentOutputObservation } from "@firegrid/client-sdk/firegrid"

export type ExperimentArm = "single" | "central" | "choreography"

export interface InboundSignal {
  readonly atMs: number
  readonly channel:
    | "coordination.work"
    | "coordination.claims"
    | "coordination.findings"
    | "coordination.questions"
    | "coordination.reviews"
    | "coordination.final"
  readonly kind: string
  readonly title: string
  readonly body: string
  readonly workId?: string
  readonly status?: string
}

export interface ExperimentScenario {
  readonly id: string
  readonly name: string
  readonly axis: string
  readonly hypothesis: string
  readonly expectedDivergence: string
  readonly taskPacket: string
  readonly inboundSignals: ReadonlyArray<InboundSignal>
}

export interface ParticipantRuntime {
  readonly agent: string
  readonly agentProtocol: "acp" | "stdio-jsonl"
  readonly command: ReadonlyArray<string>
  readonly secretEnv: ReadonlyArray<string>
}

export interface RunOptions {
  readonly runId: string
  readonly runDir: string
  readonly scenario: ExperimentScenario
  readonly scenarioDir: string
  readonly taskPath: string
  readonly arms: ReadonlyArray<ExperimentArm>
  readonly runtime: ParticipantRuntime
  readonly timeoutMs: number
}

export interface ArmCommandArtifact {
  readonly scenarioId: string
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
  readonly scenarioId: string
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
  readonly scenarioId?: string
  readonly arm: string
  readonly summary?: ArmSummary
  readonly trace?: TraceScore
}
