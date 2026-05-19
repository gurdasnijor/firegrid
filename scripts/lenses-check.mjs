#!/usr/bin/env node
// Anchor ↔ index consistency for code lenses.
//
// Fails if a `// LENS: <name>` anchor in the tree references a name that
// is not declared as a `## <name> — <SHAPE>` section in LENSES.md. Warns
// (does not fail) on declared lenses with zero anchors — a lens may be
// pre-seeded ahead of its anchor — but a dangling anchor is always an
// error: the detail it points at does not exist.
//
// Zero-dep, no ESLint coupling (the flat config is ratchet-heavy; this
// stays a standalone gate). Run: `node scripts/lenses-check.mjs`.
import { warn, error, log } from "node:console";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ANCHOR_RE = /\/\/\s*LENS:\s*([a-z0-9:-]+)/g;
const DECL_RE = /^##\s+([a-z0-9:-]+)\s+—\s+(DECISION|PATTERN|BOUNDARY|HAZARD)\s*$/gm;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".turbo"]);

const declared = new Set();
const lensesMd = readFileSync(join(ROOT, "LENSES.md"), "utf8");
for (const m of lensesMd.matchAll(DECL_RE)) declared.add(m[1]);

const anchors = new Map(); // name -> ["path:line", ...]
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e)) {
      const lines = readFileSync(p, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(ANCHOR_RE)) {
          const rel = p.replace(ROOT, "");
          (anchors.get(m[1]) ?? anchors.set(m[1], []).get(m[1])).push(`${rel}:${i + 1}`);
        }
      });
    }
  }
};
walk(join(ROOT, "packages"));

const dangling = [...anchors.keys()].filter((n) => !declared.has(n));
const unanchored = [...declared].filter((n) => !anchors.has(n));

for (const n of unanchored) warn(`warn: lens "${n}" declared in LENSES.md has no anchor`);
if (dangling.length) {
  for (const n of dangling)
    error(`error: anchor "${n}" (${anchors.get(n).join(", ")}) not declared in LENSES.md`);
  process.exit(1);
}
log(`lenses-check: ${declared.size} declared, ${anchors.size} anchored, ok`);
