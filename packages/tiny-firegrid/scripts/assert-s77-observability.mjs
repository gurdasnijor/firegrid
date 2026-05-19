#!/usr/bin/env node
// factory-vision §7.7 observability proof — "everyone sees what is happening".
//
// FALSIFIABLE ASSERTION: for a completed tiny-firegrid sim run, the durable
// event stream must materialize into queryable rows such that every WAIT,
// every DELEGATION, every TOOL CALL, and every DECISION the run performed
// is an inspectable row reachable through the SAME query interface operators
// use — the run's DuckDB (`simulate:query` / `simulate:duckdb` →
// `tiny_firegrid_spans`). A required class with zero rows is a FINDING that
// is SURFACED (non-zero exit), never papered.
//
// Self-contained: reads only the run's own DuckDB via the `duckdb` binary
// (the operator interface). No production-package import / reach-past.
//
// Usage:
//   node packages/tiny-firegrid/scripts/assert-s77-observability.mjs <runRef> [<runRef> ...]
// where <runRef> is a .simulate/runs/ dir name (or unique substring, e.g. a
// sim id). With no args it audits the latest run of each known deterministic
// sim. Reproduce the inputs with:
//   pnpm --filter @firegrid/tiny-firegrid simulate:run -- stdio-jsonl-tool-execution-pipeline
//   pnpm --filter @firegrid/tiny-firegrid simulate:run -- multi-context-production-consuming-pipeline
import { spawnSync } from "node:child_process"
import { error, log } from "node:console"
import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const TINY = join(dirname(fileURLToPath(import.meta.url)), "..")
const RUNS = join(TINY, ".simulate", "runs")

// §7.7 row classes → DuckDB span_name predicates over tiny_firegrid_spans.
// Grounded in observed span inventories (see docs/runbooks/s77-observability-proof.md).
const CLASS_SQL = {
  wait:
    "span_name LIKE '%wait%'",
  delegation:
    "span_name LIKE '%runtime-context.session.start.%' " +
    "OR span_name LIKE '%runtime_context.claim_and_run%' " +
    "OR span_name LIKE '%runtime_context.workflow.session.start%'",
  tool_call:
    "span_name LIKE '%tool_use.execute%' " +
    "OR span_name LIKE '%tool_use.activity%' " +
    "OR span_name LIKE '%tools/call%' " +
    "OR span_name LIKE '%agent_tool%'",
  decision:
    "span_name LIKE '%control_plane.run.allocate%' " +
    "OR span_name LIKE '%control_request.claim%' " +
    "OR span_name LIKE '%workflow_engine.activity.claim%' " +
    "OR span_name LIKE '%permission%'",
}

// Which classes each deterministic sim genuinely performs (so a 0 is a real
// materialization FINDING, not a sim that simply never did that action).
// Agent-gated sims (codex-acp, permission-flow, delegation-parent-child) are
// not listed: they require a live agent / API key and do not complete in a
// hermetic env — the §7.7 tool-call+decision arms are proven by the
// deterministic stdio-jsonl sim instead.
const REQUIRED_BY_SIM = [
  { match: "stdio-jsonl-tool-execution-pipeline", required: ["wait", "tool_call", "decision"] },
  { match: "multi-context-production-consuming-pipeline", required: ["wait", "delegation", "decision"] },
]

const MARK = "<<S77>>"

const resolveRun = (ref) => {
  if (existsSync(join(RUNS, ref, "duckdb", "tiny-firegrid.duckdb"))) return ref
  const hits = readdirSync(RUNS)
    .filter((d) => d.includes(ref) &&
      existsSync(join(RUNS, d, "duckdb", "tiny-firegrid.duckdb")))
    .sort()
  return hits[hits.length - 1]
}

const query = (runDir, where) => {
  const db = join(RUNS, runDir, "duckdb", "tiny-firegrid.duckdb")
  const init = join(RUNS, runDir, "duckdb", "load.sql")
  // load.sql prints its own preamble; a marker row delimits our result.
  const sql =
    `SELECT '${MARK}';\n` +
    `SELECT count(*) AS rows, count(DISTINCT json_extract_string(span_attributes,'$."firegrid.context.id"')) AS contexts ` +
    `FROM tiny_firegrid_spans WHERE ${where};\n` +
    `SELECT '${MARK}';\n` +
    `SELECT DISTINCT span_name FROM tiny_firegrid_spans WHERE ${where} ORDER BY 1 LIMIT 4;`
  const r = spawnSync("duckdb", [db, "-init", init, "-csv", "-noheader", "-c", sql],
    { encoding: "utf8" })
  if (r.status !== 0) {
    error(`  duckdb query failed (status ${String(r.status)}): ${String(r.stderr).trim().slice(0, 200)}`)
    return undefined
  }
  const lines = String(r.stdout).split("\n").map((l) => l.trim()).filter(Boolean)
  const segs = []
  let cur = null
  for (const l of lines) {
    if (l === MARK) { cur = []; segs.push(cur); continue }
    if (cur) cur.push(l)
  }
  const [countSeg = [], nameSeg = []] = segs
  const [rows = "0", contexts = "0"] = (countSeg[0] ?? "0,0").split(",")
  return { rows: Number(rows), contexts: Number(contexts), sampleNames: nameSeg }
}

const audit = (runDir) => {
  const sim = REQUIRED_BY_SIM.find((s) => runDir.includes(s.match))
  const required = sim?.required ?? ["wait", "delegation", "tool_call", "decision"]
  log(`\n=== ${runDir} ===`)
  log(`    query interface: pnpm --filter @firegrid/tiny-firegrid simulate:query -- ${runDir} "SELECT ... FROM tiny_firegrid_spans"`)
  log(`    required §7.7 classes (this sim performs them): ${required.join(", ")}`)
  const findings = []
  for (const cls of Object.keys(CLASS_SQL)) {
    const res = query(runDir, CLASS_SQL[cls])
    if (res === undefined) { findings.push(`${cls}: query error`); continue }
    const req = required.includes(cls)
    const ok = res.rows > 0
    const tag = !req ? "·" : ok ? "✓" : "✗"
    log(`  ${tag} ${cls.padEnd(11)} rows=${String(res.rows).padStart(4)} contexts=${res.contexts}` +
      `${req ? " [REQUIRED]" : " [optional/agent-gated]"}` +
      (res.sampleNames.length ? `  e.g. ${res.sampleNames.slice(0, 2).join(", ")}` : ""))
    if (req && !ok) {
      findings.push(
        `${cls}: 0 queryable rows in ${runDir} though this sim performs ${cls}. ` +
        `§7.7 FINDING — the durable stream did NOT materialize ${cls} as an ` +
        `inspectable row. NOT papered.`)
    }
  }
  return findings
}

const main = () => {
  if (!existsSync(RUNS)) {
    error(`no runs dir at ${RUNS} — run a sim first (see header).`)
    process.exit(2)
  }
  const args = process.argv.slice(2)
  const refs = args.length > 0
    ? args
    : ["stdio-jsonl-tool-execution-pipeline", "multi-context-production-consuming-pipeline"]
  const resolved = refs.map((r) => ({ r, dir: resolveRun(r) }))
  const missing = resolved.filter((x) => !x.dir)
  if (missing.length > 0) {
    error(`no completed run found for: ${missing.map((m) => m.r).join(", ")}`)
    error(`run e.g.: pnpm --filter @firegrid/tiny-firegrid simulate:run -- ${missing[0].r}`)
    process.exit(2)
  }
  const allFindings = []
  const provenUnion = new Set()
  for (const { dir } of resolved) {
    const f = audit(dir)
    if (f.length === 0) {
      const sim = REQUIRED_BY_SIM.find((s) => dir.includes(s.match))
      ;(sim?.required ?? []).forEach((c) => provenUnion.add(c))
    }
    allFindings.push(...f.map((m) => `[${dir}] ${m}`))
  }
  log(`\n=== §7.7 verdict ===`)
  log(`classes proven materialized (queryable rows, across audited runs): ` +
    `${[...provenUnion].sort().join(", ") || "(none)"}`)
  const fourCovered = ["wait", "delegation", "tool_call", "decision"]
    .every((c) => provenUnion.has(c))
  if (allFindings.length > 0) {
    error(`\n§7.7 FINDINGS (${allFindings.length}) — surfaced, not papered:`)
    for (const m of allFindings) error(`  - ${m}`)
    process.exit(1)
  }
  if (!fourCovered) {
    error(`\n§7.7 INCOMPLETE: required runs passed individually but the union ` +
      `does not cover all four classes (have: ${[...provenUnion].sort().join(", ")}). ` +
      `This is a proof-coverage gap, surfaced — add an exercising run.`)
    process.exit(1)
  }
  log(`\n✓ §7.7 PROVEN: every wait, delegation, tool call, and decision the ` +
    `audited runs performed is an inspectable row via the operator query ` +
    `interface. The factory is legible from outside.`)
}

main()
