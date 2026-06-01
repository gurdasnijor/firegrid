// Misuse-resistance STRUCTURAL guard — substrate types must not leak into the
// public client/host barrels.
//
// Proof obligation for SDD_FIREGRID_GATEWAY_SEPARATION_OF_CONCERNS §9.1
// obligation 4 + §9.2 (tf-r06u.27): "no substrate (DurableTable / WorkflowEngine
// / internal Tags) in public host options or client verb signatures — substrate
// stays behind channel-target indirection."
//
// What this checks: the PUBLIC barrels (`@firegrid/client-sdk` and
// `@firegrid/host-sdk`) must not RE-EXPORT a substrate symbol, except a small,
// explicitly-tracked allowlist of documented escape hatches (each tied to its
// deletion bead). A new substrate re-export fails the gate. This is the
// structural complement to the type-level negative footgun corpus
// (`packages/runtime/test/misuse-resistance-footguns.test.ts`, F3).
//
// Scope honesty: this guards re-EXPORTED NAMES on the barrels — the most common
// leak vector. Deep transitive signature analysis (a substrate type appearing
// inside an exported function signature) is a future enhancement that would use
// the TypeScript compiler API; it is NOT covered here, and the PR note says so.

import { readFileSync } from "node:fs"
import { error, log } from "node:console"
import process from "node:process"

// Substrate / engine-internal symbols that must never be part of a public
// client/host signature surface.
const BANNED_SUBSTRATE_SYMBOLS = [
  "DurableTable",
  "SignalTable",
  "UnifiedTable",
  "WorkflowEngine",
  "WorkflowEngineTable",
  "DurableStreamsWorkflowEngine",
  "RuntimeControlPlaneTable",
  "RuntimeOutputTable",
  "VerifiedWebhookFactTable",
  "SandboxSupervisorCommandTable",
  "RuntimeContextSessionAdapter",
]

// Documented escape hatches that are KNOWN debt, tracked for removal. Each must
// name its tracking bead. The guard allows these but reports them so they stay
// visible and cannot quietly multiply.
const ALLOWLIST = {
  FiregridRuntimeTables: "tf-8oaq (durable-table escape hatch; narrow behind channels)",
  firegridRuntimeTableTags: "tf-8oaq (durable-table escape hatch; narrow behind channels)",
  runtimeControlPlaneStreamUrl: "tf-8oaq (stream-url helper escape hatch)",
}

// Public barrels to scan. host-sdk is currently `export {}` (empty) — scanning
// it makes the guard catch the first substrate leak the moment host-sdk gains a
// surface.
const PUBLIC_BARRELS = [
  "packages/client-sdk/src/index.ts",
  "packages/host-sdk/src/index.ts",
]

// Collect every re-exported identifier from `export { ... } from "..."` and
// `export { ... }` statements (ignoring `type`-only vs value — a leaked type is
// still a leak). Returns a Set of exported names.
const collectExportedNames = (source) => {
  const names = new Set()
  const exportBlockRe = /export\s+(?:type\s+)?\{([^}]*)\}/g
  let m
  while ((m = exportBlockRe.exec(source)) !== null) {
    for (const raw of m[1].split(",")) {
      const piece = raw.trim()
      if (piece === "") continue
      // strip leading `type ` and handle `X as Y` → the exported name is `Y`
      const noType = piece.replace(/^type\s+/, "")
      const asMatch = noType.match(/\bas\s+([A-Za-z0-9_$]+)\s*$/)
      const name = asMatch ? asMatch[1] : noType.split(/\s+/)[0]
      if (name) names.add(name)
    }
  }
  return names
}

let failed = false
const knownDebt = []

for (const barrel of PUBLIC_BARRELS) {
  let source
  try {
    source = readFileSync(barrel, "utf8")
  } catch {
    error(`public-surface-substrate-leak: cannot read ${barrel}`)
    process.exit(1)
  }
  const exported = collectExportedNames(source)
  for (const name of exported) {
    if (!BANNED_SUBSTRATE_SYMBOLS.includes(name) && !(name in ALLOWLIST)) continue
    if (name in ALLOWLIST) {
      knownDebt.push(`${barrel}: ${name} — allowed escape hatch: ${ALLOWLIST[name]}`)
      continue
    }
    // A banned substrate symbol is exported and NOT allowlisted.
    error(
      `public-surface-substrate-leak: ${barrel} re-exports substrate symbol \`${name}\`.\n` +
        `  Substrate must stay behind channel-target indirection (opaque agent-meaningful\n` +
        `  names), never a raw handle on the public surface. If this is an intentional,\n` +
        `  documented escape hatch, add it to ALLOWLIST in this script WITH a tracking bead.`,
    )
    failed = true
  }
}

if (knownDebt.length > 0) {
  log("public-surface-substrate-leak: tracked escape-hatch debt (visible, not failing):")
  for (const d of knownDebt) log(`  - ${d}`)
}

if (failed) {
  error("public-surface-substrate-leak: FAILED — a non-allowlisted substrate symbol leaked.")
  process.exit(1)
}

log("public-surface-substrate-leak: OK — no non-allowlisted substrate symbols on the public barrels.")
