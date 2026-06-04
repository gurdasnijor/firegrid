export interface IncidentInput {
  readonly id: string
  readonly title: string
  readonly signal: "ci" | "runtime" | "security"
}

interface IncidentTriage {
  readonly severity: "low" | "medium" | "high"
  readonly route: "watch" | "worker" | "coordinator"
}

export const classifyIncident = (
  input: IncidentInput,
): IncidentTriage => {
  if (input.signal === "security") {
    return { severity: "high", route: "coordinator" }
  }
  if (input.signal === "runtime") {
    return { severity: "medium", route: "worker" }
  }
  return { severity: "low", route: "watch" }
}

export const draftPatchPlan = (
  input: IncidentInput,
  triage: IncidentTriage,
): string =>
  `${input.id}:${triage.route}:${triage.severity}:${input.title}`

export const publishTrace = (plan: string): string =>
  `trace:${plan}`
