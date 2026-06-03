/**
 * tf-7whh — Firegrid operation × surface inventory (EVIDENCE ONLY).
 *
 * Produces a machine-generated, deterministic, re-runnable inventory of every
 * Firegrid operation and which surface declares it. The goal is a ground-truth
 * evidence base — NOT a redesign. Every cell carries a `file:line` reference.
 *
 * Approach (stated in the PR description too):
 *   1. RUNTIME REFLECTION for the `firegridProjection`-annotated surfaces.
 *      We import the agent-tool / session-facade schema catalogs and read each
 *      schema's annotation via `getFiregridProjectionMetadata`. This captures
 *      the RESOLVED projection values (operationId / toolName / clientName /
 *      cliName) exactly as they land on the AST — the most accurate source.
 *   2. TYPESCRIPT-COMPILER-API AST for `file:line` anchors and for the channel
 *      surface, which does NOT use `firegridProjection`: it authors via
 *      `makeChannelTarget` + `make*Channel({ target, requestSchema, ... })`.
 *      We resolve channel-target identifiers to their string values by
 *      reflecting the protocol channels barrel.
 *
 * Cross-surface joins (the operation × surface matrix) are HEURISTIC and are
 * labelled with their `basis`; every unmatched declaration is reported so
 * nothing is silently dropped. We import `effect` indirectly (through the
 * protocol modules) and read the returned `Option` shape structurally so the
 * tool can run from the repo root, where `effect` is not hoisted.
 *
 * Run:  pnpm inventory:operations      (writes docs/findings/tf-7whh-*.{json,md})
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"

import { getFiregridProjectionMetadata } from "../packages/protocol/src/projection/schema.ts"
import * as AgentToolsSchema from "../packages/protocol/src/agent-tools/schema.ts"
import * as SessionFacadeSchema from "../packages/protocol/src/session-facade/schema.ts"
import * as ChannelsBarrel from "../packages/protocol/src/channels/index.ts"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const rel = (abs: string) => path.relative(ROOT, abs)

// ── Option read (structural — avoid a root-level `effect` import) ────────────
export const optionValue = <A>(o: unknown): A | null => {
  const opt = o as { _tag?: string; value?: A }
  return opt && opt._tag === "Some" ? (opt.value as A) : null
}

interface ProjectionMeta {
  readonly operationId: string
  readonly toolName?: string
  readonly clientName?: string
  readonly cliName?: string
}

/**
 * Effect Schemas are CALLABLE (they are functions, not plain objects) and carry
 * `.ast` reachable via property access (it is not enumerated by the `in`
 * operator). Accept any object/function exposing a truthy `.ast`.
 */
export const isSchemaLike = (value: unknown): boolean =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  Boolean((value as { ast?: unknown }).ast)

// ── TS AST helpers ──────────────────────────────────────────────────────────
export const sourceFileOf = (absPath: string): ts.SourceFile =>
  ts.createSourceFile(
    absPath,
    fs.readFileSync(absPath, "utf8"),
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
  )

export const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

export const isExported = (node: ts.VariableStatement): boolean =>
  (node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

/** Map every `export const NAME = ...` → its 1-based declaration line. */
export const exportConstLines = (sf: ts.SourceFile): Map<string, number> => {
  const out = new Map<string, number>()
  sf.forEachChild((node) => {
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) out.set(decl.name.text, lineOf(sf, decl.name))
      }
    }
  })
  return out
}

export const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => {
  visit(node)
  node.forEachChild((c) => walk(c, visit))
}

export const stringLiteralValue = (n: ts.Node | undefined): string | undefined =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined

// ─────────────────────────────────────────────────────────────────────────────
// SURFACE 1 — agent-tool schemas (firegridProjection via toolAnnotations)
// ─────────────────────────────────────────────────────────────────────────────
interface AgentToolRow {
  readonly exportName: string
  readonly ref: string
  readonly schemaKind: "input" | "output"
  readonly operationId: string
  readonly toolName: string | null
  readonly clientName: string | null
  readonly cliName: string | null
}

const inventoryAgentTools = (): {
  rows: Array<AgentToolRow>
  reflectionMisses: Array<string>
} => {
  const file = path.join(ROOT, "packages/protocol/src/agent-tools/schema.ts")
  const lines = exportConstLines(sourceFileOf(file))
  const refOf = (name: string): string => {
    const line = lines.get(name)
    return line ? `${rel(file)}:${line}` : rel(file)
  }

  // An agent-tool operation is ANY exported schema carrying projection metadata.
  // We do NOT pre-filter by export-name convention: the projection annotation is
  // the ground truth (e.g. `PermissionRespondInputSchema` /
  // `SessionStatusInputSchema` do not end in `ToolInputSchema`). Output refs are
  // paired by the `InputSchema`→`OutputSchema` name convention (output schemas
  // carry no projection, so they cannot be discovered by reflection).
  const outputRefByName = new Map<string, string>()
  for (const name of Object.keys(AgentToolsSchema)) {
    if (name.endsWith("OutputSchema")) outputRefByName.set(name, refOf(name))
  }

  const rows: Array<AgentToolRow> = []
  const reflectionMisses: Array<string> = []
  for (const [exportName, value] of Object.entries(AgentToolsSchema)) {
    if (!isSchemaLike(value)) continue
    const meta = optionValue<ProjectionMeta>(getFiregridProjectionMetadata(value as never))
    if (meta) {
      rows.push({
        exportName,
        ref: refOf(exportName),
        schemaKind: "input",
        operationId: meta.operationId,
        toolName: meta.toolName ?? null,
        clientName: meta.clientName ?? null,
        cliName: meta.cliName ?? null,
      })
    } else if (exportName.endsWith("InputSchema")) {
      // Named like an input op but carrying no projection — a real gap to flag.
      reflectionMisses.push(exportName)
    }
  }

  // Attach paired output refs (best-effort, by name convention).
  const withOutputs: Array<AgentToolRow> = rows.map((r) => {
    const outName = r.exportName.replace(/InputSchema$/, "OutputSchema")
    const outputRef = outputRefByName.get(outName) ?? null
    return { ...r, outputRef }
  })
  withOutputs.sort((a, b) => a.operationId.localeCompare(b.operationId))
  return { rows: withOutputs, reflectionMisses }
}

// ─────────────────────────────────────────────────────────────────────────────
// SURFACE 2 — session-facade schemas (firegridProjection operationId)
// ─────────────────────────────────────────────────────────────────────────────
interface SessionFacadeRow {
  readonly exportName: string
  readonly ref: string
  readonly operationId: string
}

const inventorySessionFacade = (): Array<SessionFacadeRow> => {
  const file = path.join(ROOT, "packages/protocol/src/session-facade/schema.ts")
  const lines = exportConstLines(sourceFileOf(file))
  const rows: Array<SessionFacadeRow> = []
  for (const [exportName, value] of Object.entries(SessionFacadeSchema)) {
    if (!isSchemaLike(value)) continue
    const meta = optionValue<ProjectionMeta>(getFiregridProjectionMetadata(value as never))
    if (!meta) continue
    const line = lines.get(exportName)
    rows.push({ exportName, ref: line ? `${rel(file)}:${line}` : rel(file), operationId: meta.operationId })
  }
  rows.sort((a, b) => a.operationId.localeCompare(b.operationId))
  return rows
}

// ─────────────────────────────────────────────────────────────────────────────
// SURFACE 3 — agent-output emitted events (Schema.TaggedStruct, egress)
// ─────────────────────────────────────────────────────────────────────────────
interface AgentOutputEventRow {
  readonly exportName: string
  readonly ref: string
  readonly tag: string
}

const inventoryAgentOutputEvents = (): Array<AgentOutputEventRow> => {
  const file = path.join(ROOT, "packages/protocol/src/agent-output/schema.ts")
  const sf = sourceFileOf(file)
  const rows: Array<AgentOutputEventRow> = []
  sf.forEachChild((node) => {
    if (!ts.isVariableStatement(node) || !isExported(node)) return
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      let tag: string | undefined
      walk(decl.initializer, (n) => {
        if (
          tag === undefined &&
          ts.isCallExpression(n) &&
          n.expression.getText(sf) === "Schema.TaggedStruct"
        ) {
          tag = stringLiteralValue(n.arguments[0])
        }
      })
      if (tag !== undefined) {
        rows.push({ exportName: decl.name.text, ref: `${rel(file)}:${lineOf(sf, decl.name)}`, tag })
      }
    }
  })
  rows.sort((a, b) => a.tag.localeCompare(b.tag))
  return rows
}

// ─────────────────────────────────────────────────────────────────────────────
// SURFACE 4 — channels: targets (protocol) + registrations (runtime)
// ─────────────────────────────────────────────────────────────────────────────
interface ChannelTargetRow {
  readonly name: string
  readonly ref: string
  readonly target: string
}

/** Reflect the protocol channels barrel: string-valued `*ChannelTarget` consts. */
const reflectChannelTargets = (): Map<string, string> => {
  const byName = new Map<string, string>()
  for (const [name, value] of Object.entries(ChannelsBarrel)) {
    if (/ChannelTarget$/.test(name) && typeof value === "string") byName.set(name, value)
  }
  return byName
}

const inventoryChannelTargets = (targetValues: Map<string, string>): Array<ChannelTargetRow> => {
  const dir = path.join(ROOT, "packages/protocol/src/channels")
  const rows: Array<ChannelTargetRow> = []
  for (const fileName of fs.readdirSync(dir)) {
    if (!fileName.endsWith(".ts")) continue
    const file = path.join(dir, fileName)
    const lines = exportConstLines(sourceFileOf(file))
    for (const [name, line] of lines) {
      const target = targetValues.get(name)
      if (target !== undefined) rows.push({ name, ref: `${rel(file)}:${line}`, target })
    }
  }
  rows.sort((a, b) => a.target.localeCompare(b.target))
  return rows
}

const CHANNEL_FACTORY = {
  makeCallableChannel: { direction: "call", verbs: ["call"] },
  makeIngressChannel: { direction: "ingress", verbs: ["wait_for"] },
  makeEgressChannel: { direction: "egress", verbs: ["send"] },
  makeBidirectionalChannel: { direction: "bidirectional", verbs: ["send", "wait_for"] },
  makeDurableEventChannel: { direction: "egress", verbs: ["send"] },
} as const

interface ChannelRegistrationRow {
  readonly factory: keyof typeof CHANNEL_FACTORY
  readonly direction: string
  readonly verbs: ReadonlyArray<string>
  readonly ref: string
  readonly targetExpr: string
  readonly target: string | null
  readonly requestSchema: string | null
  readonly responseSchema: string | null
  readonly schema: string | null
  readonly completion: string | null
}

const propText = (
  sf: ts.SourceFile,
  obj: ts.ObjectLiteralExpression,
  key: string,
): string | null => {
  for (const p of obj.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === key
    ) {
      return p.initializer.getText(sf)
    }
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === key) return p.name.text
  }
  return null
}

export const collectRuntimeFiles = (dir: string): Array<string> => {
  const out: Array<string> = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectRuntimeFiles(full))
    else if (entry.name.endsWith(".ts") && !/\.test\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

const inventoryChannelRegistrations = (
  targetValues: Map<string, string>,
): Array<ChannelRegistrationRow> => {
  const files = collectRuntimeFiles(path.join(ROOT, "packages/runtime/src"))
  const rows: Array<ChannelRegistrationRow> = []
  for (const file of files) {
    const sf = sourceFileOf(file)
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return
      const factory = n.expression.text as keyof typeof CHANNEL_FACTORY
      const spec = CHANNEL_FACTORY[factory]
      if (!spec) return
      const arg = n.arguments[0]
      if (!arg || !ts.isObjectLiteralExpression(arg)) return
      const targetExpr = propText(sf, arg, "target") ?? "(none)"
      const target = targetValues.get(targetExpr) ?? stringLiteralOfExpr(targetExpr) ?? null
      rows.push({
        factory,
        direction: spec.direction,
        verbs: spec.verbs,
        ref: `${rel(file)}:${lineOf(sf, n)}`,
        targetExpr,
        target,
        requestSchema: propText(sf, arg, "requestSchema"),
        responseSchema: propText(sf, arg, "responseSchema"),
        schema: propText(sf, arg, "schema"),
        completion: propText(sf, arg, "completion"),
      })
    })
  }
  rows.sort((a, b) => (a.target ?? a.targetExpr).localeCompare(b.target ?? b.targetExpr))
  return rows
}

/** A `target: "literal"` written inline rather than via a const. */
const stringLiteralOfExpr = (expr: string): string | undefined => {
  const m = expr.match(/^["'`]([^"'`]+)["'`]$/)
  return m ? m[1] : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-SURFACE MATRIX (heuristic join — every cell carries its basis)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Channel-target → canonical-operation aliases. Each entry is an INFERRED
 * cross-surface correspondence (a channel target that carries the same
 * operation an agent-tool / session-facade schema also declares). Kept
 * deliberately small and only where a real counterpart exists — a target with
 * NO agent-tool / facade counterpart is left UNMATCHED (an orphan / drift
 * candidate) rather than fabricating a row. Channel-target string values are
 * the reflected ground truth (e.g. `host.sessions.create_or_load`, underscore).
 */
const CHANNEL_ALIAS: Record<string, string> = {
  "host.prompt": "session.prompt",
  "session.prompt": "session.prompt",
  "session.cancel": "session.cancel",
  "session.close": "session.close",
  "host.permissions.respond": "permission.respond",
  "session.permissions.respond": "permission.respond",
  "session.agent_output": "session.wait.forAgentOutput",
  "host.sessions.create_or_load": "session.createOrLoad",
}

const canonical = (raw: string): string =>
  raw.replace(/\.scoped$/, "")

interface MatrixChannelCell {
  target: string
  verbs: ReadonlyArray<string>
  direction: string
  ref: string
}
interface MatrixRow {
  canonical: string
  agentTool: { toolName: string | null; clientName: string | null; cliName: string | null; inputRef: string; outputRef: string | null } | null
  sessionFacade: { operationId: string; ref: string } | null
  channels: Array<MatrixChannelCell>
  basis: string
}

const buildMatrix = (
  agentTools: Array<AgentToolRow>,
  sessionFacade: Array<SessionFacadeRow>,
  channelRegs: Array<ChannelRegistrationRow>,
): { rows: Array<MatrixRow>; unmatchedChannels: Array<ChannelRegistrationRow> } => {
  const byKey = new Map<string, MatrixRow>()
  const ensure = (key: string): MatrixRow => {
    let row = byKey.get(key)
    if (!row) {
      row = { canonical: key, agentTool: null, sessionFacade: null, channels: [], basis: "" }
      byKey.set(key, row)
    }
    return row
  }

  // agent-tools: pair input+output by operationId
  const inputs = agentTools.filter((r) => r.schemaKind === "input")
  const outputs = new Map(agentTools.filter((r) => r.schemaKind === "output").map((r) => [r.operationId, r.ref]))
  for (const r of inputs) {
    const row = ensure(canonical(r.operationId))
    row.agentTool = {
      toolName: r.toolName,
      clientName: r.clientName,
      cliName: r.cliName,
      inputRef: r.ref,
      outputRef: outputs.get(r.operationId) ?? null,
    }
  }

  // session-facade
  for (const r of sessionFacade) {
    const row = ensure(canonical(r.operationId))
    row.sessionFacade = { operationId: r.operationId, ref: r.ref }
  }

  // channels (callable/ingress with a known target only — the request/response ops)
  const unmatchedChannels: Array<ChannelRegistrationRow> = []
  for (const c of channelRegs) {
    if (!c.target) {
      unmatchedChannels.push(c)
      continue
    }
    const key = CHANNEL_ALIAS[c.target]
    if (!key || !byKey.has(key)) {
      unmatchedChannels.push(c)
      continue
    }
    // Aggregate EVERY matching registration so multiplicity stays visible.
    byKey.get(key)!.channels.push({ target: c.target, verbs: c.verbs, direction: c.direction, ref: c.ref })
  }

  for (const row of byKey.values()) {
    const present = [row.agentTool && "agent-tool", row.sessionFacade && "session-facade", row.channels.length > 0 && "channel"].filter(Boolean)
    row.basis = present.length > 1 ? `multi-surface (${present.join(" + ")})` : `single-surface (${present.join("")})`
  }

  const rows = [...byKey.values()].sort((a, b) => a.canonical.localeCompare(b.canonical))
  return { rows, unmatchedChannels }
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────────────────────
const cell = (v: string | null | undefined): string => (v == null || v === "" ? "—" : `\`${v}\``)
const refCell = (v: string | null | undefined): string => (v == null ? "—" : v)

const renderMarkdown = (data: ReturnType<typeof build>): string => {
  const { matrix, agentTools, sessionFacade, agentOutputEvents, channelTargets, channelRegistrations, unmatchedChannels, orphanTargets, reflectionMisses } = data
  const L: Array<string> = []
  L.push("# tf-7whh — Firegrid operation × surface inventory")
  L.push("")
  L.push("> **Machine-generated by `scripts/operation-inventory.ts` (`pnpm inventory:operations`). Do not edit by hand.**")
  L.push("> Evidence only — ground-truth `file:line` references, no redesign. Cross-surface joins are heuristic (see `basis` column / the findings note).")
  L.push("")
  L.push("## 1. Operation × surface matrix")
  L.push("")
  L.push("Rows = canonical operation (operationId, `.scoped` suffix folded). Columns = the surface that declares it.")
  L.push("")
  L.push("| Canonical op | Agent tool | Client | CLI | Session-facade | Channel (target · verb · kind) | Surfaces |")
  L.push("| --- | --- | --- | --- | --- | --- | --- |")
  for (const r of matrix) {
    const at = r.agentTool
    const channelCell = r.channels.length === 0
      ? "—"
      : [...new Set(r.channels.map((c) => `\`${c.target}\` · ${c.verbs.join("/")} · ${c.direction}`))].join("<br>")
    const surfaces = r.basis.startsWith("multi") ? "**" + r.basis + "**" : r.basis
    L.push(
      `| \`${r.canonical}\` | ${cell(at?.toolName)} | ${cell(at?.clientName)} | ${cell(at?.cliName)} | ${cell(r.sessionFacade?.operationId)} | ${channelCell} | ${surfaces} |`,
    )
  }
  L.push("")

  L.push("## 2. Agent-tool schemas (`firegridProjection` via `toolAnnotations`)")
  L.push("")
  L.push("| operationId | toolName | clientName | cliName | kind | ref |")
  L.push("| --- | --- | --- | --- | --- | --- |")
  for (const r of agentTools) {
    L.push(`| \`${r.operationId}\` | ${cell(r.toolName)} | ${cell(r.clientName)} | ${cell(r.cliName)} | ${r.schemaKind} | ${r.ref} |`)
  }
  L.push("")

  L.push("## 3. Session-facade schemas (`firegridProjection` operationId)")
  L.push("")
  L.push("| operationId | export | ref |")
  L.push("| --- | --- | --- |")
  for (const r of sessionFacade) L.push(`| \`${r.operationId}\` | \`${r.exportName}\` | ${r.ref} |`)
  L.push("")

  L.push("## 4. Agent-output emitted events (`Schema.TaggedStruct`, egress)")
  L.push("")
  L.push("| _tag | export | ref |")
  L.push("| --- | --- | --- |")
  for (const r of agentOutputEvents) L.push(`| \`${r.tag}\` | \`${r.exportName}\` | ${r.ref} |`)
  L.push("")

  L.push("## 5. Channel targets (`makeChannelTarget`, protocol)")
  L.push("")
  L.push("| target | const | ref |")
  L.push("| --- | --- | --- |")
  for (const r of channelTargets) L.push(`| \`${r.target}\` | \`${r.name}\` | ${r.ref} |`)
  L.push("")

  L.push("## 6. Channel registrations (`make*Channel`, runtime)")
  L.push("")
  L.push("| target | factory | direction | verbs | request | response | schema | completion | ref |")
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
  for (const r of channelRegistrations) {
    L.push(
      `| ${cell(r.target ?? r.targetExpr)} | ${r.factory} | ${r.direction} | ${r.verbs.join("/")} | ${cell(r.requestSchema)} | ${cell(r.responseSchema)} | ${cell(r.schema)} | ${cell(r.completion)} | ${r.ref} |`,
    )
  }
  L.push("")

  L.push("## 7. Channel registrations NOT folded into an operation row")
  L.push("")
  L.push("These channel registrations have a dynamic target, or a target not aliased to any agent-tool/session-facade operationId (drift candidates — see findings note).")
  L.push("")
  L.push("| target / expr | factory | direction | ref |")
  L.push("| --- | --- | --- | --- |")
  for (const r of unmatchedChannels) L.push(`| ${cell(r.target ?? r.targetExpr)} | ${r.factory} | ${r.direction} | ${r.ref} |`)
  L.push("")

  L.push("## 8. Orphan channel targets (declared, never registered)")
  L.push("")
  L.push("`*ChannelTarget` consts that NO `make*Channel` registration references — a declared route with no binding (drift).")
  L.push("")
  if (orphanTargets.length === 0) {
    L.push("_None._")
  } else {
    L.push("| target | const | ref |")
    L.push("| --- | --- | --- |")
    for (const r of orphanTargets) L.push(`| \`${r.target}\` | \`${r.name}\` | ${r.ref} |`)
  }
  L.push("")

  if (reflectionMisses.length > 0) {
    L.push("## 9. Diagnostics")
    L.push("")
    L.push("Input schemas expected to carry `firegridProjection` but where reflection found none:")
    L.push("")
    for (const m of reflectionMisses) L.push(`- \`${m}\``)
    L.push("")
  }
  return L.join("\n")
}

// ─────────────────────────────────────────────────────────────────────────────
export const build = () => {
  const { rows: agentTools, reflectionMisses } = inventoryAgentTools()
  const sessionFacade = inventorySessionFacade()
  const agentOutputEvents = inventoryAgentOutputEvents()
  const targetValues = reflectChannelTargets()
  const channelTargets = inventoryChannelTargets(targetValues)
  const channelRegistrations = inventoryChannelRegistrations(targetValues)

  // Orphan targets: a `*ChannelTarget` const that NO `make*Channel` registration
  // references — neither by its resolved string value nor by its const name in
  // the (possibly `??`-defaulted) target expression. A declared route with no
  // binding is drift the inventory should surface.
  const orphanTargets = channelTargets.filter((t) =>
    !channelRegistrations.some((r) =>
      r.target === t.target || r.targetExpr === t.target || r.targetExpr.includes(t.name)
    )
  )

  const { rows: matrix, unmatchedChannels } = buildMatrix(agentTools, sessionFacade, channelRegistrations)

  const distinctCanonical = new Set(matrix.map((r) => r.canonical))
  const multiSurface = matrix.filter((r) => r.basis.startsWith("multi"))
  const stats = {
    distinctCanonicalOperations: distinctCanonical.size,
    multiSurfaceOperations: multiSurface.length,
    agentToolOperations: new Set(agentTools.filter((r) => r.schemaKind === "input").map((r) => r.operationId)).size,
    sessionFacadeOperations: sessionFacade.length,
    agentOutputEvents: agentOutputEvents.length,
    channelTargets: channelTargets.length,
    channelRegistrations: channelRegistrations.length,
    unmatchedChannelRegistrations: unmatchedChannels.length,
    orphanChannelTargets: orphanTargets.length,
  }

  return {
    matrix,
    agentTools,
    sessionFacade,
    agentOutputEvents,
    channelTargets,
    channelRegistrations,
    unmatchedChannels,
    orphanTargets,
    reflectionMisses,
    stats,
  }
}

const main = () => {
  const data = build()
  const outDir = path.join(ROOT, "docs/findings")
  fs.mkdirSync(outDir, { recursive: true })
  const json = {
    tool: "scripts/operation-inventory.ts",
    bead: "tf-7whh",
    note: "Machine-generated. Evidence only. Cross-surface joins are heuristic (see matrix[].basis).",
    stats: data.stats,
    matrix: data.matrix,
    surfaces: {
      agentTools: data.agentTools,
      sessionFacade: data.sessionFacade,
      agentOutputEvents: data.agentOutputEvents,
      channelTargets: data.channelTargets,
      channelRegistrations: data.channelRegistrations,
    },
    unmatchedChannelRegistrations: data.unmatchedChannels,
    orphanChannelTargets: data.orphanTargets,
    reflectionMisses: data.reflectionMisses,
  }
  fs.writeFileSync(path.join(outDir, "tf-7whh-operation-inventory.json"), JSON.stringify(json, null, 2) + "\n")
  fs.writeFileSync(path.join(outDir, "tf-7whh-operation-inventory.md"), renderMarkdown(data) + "\n")
  // eslint-disable-next-line no-console
  console.log("operation inventory written:", JSON.stringify(data.stats, null, 2))
}

const isEntry = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntry) main()
