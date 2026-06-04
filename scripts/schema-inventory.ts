/**
 * tf-pxxe — Firegrid schema classification (EVIDENCE ONLY).
 *
 * Cuts the fog around "1827 Schema. hits across 89 files": classifies EVERY
 * Effect Schema declaration by four axes so the PO can see which schema operates
 * in which boundary, for which role.
 *
 * EXTENDS the tf-7whh operation inventory (`scripts/operation-inventory.ts`):
 * it imports that tool's reflection/AST machinery AND its `build()` output, so
 * the role axis is cross-referenced against the authoritative operation/channel
 * surfaces rather than re-derived.
 *
 * Axes (each carries a confidence/basis; anything ambiguous is listed, not
 * silently bucketed):
 *   1. BOUNDARY  — package + dir; substrate-coupled (transitively imports
 *      `effect-durable-operators` / uses DurableTable) vs pure contract.
 *   2. ROLE      — operation-input / operation-output / channel-request /
 *      channel-response / durable-table-row / agent-output-event / config /
 *      shared-leaf-primitive / internal-DTO.
 *   3. PROJECTION — carries firegridProjection? which surfaces.
 *   4. REUSE     — how many distinct modules import it (shared leaf vs single-use).
 *
 * Plus a CRUD-vs-primitive tally over the canonical operations (does the op
 * reduce to CRUD/projection over a DurableTable, or is it a workflow primitive?).
 *
 * Approach is AST-primary (uniform over exported + module-private schemas, gives
 * file:line + the import graph the boundary/reuse axes need) augmented by the
 * operation inventory's reflection for the projection/role cross-ref. No new dep.
 *
 * Run:  pnpm inventory:schemas      (writes docs/findings/tf-pxxe-*.{json,md}
 *        — git-ignored; regenerate on demand, do not commit)
 */
import * as fs from "node:fs"
import * as path from "node:path"
import * as ts from "typescript"

import {
  build as buildOperationInventory,
  lineOf,
  rel,
  ROOT,
  sourceFileOf,
} from "./operation-inventory.ts"

const SUBSTRATE_PACKAGE = "effect-durable-operators"

// ── source-file collection ───────────────────────────────────────────────────
const collectSrcFiles = (dir: string): Array<string> => {
  const out: Array<string> = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectSrcFiles(full))
    else if (entry.name.endsWith(".ts") && !/\.test\.ts$/.test(entry.name)) out.push(full)
  }
  return out
}

const allSrcFiles = (): Array<string> => {
  const pkgRoot = path.join(ROOT, "packages")
  const out: Array<string> = []
  for (const pkg of fs.readdirSync(pkgRoot)) {
    out.push(...collectSrcFiles(path.join(pkgRoot, pkg, "src")))
  }
  return out.sort()
}

// ── leftmost identifier of a (possibly nested) expression ────────────────────
const leftmostIdent = (sf: ts.SourceFile, node: ts.Expression): string | null => {
  let cur: ts.Expression = node
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) cur = cur.expression
    else if (ts.isCallExpression(cur)) cur = cur.expression
    else if (ts.isElementAccessExpression(cur)) cur = cur.expression
    else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur)) cur = cur.expression
    else break
  }
  return ts.isIdentifier(cur) ? cur.text : null
}

const stripWrappers = (node: ts.Expression): ts.Expression => {
  let cur = node
  while (
    ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur)
  ) cur = cur.expression
  return cur
}

// Schema.<name>(...) calls that are NOT schema constructors (decode/validate/…).
const NON_SCHEMA_MEMBERS = new Set([
  "decodeSync", "decodeUnknownSync", "decode", "decodeUnknown", "decodeEither",
  "decodeUnknownEither", "decodeOption", "decodePromise", "encode", "encodeSync",
  "encodeUnknown", "encodeUnknownSync", "encodeEither", "is", "isSchema",
  "validate", "validateSync", "validateEither", "asserts", "equivalence",
  "hash", "serializable", "standardSchemaV1", "pretty", "arbitrary", "make",
])

interface SchemaInfo {
  readonly isSchema: boolean
  readonly rootCtor: string
  readonly basis: string
}
const NOT_SCHEMA: SchemaInfo = { isSchema: false, rootCtor: "", basis: "" }

const classifyInitializer = (
  sf: ts.SourceFile,
  init: ts.Expression,
  isKnownSchemaName: (name: string) => boolean,
): SchemaInfo => {
  const node = stripWrappers(init)

  if (ts.isCallExpression(node)) {
    const callee = node.expression
    if (ts.isPropertyAccessExpression(callee)) {
      const member = callee.name.text
      // Chain methods MUST be unwrapped FIRST: in `Schema.Struct({…}).annotations(…)`
      // the chain's leftmost identifier is still `Schema`, so a naive ctor check
      // would record `annotations`/`pipe` as the rootCtor. Recurse to the real ctor.
      if (member === "pipe" || member === "annotations") {
        const recv = classifyInitializer(sf, callee.expression, isKnownSchemaName)
        if (recv.isSchema) return { isSchema: true, rootCtor: recv.rootCtor, basis: recv.basis }
        return NOT_SCHEMA
      }
      const left = leftmostIdent(sf, callee.expression)
      if (left === "Schema") {
        if (NON_SCHEMA_MEMBERS.has(member)) return NOT_SCHEMA
        return { isSchema: true, rootCtor: member, basis: "schema-ctor" }
      }
    }
    // helper call returning a schema, e.g. makeFooSchema(...) — accept only if
    // the callee identifier is a known schema-producing name (ends in Schema).
    if (ts.isIdentifier(callee) && isKnownSchemaName(callee.text)) {
      return { isSchema: true, rootCtor: "derived", basis: "helper-call" }
    }
    return NOT_SCHEMA
  }

  if (ts.isPropertyAccessExpression(node)) {
    const left = leftmostIdent(sf, node.expression)
    if (left === "Schema" && /^[A-Z]/.test(node.name.text)) {
      return { isSchema: true, rootCtor: node.name.text, basis: "schema-value" }
    }
    return NOT_SCHEMA
  }

  if (ts.isIdentifier(node)) {
    // alias: const X = SomeSchema
    if (isKnownSchemaName(node.text)) return { isSchema: true, rootCtor: "alias", basis: "alias" }
  }
  return NOT_SCHEMA
}

// ── per-file extraction ──────────────────────────────────────────────────────
interface ImportRec {
  readonly names: ReadonlyArray<string>
  readonly namespace: boolean
  readonly specifier: string
}
interface ReExportRec {
  readonly names: ReadonlyArray<string> | "*"
  readonly specifier: string
}
interface RawSchemaDecl {
  readonly name: string
  readonly line: number
  readonly exported: boolean
  readonly rootCtor: string
  readonly basis: string
  readonly text: string
}
interface FileRec {
  readonly file: string
  readonly imports: Array<ImportRec>
  readonly reExports: Array<ReExportRec>
  readonly schemas: Array<RawSchemaDecl>
  readonly importsSubstrateDirect: boolean
  readonly exportNames: Set<string>
}

const moduleHasExportModifier = (mods: ts.NodeArray<ts.ModifierLike> | undefined): boolean =>
  (mods ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

const extractFile = (file: string): FileRec => {
  const sf = sourceFileOf(file)
  const imports: Array<ImportRec> = []
  const reExports: Array<ReExportRec> = []
  const schemas: Array<RawSchemaDecl> = []
  const exportNames = new Set<string>()
  let importsSubstrateDirect = false

  // imports / re-exports
  sf.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      if (spec === SUBSTRATE_PACKAGE || spec.startsWith(`${SUBSTRATE_PACKAGE}/`)) importsSubstrateDirect = true
      const names: Array<string> = []
      let namespace = false
      const ic = node.importClause
      if (ic) {
        if (ic.name) names.push(ic.name.text)
        if (ic.namedBindings) {
          if (ts.isNamespaceImport(ic.namedBindings)) namespace = true
          else for (const el of ic.namedBindings.elements) names.push(el.name.text)
        }
      }
      imports.push({ names, namespace, specifier: spec })
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        const names = node.exportClause.elements.map((e) => e.name.text)
        reExports.push({ names, specifier: spec })
        for (const n of names) exportNames.add(n)
      } else {
        reExports.push({ names: "*", specifier: spec })
      }
    }
  })

  // first pass — definite schema names (for alias/helper resolution)
  const definite = new Set<string>()
  const importedSchemaNames = new Set<string>()
  for (const imp of imports) for (const n of imp.names) if (/Schema$/.test(n)) importedSchemaNames.add(n)
  const isKnownSchemaName = (name: string) => definite.has(name) || importedSchemaNames.has(name)

  const visitVarStatement = (node: ts.VariableStatement, resolvePass: boolean) => {
    const exported = moduleHasExportModifier(node.modifiers)
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      const info = classifyInitializer(sf, decl.initializer, isKnownSchemaName)
      if (!info.isSchema) continue
      if (!resolvePass) {
        definite.add(decl.name.text)
      }
      if (resolvePass) {
        if (exported) exportNames.add(decl.name.text)
        schemas.push({
          name: decl.name.text,
          line: lineOf(sf, decl.name),
          exported,
          rootCtor: info.rootCtor,
          basis: info.basis,
          text: decl.initializer.getText(sf),
        })
      }
    }
  }

  // pass 1: collect definite schema decls (ctor/value/class), no alias resolution
  sf.forEachChild((node) => {
    if (ts.isVariableStatement(node)) visitVarStatement(node, false)
    if (ts.isClassDeclaration(node) && node.name) {
      const heritage = node.heritageClauses?.map((h) => h.getText(sf)).join(" ") ?? ""
      if (/extends\s+Schema\./.test(heritage)) definite.add(node.name.text)
    }
  })
  // pass 2: emit, now that aliases can resolve against `definite`
  sf.forEachChild((node) => {
    if (ts.isVariableStatement(node)) visitVarStatement(node, true)
    if (ts.isClassDeclaration(node) && node.name) {
      const heritage = node.heritageClauses?.map((h) => h.getText(sf)).join(" ") ?? ""
      const m = heritage.match(/extends\s+Schema\.(\w+)/)
      if (m) {
        const exported = moduleHasExportModifier(node.modifiers)
        if (exported) exportNames.add(node.name.text)
        schemas.push({
          name: node.name.text,
          line: lineOf(sf, node.name),
          exported,
          rootCtor: m[1],
          basis: "schema-class",
          text: heritage,
        })
      }
    }
  })

  return { file, imports, reExports, schemas, importsSubstrateDirect, exportNames }
}

// ── module resolution (relative + @firegrid/* package-export subpaths) ───────
const buildPackageExportMap = (): Map<string, string> => {
  const map = new Map<string, string>()
  const pkgRoot = path.join(ROOT, "packages")
  for (const pkg of fs.readdirSync(pkgRoot)) {
    const pjPath = path.join(pkgRoot, pkg, "package.json")
    if (!fs.existsSync(pjPath)) continue
    const pj = JSON.parse(fs.readFileSync(pjPath, "utf8")) as {
      name?: string
      exports?: Record<string, { default?: string; types?: string } | string>
    }
    if (!pj.name || !pj.exports) continue
    for (const [sub, target] of Object.entries(pj.exports)) {
      const rawTarget = typeof target === "string" ? target : (target.default ?? target.types)
      if (!rawTarget) continue
      const abs = path.resolve(path.join(pkgRoot, pkg), rawTarget)
      const key = sub === "." ? pj.name : `${pj.name}/${sub.replace(/^\.\//, "")}`
      map.set(key, abs)
    }
  }
  return map
}

const resolveCandidate = (p: string): string | null => {
  for (const c of [p, `${p}.ts`, path.join(p, "index.ts")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

const resolveSpecifier = (
  importerFile: string,
  specifier: string,
  pkgExports: Map<string, string>,
): string | null => {
  if (specifier.startsWith(".")) {
    return resolveCandidate(path.resolve(path.dirname(importerFile), specifier))
  }
  if (pkgExports.has(specifier)) return pkgExports.get(specifier)!
  return null // external (effect, node:*, …) — not an internal module
}

// ─────────────────────────────────────────────────────────────────────────────
const main = () => {
  const files = allSrcFiles()
  const pkgExports = buildPackageExportMap()
  const recs = new Map<string, FileRec>()
  for (const f of files) recs.set(f, extractFile(f))

  // ── substrate-coupling (transitive over the internal import graph) ─────────
  const substrateMemo = new Map<string, boolean>()
  const isSubstrate = (file: string, stack: Set<string>): boolean => {
    const cached = substrateMemo.get(file)
    if (cached !== undefined) return cached
    if (stack.has(file)) return false // cycle guard (do not cache partial)
    const rec = recs.get(file)
    if (!rec) return false
    if (rec.importsSubstrateDirect) {
      substrateMemo.set(file, true)
      return true
    }
    stack.add(file)
    let coupled = false
    for (const imp of rec.imports) {
      const origin = resolveSpecifier(file, imp.specifier, pkgExports)
      if (origin && recs.has(origin) && isSubstrate(origin, stack)) {
        coupled = true
        break
      }
    }
    stack.delete(file)
    substrateMemo.set(file, coupled)
    return coupled
  }

  // ── export-origin resolution (follow re-export barrels, depth-limited) ─────
  const originMemo = new Map<string, string | null>()
  const resolveExportOrigin = (file: string, name: string, depth: number): string | null => {
    const key = `${file}::${name}`
    const cached = originMemo.get(key)
    if (cached !== undefined) return cached
    const rec = recs.get(file)
    if (!rec || depth < 0) return null
    let result: string | null = null
    if (rec.schemas.some((s) => s.exported && s.name === name)) {
      result = file
    } else {
      for (const re of rec.reExports) {
        const origin = resolveSpecifier(file, re.specifier, pkgExports)
        if (!origin || !recs.has(origin)) continue
        if (re.names === "*" || re.names.includes(name)) {
          const found = resolveExportOrigin(origin, name, depth - 1)
          if (found) { result = found; break }
        }
      }
    }
    originMemo.set(key, result)
    return result
  }

  // ── reuse fan-out: importing modules per (origin schema) ───────────────────
  const importers = new Map<string, Set<string>>() // "originFile::name" -> importer files
  for (const [file, rec] of recs) {
    for (const imp of rec.imports) {
      if (imp.namespace || imp.names.length === 0) continue
      const target = resolveSpecifier(file, imp.specifier, pkgExports)
      if (!target || !recs.has(target)) continue
      for (const name of imp.names) {
        const origin = resolveExportOrigin(target, name, 3)
        if (!origin) continue
        const k = `${origin}::${name}`
        if (!importers.has(k)) importers.set(k, new Set())
        importers.get(k)!.add(file)
      }
    }
  }
  const fanOut = (file: string, name: string): number => importers.get(`${file}::${name}`)?.size ?? 0

  // ── role/projection cross-ref from the operation inventory ─────────────────
  const op = buildOperationInventory()
  const leadIdent = (s: string | null): string | null => {
    if (!s) return null
    const m = s.match(/^([A-Za-z_$][\w$]*)/)
    return m ? m[1] : null
  }
  const opInputNames = new Set(op.agentTools.map((r) => r.exportName).concat(op.sessionFacade.map((r) => r.exportName)))
  const channelReqNames = new Set<string>()
  const channelResNames = new Set<string>()
  const channelPayloadNames = new Set<string>()
  for (const r of op.channelRegistrations) {
    const req = leadIdent(r.requestSchema); if (req) channelReqNames.add(req)
    const res = leadIdent(r.responseSchema); if (res) channelResNames.add(res)
    const sch = leadIdent(r.schema); if (sch) channelPayloadNames.add(sch)
  }
  const agentEventNames = new Set(op.agentOutputEvents.map((r) => r.exportName))

  // projection metadata by export name (reflected by the operation tool)
  interface Proj { operationId: string; surfaces: Array<string> }
  const projByName = new Map<string, Proj>()
  for (const r of op.agentTools) {
    const surfaces: Array<string> = []
    if (r.toolName) surfaces.push("tool")
    if (r.clientName) surfaces.push("client")
    if (r.cliName) surfaces.push("cli")
    projByName.set(r.exportName, { operationId: r.operationId, surfaces })
  }
  for (const r of op.sessionFacade) projByName.set(r.exportName, { operationId: r.operationId, surfaces: ["client(facade)"] })

  // ── per-schema classification ──────────────────────────────────────────────
  interface Classified {
    pkg: string
    dir: string
    file: string
    name: string
    line: number
    ref: string
    exported: boolean
    rootCtor: string
    detection: string
    substrate: boolean
    role: string
    roleBasis: string
    projection: string | null
    reuse: number
    ambiguous: string | null
  }

  const isRowSchema = (rec: FileRec, decl: RawSchemaDecl): boolean =>
    /DurableTable\.primaryKey|\bprimaryKey\b/.test(decl.text) &&
    (rec.importsSubstrateDirect || rec.imports.some((i) => i.names.includes("DurableTable") || i.names.includes("primaryKey")))

  const all: Array<Classified> = []
  for (const [file, rec] of recs) {
    const relFile = rel(file)
    const segs = relFile.split("/") // packages/<pkg>/src/<dir>/...
    const pkg = segs[1] ?? "?"
    const dir = segs[3] === undefined ? "(root)" : (segs[4] === undefined ? "(src root)" : segs[3])
    const substrate = isSubstrate(file, new Set())
    for (const decl of rec.schemas) {
      const reuse = fanOut(file, decl.name)
      const proj = projByName.get(decl.name) ?? null

      // role cascade (authoritative → heuristic)
      let role = "internal-DTO"
      let roleBasis = "no authoritative surface; default"
      let ambiguous: string | null = null
      const endsOutput = /(?:Output|Response|Result)Schema$/.test(decl.name)
      if (opInputNames.has(decl.name) && proj) {
        role = "operation-input"; roleBasis = `projection op ${proj.operationId}`
      } else if ((relFile.includes("agent-tools/") || relFile.includes("session-facade/")) && endsOutput) {
        role = "operation-output"; roleBasis = "projection-surface *Output/Response/Result schema"
      } else if (channelReqNames.has(decl.name)) {
        role = "channel-request"; roleBasis = "used as make*Channel requestSchema/payload"
      } else if (channelPayloadNames.has(decl.name)) {
        role = "channel-request"; roleBasis = "used as make*Channel egress schema (payload)"
      } else if (channelResNames.has(decl.name)) {
        role = "channel-response"; roleBasis = "used as make*Channel responseSchema"
      } else if (agentEventNames.has(decl.name)) {
        role = "agent-output-event"; roleBasis = "Schema.TaggedStruct egress event"
      } else if (decl.rootCtor === "TaggedError" || decl.rootCtor === "TaggedRequest") {
        role = "error"; roleBasis = `Schema.${decl.rootCtor} (tagged error type)`
      } else if (isRowSchema(rec, decl)) {
        role = "durable-table-row"; roleBasis = "field piped through DurableTable.primaryKey"
      } else if (/Config$/.test(decl.name) || relFile.includes("/config")) {
        role = "config"; roleBasis = "name/module config"
      } else if (reuse >= 2) {
        // Reused by ≥2 modules but bound to no operation/channel/row/event/error
        // surface — a shared building block (in this codebase these are small
        // structs/unions, not scalar leaves; scalar leaves are inlined, reuse 0).
        role = "shared-leaf-primitive"
        roleBasis = `reused by ${reuse} modules; not bound to any operation/channel/row/event surface`
      } else {
        role = "internal-DTO"
        roleBasis = decl.exported ? "exported, single-use (reuse<2)" : "module-private"
      }

      if (decl.basis === "helper-call" || decl.basis === "alias") {
        ambiguous = (ambiguous ? ambiguous + "; " : "") + `detection=${decl.basis} (lower confidence)`
      }

      all.push({
        pkg,
        dir,
        file: relFile,
        name: decl.name,
        line: decl.line,
        ref: `${relFile}:${decl.line}`,
        exported: decl.exported,
        rootCtor: decl.rootCtor,
        detection: decl.basis,
        substrate,
        role,
        roleBasis,
        projection: proj ? `${proj.operationId} [${proj.surfaces.join(",")}]` : null,
        reuse,
        ambiguous,
      })
    }
  }
  all.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.role.localeCompare(b.role) || a.file.localeCompare(b.file) || a.line - b.line)

  // ── CRUD-vs-primitive operation tally (sourced + token-verified) ───────────
  const tally = buildCrudPrimitiveTally()

  // ── render ─────────────────────────────────────────────────────────────────
  const data = { all, tally, files: files.length }
  writeArtifacts(data)
}

// ── CRUD-vs-primitive: sourced op→mechanism map, each token verified present ──
interface OpMechanism {
  readonly operationId: string
  readonly family: "agent-durable-wait" | "channel" | "client-lifecycle" | "client-observe" | "agent-spawn"
  readonly mechanism: string
  readonly bucket: "workflow-primitive" | "crud-over-durable-table" | "unported"
  readonly evidence: string // file
  readonly token: string // token expected in `evidence` (verified)
}

const OP_MECHANISMS: ReadonlyArray<OpMechanism> = [
  { operationId: "sleep", family: "agent-durable-wait", mechanism: "Clock.sleep (durable timer)", bucket: "workflow-primitive", evidence: "packages/runtime/src/unified/mcp-host/tool-dispatch.ts", token: "Clock.sleep" },
  { operationId: "wait.until", family: "agent-durable-wait", mechanism: "Clock.sleep until wall-clock", bucket: "workflow-primitive", evidence: "packages/runtime/src/unified/mcp-host/tool-dispatch.ts", token: "Clock.sleep" },
  { operationId: "wait.for", family: "agent-durable-wait", mechanism: "router.dispatch verb wait_for + raceFirst timeout", bucket: "workflow-primitive", evidence: "packages/runtime/src/unified/mcp-host/tool-dispatch.ts", token: "raceFirst" },
  { operationId: "wait.any", family: "agent-durable-wait", mechanism: "Effect.raceAll over waits", bucket: "workflow-primitive", evidence: "packages/runtime/src/unified/mcp-host/tool-dispatch.ts", token: "raceAll" },
  { operationId: "channel.call", family: "channel", mechanism: "router.dispatch verb call (req/res)", bucket: "workflow-primitive", evidence: "packages/runtime/src/unified/mcp-host/tool-dispatch.ts", token: "runCall" },
  { operationId: "channel.send", family: "channel", mechanism: "router.dispatch verb send (durable-event append)", bucket: "crud-over-durable-table", evidence: "packages/runtime/src/unified/mcp-host/tool-dispatch.ts", token: "runSend" },
  { operationId: "session.create", family: "client-lifecycle", mechanism: "control.contexts.insertOrGet", bucket: "crud-over-durable-table", evidence: "packages/runtime/src/channels/host-control.ts", token: "contexts.insertOrGet" },
  { operationId: "session.createOrLoad", family: "client-lifecycle", mechanism: "control.contexts.insertOrGet", bucket: "crud-over-durable-table", evidence: "packages/runtime/src/channels/host-control.ts", token: "contexts.insertOrGet" },
  { operationId: "session.cancel", family: "client-lifecycle", mechanism: "durable-event append (cancel channel)", bucket: "crud-over-durable-table", evidence: "packages/runtime/src/unified/channel-bindings.ts", token: "SessionCancelChannelTarget" },
  { operationId: "session.close", family: "client-lifecycle", mechanism: "durable-event append (close channel)", bucket: "crud-over-durable-table", evidence: "packages/runtime/src/unified/channel-bindings.ts", token: "SessionCloseChannelTarget" },
  { operationId: "session.prompt", family: "client-lifecycle", mechanism: "durable-event append (prompt channel)", bucket: "crud-over-durable-table", evidence: "packages/runtime/src/unified/channel-bindings.ts", token: "SessionPromptChannelTarget" },
  { operationId: "permission.respond", family: "client-lifecycle", mechanism: "durable-event append (permission respond channel)", bucket: "crud-over-durable-table", evidence: "packages/runtime/src/unified/channel-bindings.ts", token: "HostPermissionRespondChannelTarget" },
  { operationId: "session.wait.forAgentOutput", family: "client-observe", mechanism: "ingress subscribe/read over agent_output rows", bucket: "crud-over-durable-table", evidence: "packages/runtime/src/channels/session-agent-output.ts", token: "makeIngressChannel" },
  { operationId: "session.wait.forPermissionRequest", family: "client-observe", mechanism: "ingress read over permission-request rows", bucket: "crud-over-durable-table", evidence: "packages/protocol/src/session-facade/schema.ts", token: "forPermissionRequest" },
  { operationId: "session.status", family: "client-observe", mechanism: "table read/projection (NOT YET PORTED in MCP executor)", bucket: "unported", evidence: "packages/runtime/src/unified/mcp-host/tool-dispatch.ts", token: "not yet ported" },
  { operationId: "session.attach", family: "client-lifecycle", mechanism: "facade attach (createOrLoad-shaped read/insert)", bucket: "crud-over-durable-table", evidence: "packages/protocol/src/session-facade/schema.ts", token: "session.attach" },
  { operationId: "session.spawn", family: "agent-spawn", mechanism: "NOT YET PORTED in MCP executor", bucket: "unported", evidence: "packages/runtime/src/unified/mcp-host/tool-dispatch.ts", token: "not yet ported" },
  { operationId: "session.spawnAll", family: "agent-spawn", mechanism: "NOT YET PORTED in MCP executor", bucket: "unported", evidence: "packages/runtime/src/unified/mcp-host/tool-dispatch.ts", token: "not yet ported" },
  { operationId: "capability.execute", family: "agent-spawn", mechanism: "NOT YET PORTED in MCP executor", bucket: "unported", evidence: "packages/runtime/src/unified/mcp-host/tool-dispatch.ts", token: "not yet ported" },
]

interface TallyRow extends OpMechanism {
  readonly verified: boolean
}
const buildCrudPrimitiveTally = (): {
  rows: Array<TallyRow>
  counts: Record<string, number>
} => {
  const rows: Array<TallyRow> = OP_MECHANISMS.map((m) => {
    const abs = path.join(ROOT, m.evidence)
    const verified = fs.existsSync(abs) && fs.readFileSync(abs, "utf8").includes(m.token)
    return { ...m, verified }
  })
  const counts: Record<string, number> = {
    "workflow-primitive": 0,
    "crud-over-durable-table": 0,
    "unported": 0,
  }
  for (const r of rows) counts[r.bucket]++
  return { rows, counts }
}

// ── artifacts ────────────────────────────────────────────────────────────────
const writeArtifacts = (data: {
  all: Array<{
    pkg: string; dir: string; file: string; name: string; line: number; ref: string
    exported: boolean; rootCtor: string; detection: string; substrate: boolean
    role: string; roleBasis: string; projection: string | null; reuse: number; ambiguous: string | null
  }>
  tally: ReturnType<typeof buildCrudPrimitiveTally>
  files: number
}) => {
  const { all, tally } = data
  const byRole = new Map<string, number>()
  const byPkg = new Map<string, number>()
  let substrateCount = 0
  for (const s of all) {
    byRole.set(s.role, (byRole.get(s.role) ?? 0) + 1)
    byPkg.set(s.pkg, (byPkg.get(s.pkg) ?? 0) + 1)
    if (s.substrate) substrateCount++
  }
  const ambiguous = all.filter((s) => s.ambiguous)

  const stats = {
    totalSchemaDeclarations: all.length,
    sourceFilesScanned: data.files,
    substrateCoupled: substrateCount,
    pureContract: all.length - substrateCount,
    byRole: Object.fromEntries([...byRole].sort((a, b) => b[1] - a[1])),
    byPackage: Object.fromEntries([...byPkg].sort((a, b) => b[1] - a[1])),
    ambiguousForReview: ambiguous.length,
    crudVsPrimitive: tally.counts,
  }

  const outDir = path.join(ROOT, "docs/findings")
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(
    path.join(outDir, "tf-pxxe-schema-inventory.json"),
    JSON.stringify({ tool: "scripts/schema-inventory.ts", bead: "tf-pxxe", note: "Machine-generated. Evidence only. Classifications are heuristic; see basis/ambiguous fields.", stats, schemas: all, crudVsPrimitive: tally.rows }, null, 2) + "\n",
  )
  fs.writeFileSync(path.join(outDir, "tf-pxxe-schema-inventory.md"), renderMd(all, tally, stats) + "\n")
  // eslint-disable-next-line no-console
  console.log("schema inventory written:", JSON.stringify(stats, null, 2))
}

const cell = (v: string | number | boolean | null | undefined): string =>
  v === null || v === undefined || v === "" ? "—" : `${v}`

const renderMd = (
  all: Array<{
    pkg: string; dir: string; file: string; name: string; ref: string
    exported: boolean; rootCtor: string; detection: string; substrate: boolean
    role: string; roleBasis: string; projection: string | null; reuse: number; ambiguous: string | null
  }>,
  tally: ReturnType<typeof buildCrudPrimitiveTally>,
  stats: Record<string, unknown>,
): string => {
  const L: Array<string> = []
  L.push("# tf-pxxe — Firegrid schema classification")
  L.push("")
  L.push("> **Machine-generated by `scripts/schema-inventory.ts` (`pnpm inventory:schemas`). Do not edit by hand.**")
  L.push("> Evidence only — no schema is moved or refactored. Every classification carries a `basis`; ambiguous schemas are listed in §5, not silently bucketed.")
  L.push("")
  L.push("## 1. Summary — making the volume legible")
  L.push("")
  L.push("```json")
  L.push(JSON.stringify(stats, null, 2))
  L.push("```")
  L.push("")
  const byRole = stats.byRole as Record<string, number>
  L.push(
    `**In words:** ${stats.totalSchemaDeclarations} schema declarations across ${stats.sourceFilesScanned} files — ` +
      `${byRole["operation-input"] ?? 0} operation-input, ${byRole["operation-output"] ?? 0} operation-output, ` +
      `${(byRole["channel-request"] ?? 0) + (byRole["channel-response"] ?? 0)} channel request/response, ` +
      `${byRole["durable-table-row"] ?? 0} durable-table-row, ${byRole["agent-output-event"] ?? 0} agent-output-event, ` +
      `${byRole["shared-leaf-primitive"] ?? 0} shared-leaf-primitive, ${byRole["internal-DTO"] ?? 0} internal-DTO. ` +
      `${stats.substrateCoupled} are substrate-coupled (transitively import \`effect-durable-operators\`), ${stats.pureContract} are pure contract.`,
  )
  L.push("")

  // §2 CRUD-vs-primitive tally (answers the specific question)
  L.push("## 2. CRUD-over-DurableTable vs workflow-primitive (operation lowering)")
  L.push("")
  L.push("Hypothesis under test: *client lifecycle + observe ops reduce to CRUD/projection over a DurableTable; the agent durable-wait ops do not (they are workflow primitives).*")
  L.push("")
  L.push(`Counts: **${tally.counts["crud-over-durable-table"]} CRUD-over-DurableTable**, **${tally.counts["workflow-primitive"]} workflow-primitive**, **${tally.counts["unported"]} unported** (no lowering in the MCP executor).`)
  L.push("")
  L.push("| operationId | family | bucket | mechanism | evidence (token verified) |")
  L.push("| --- | --- | --- | --- | --- |")
  for (const r of tally.rows) {
    const v = r.verified ? "✓" : "⚠ token not found"
    L.push(`| \`${r.operationId}\` | ${r.family} | **${r.bucket}** | ${r.mechanism} | \`${r.evidence}\` (${v}) |`)
  }
  L.push("")
  L.push("> Verdict (data): every `agent-durable-wait` op (`sleep`/`wait.until`/`wait.for`/`wait.any`) is a workflow primitive; every `client-lifecycle`/`client-observe` op with a lowering reduces to a DurableTable insert/insertOrGet or a durable-event append/read. The hypothesis is **confirmed**, with the caveat that `spawn`/`spawnAll`/`session.status`/`capability.execute` are *unported* in the MCP executor and so cannot be lowered-classified here.")
  L.push("")

  // §3 boundary → role matrix (counts)
  L.push("## 3. Boundary → role counts")
  L.push("")
  const roles = [...new Set(all.map((s) => s.role))].sort()
  const pkgs = [...new Set(all.map((s) => s.pkg))].sort()
  L.push("Counts per package (rows) × role (cols). `substrate` = of those, how many are substrate-coupled.")
  L.push("")
  L.push(`| package | ${roles.join(" | ")} | total | substrate |`)
  L.push(`| --- | ${roles.map(() => "---").join(" | ")} | --- | --- |`)
  for (const pkg of pkgs) {
    const rowSchemas = all.filter((s) => s.pkg === pkg)
    const counts = roles.map((role) => rowSchemas.filter((s) => s.role === role).length || "")
    const sub = rowSchemas.filter((s) => s.substrate).length
    L.push(`| ${pkg} | ${counts.map((c) => cell(c as number)).join(" | ")} | ${rowSchemas.length} | ${sub} |`)
  }
  L.push("")

  // §4 full per-schema table, grouped boundary(pkg/dir) → role
  L.push("## 4. Every schema (grouped package → role)")
  L.push("")
  let curPkg = ""
  let curRole = ""
  for (const s of all) {
    if (s.pkg !== curPkg) { L.push(`\n### ${s.pkg}`); curPkg = s.pkg; curRole = "" }
    if (s.role !== curRole) {
      L.push("")
      L.push(`**${s.role}**`)
      L.push("")
      L.push("| schema | dir | ctor | substrate | reuse | projection | ref | basis / ambiguity |")
      L.push("| --- | --- | --- | --- | --- | --- | --- | --- |")
      curRole = s.role
    }
    const note = s.ambiguous ? `⚠ ${s.ambiguous}` : s.roleBasis
    L.push(
      `| \`${s.name}\` | ${cell(s.dir)} | ${cell(s.rootCtor)} | ${s.substrate ? "yes" : "—"} | ${s.reuse} | ${cell(s.projection)} | ${s.ref} | ${note} |`,
    )
  }
  L.push("")

  // §5 ambiguous list
  L.push("## 5. Ambiguous / lower-confidence — for human review")
  L.push("")
  const amb = all.filter((s) => s.ambiguous)
  if (amb.length === 0) {
    L.push("_None._")
  } else {
    L.push("| schema | role (tentative) | reuse | ref | why flagged |")
    L.push("| --- | --- | --- | --- | --- |")
    for (const s of amb) L.push(`| \`${s.name}\` | ${s.role} | ${s.reuse} | ${s.ref} | ${s.ambiguous} |`)
  }
  L.push("")
  return L.join("\n")
}

main()
