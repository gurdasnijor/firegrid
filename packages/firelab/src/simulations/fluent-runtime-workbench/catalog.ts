/**
 * Gherkin step binding for the fluent-runtime acceptance driver. The operation
 * catalog is reflected from the live API contract (`OpenApi.fromApi(FluentRuntimeApi)`)
 * so a feature can only bind to routes the host actually serves; the path router
 * resolves a literal `When I <VERB> "<path>"` step to one operation + params.
 */
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin"
import { IdGenerator } from "@cucumber/messages"
import { OpenApi } from "@effect/platform"
import { FluentRuntimeApi } from "@firegrid/fluent-runtime"

interface Op {
  readonly operationId: string
  readonly method: string
  readonly pathTemplate: string
  readonly pathParams: ReadonlyArray<string>
}

export const buildCatalog = (): ReadonlyArray<Op> => {
  const spec = OpenApi.fromApi(FluentRuntimeApi) as {
    readonly paths: Record<string, Record<string, { readonly operationId?: string }>>
  }
  return Object.entries(spec.paths).flatMap(([pathTemplate, methods]) =>
    Object.entries(methods).map(([method, op]): Op => ({
      operationId: String(op.operationId),
      method: method.toUpperCase(),
      pathTemplate,
      pathParams: [...pathTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!),
    })))
}

interface RouteMatch {
  readonly op: Op
  readonly params: Record<string, string>
}

const tryMatch = (op: Op, want: ReadonlyArray<string>): RouteMatch | undefined => {
  const segs = op.pathTemplate.split("/").filter(Boolean)
  if (segs.length !== want.length) return undefined
  const params: Record<string, string> = {}
  const ok = segs.every((s, i) => {
    if (s.startsWith("{") && s.endsWith("}")) {
      params[s.slice(1, -1)] = want[i]!
      return true
    }
    return s === want[i]
  })
  return ok ? { op, params } : undefined
}

const matchRoute = (
  catalog: ReadonlyArray<Op>,
  method: string,
  path: string,
): RouteMatch | undefined => {
  const want = path.split("/").filter(Boolean)
  return catalog
    .filter((op) => op.method === method)
    .map((op) => tryMatch(op, want))
    .find((m): m is RouteMatch => m !== undefined)
}

export const concretePath = (op: Op, params: Record<string, string>): string =>
  op.pathTemplate.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`)

export type PlannedStep =
  | { readonly _tag: "callOp"; readonly op: Op; readonly params: Record<string, string>; readonly body?: unknown }
  | { readonly _tag: "expectStatus"; readonly status: number }
  | { readonly _tag: "expectField"; readonly field: string; readonly value: unknown }
  | { readonly _tag: "unbound"; readonly keyword: string; readonly text: string }

export interface ScenarioPlan {
  readonly name: string
  readonly steps: ReadonlyArray<PlannedStep>
}

const RE_WHEN = /^I (GET|POST|PUT|DELETE|PATCH) "([^"]+)"( with body)?$/
const RE_STATUS = /^the response status is (\d+)$/
const RE_FIELD = /^the response field "([^"]+)" equals (.+)$/

const parseValue = (raw: string): unknown => {
  try { return JSON.parse(raw) } catch { return raw.replace(/^"|"$/g, "") }
}

const bindStep = (
  catalog: ReadonlyArray<Op>,
  keyword: string,
  text: string,
  docString: string | undefined,
): PlannedStep => {
  const when = RE_WHEN.exec(text)
  if (when) {
    const match = matchRoute(catalog, when[1]!, when[2]!)
    if (!match) return { _tag: "unbound", keyword, text }
    return {
      _tag: "callOp",
      op: match.op,
      params: match.params,
      ...(docString === undefined ? {} : { body: parseValue(docString) }),
    }
  }
  const status = RE_STATUS.exec(text)
  if (status) return { _tag: "expectStatus", status: Number(status[1]) }
  const field = RE_FIELD.exec(text)
  if (field) return { _tag: "expectField", field: field[1]!, value: parseValue(field[2]!) }
  return { _tag: "unbound", keyword, text }
}

export const bindFeature = (catalog: ReadonlyArray<Op>, featureText: string): ReadonlyArray<ScenarioPlan> => {
  const parser = new Parser(new AstBuilder(IdGenerator.uuid()), new GherkinClassicTokenMatcher())
  const doc = parser.parse(featureText)
  return (doc.feature?.children ?? []).flatMap((child): ReadonlyArray<ScenarioPlan> => {
    const sc = child.scenario
    if (!sc) return []
    return [{
      name: sc.name,
      steps: sc.steps.map((step) => bindStep(catalog, step.keyword.trim(), step.text.trim(), step.docString?.content)),
    }]
  })
}
