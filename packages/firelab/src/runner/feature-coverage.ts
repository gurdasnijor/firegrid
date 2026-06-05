/**
 * Feature-coverage checker — the bridge between an acai `*.feature.yaml`
 * acceptance spec and a firelab experiment's forge-proof coverage.
 *
 * acai ACID format (acai.sh/feature-yaml): `<feature-name>.<GROUP_KEY>.<ID>`,
 * derived (never an explicit field) — `<feature-name>` = `feature.name`,
 * `<GROUP_KEY>` = a component OR constraint key, `<ID>` = the requirement key
 * (integer with at most one dash sub-level, e.g. `1`, `3-1`).
 *
 * The contract this enforces (the task-exit done-bar): every requirement ACID
 * maps **1:1** to exactly one green, non-vacuous, host-substrate gate — each gate
 * proves exactly one ACID (`ClaimDef.acid`), each ACID proven by exactly one gate.
 * Pure (no I/O): the caller reads the YAML text + supplies the run's CoverageReport.
 */
import { parse as parseYaml } from "yaml"
import type { CoverageReport, CoverageSpec } from "./coverage.ts"

interface FeatureRequirement {
  readonly acid: string
  readonly text: string
}

interface FeatureSpec {
  readonly name: string
  readonly requirements: ReadonlyArray<FeatureRequirement>
}

interface RawGroup {
  readonly requirements?: Record<string, unknown>
}
interface RawFeatureDoc {
  readonly feature?: { readonly name?: string }
  readonly components?: Record<string, RawGroup>
  readonly constraints?: Record<string, RawGroup>
}

/** Parse a `.feature.yaml` into its derived ACIDs (components + constraints). */
export const parseFeature = (yamlText: string): FeatureSpec => {
  const doc = (parseYaml(yamlText) ?? {}) as RawFeatureDoc
  const name = doc.feature?.name ?? ""
  const groups = { ...(doc.components ?? {}), ...(doc.constraints ?? {}) }
  const requirements = Object.entries(groups).flatMap(([groupKey, group]) =>
    Object.entries(group?.requirements ?? {}).map((entry): FeatureRequirement => ({
      acid: `${name}.${groupKey}.${entry[0]}`,
      text: String(entry[1]),
    })),
  )
  return { name, requirements }
}

type AcidStatus = "covered" | "uncovered" | "red" | "vacuous"

interface AcidRow {
  readonly acid: string
  readonly text: string
  readonly gateId?: string
  readonly status: AcidStatus
  /** the host-substrate span the proving gate names (forge-proof evidence). */
  readonly span?: string
}

interface FeatureCheck {
  readonly feature: string
  readonly rows: ReadonlyArray<AcidRow>
  /** gate acids that are not a real requirement in the feature (a dangling cite). */
  readonly danglingGateAcids: ReadonlyArray<string>
  /** acids cited by more than one gate (breaks the 1:1 bijection). */
  readonly duplicateAcids: ReadonlyArray<string>
  /** every requirement ACID is covered 1:1 by a green, non-vacuous gate. */
  readonly fullyCovered: boolean
}

/**
 * Join the experiment's gates (each carrying an `acid`) with the run's verdict
 * and the feature's derived ACIDs; enforce the 1:1 bijection + completeness.
 */
export const checkFeatureCoverage = (
  spec: CoverageSpec,
  report: CoverageReport,
  feature: FeatureSpec,
): FeatureCheck => {
  const resultById = new Map(report.gates.map((g) => [g.id, g] as const))
  const gatesByAcid = new Map<string, Array<string>>()
  spec.gates.forEach((g) => {
    if (g.acid === undefined) return
    const arr = gatesByAcid.get(g.acid) ?? []
    arr.push(g.id)
    gatesByAcid.set(g.acid, arr)
  })
  const featureAcids = new Set(feature.requirements.map((r) => r.acid))
  const duplicateAcids = [...gatesByAcid.entries()].filter(([, ids]) => ids.length > 1).map(([a]) => a)
  const danglingGateAcids = [...gatesByAcid.keys()].filter((a) => !featureAcids.has(a))

  const rows = feature.requirements.map((req): AcidRow => {
    const gateId = (gatesByAcid.get(req.acid) ?? [])[0]
    if (gateId === undefined) return { acid: req.acid, text: req.text, status: "uncovered" }
    const res = resultById.get(gateId)
    const status: AcidStatus =
      res === undefined ? "uncovered" : res.vacuous ? "vacuous" : res.status === "pass" ? "covered" : "red"
    const span = res?.refs[0]
    return span === undefined
      ? { acid: req.acid, text: req.text, gateId, status }
      : { acid: req.acid, text: req.text, gateId, status, span }
  })

  const fullyCovered =
    duplicateAcids.length === 0 &&
    danglingGateAcids.length === 0 &&
    rows.every((r) => r.status === "covered")
  return { feature: feature.name, rows, danglingGateAcids, duplicateAcids, fullyCovered }
}
