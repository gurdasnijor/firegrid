# Tooling handoff — evidence-tool lineage + dead-code cleanup (2026-06-03)

For the next tooling agent. This session built an **evidence→action chain** of
re-runnable inventory tools and used them to start cruft removal. Your first task
will address the open issues flagged at the bottom (§7). Read that first.

## 0. TL;DR — the lineage (all merged or draft)

| bead | PR | what | artifact |
| --- | --- | --- | --- |
| tf-7whh | #878 (merged) | operation × surface inventory | `scripts/operation-inventory.ts`, `docs/findings/tf-7whh-operation-inventory.{md,json}` |
| tf-pxxe | #879 (merged) | schema classification (boundary×role×projection×reuse) | `scripts/schema-inventory.ts`, `docs/findings/tf-pxxe-schema-inventory.{md,json}` |
| tf-uc8u | #886 (merged) | test-only / dead production-export gate | `scripts/test-only-export-gate.ts`, `docs/findings/tf-uc8u-test-only-exports.{md,json}` |
| tf-i2y3 | #891 (draft) | delete 37 dead exports (−1,228 LoC) | `docs/findings/tf-i2y3-dead-export-removal.md` |

Each tool is **deterministic, re-runnable, zero-new-dep**, and writes a committed
`docs/findings/*` artifact that becomes the input to the next task. That chain is
the single biggest velocity win — **build the evidence tool first, commit its
artifact, then act on it.** Don't act on a hand-sampled guess.

## 1. The reusable tooling pattern (copy this)

**Hybrid reflection + AST, no new deps:**
- **Runtime reflection** for anything the code computes at module-eval time —
  e.g. `getFiregridProjectionMetadata(schema)` gives the *resolved* projection
  values exactly as they land on the AST. Most accurate; immune to naming.
- **TypeScript compiler API** (`import * as ts from "typescript"`) for `file:line`
  anchors, import graphs, and any surface that isn't reflectable (channels,
  declarations). **Use `typescript`, NOT `ts-morph`** — ts-morph was removed in
  #862 and isn't installed; the raw API is always hoisted.
- Tools live in `scripts/*.ts`, run via `tsx` (`pnpm <name>`), and are **outside
  the gated eslint/typecheck projects** (consistent with the existing `.mjs`
  tooling). They still typecheck clean apart from missing ambient `node` types in
  ad-hoc `tsc` invocations.
- **Reuse machinery:** export the shared helpers + `build()` from one tool and
  import them in the next; guard `main()` behind an entry check so importing is
  side-effect-free:
  ```ts
  const isEntry = process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  if (isEntry) main()
  ```
  `schema-inventory.ts` imports `operation-inventory.ts`'s `build()` this way and
  the latter's output stays byte-identical (verified). Refactor-to-share is safe
  if you re-check determinism.

**Real import resolution beats grep — always.** A text grep for `Approval` matched
a test's local `const Approval = DurableDeferred.make(...)` — completely unrelated
to the `ApprovalCall*Schema` exports. If your tool reasons about usage, build a
resolver: relative paths + `@firegrid/*` package-export subpaths (read each
`package.json#exports`, they point to `./src/...`) + **rename-aware** barrel
following (`export { foo as bar } from`) + **member-precise** namespace handling.

## 2. What worked (velocity + understandability)

- **Evidence tool → committed artifact → next task.** Four beads chained cleanly
  because each left a machine-checked `docs/findings/*` the next one consumed.
- **Validate every finding against ground-truth (grep/source) before trusting the
  count, and before deleting.** This caught real bugs every single time (see §3).
- **Deterministic artifacts** (byte-identical re-runs) make diffs reviewable and
  let the PO see deltas (DEAD 263→232).
- **`pnpm preflight` is the deletion safety net.** Delete, run preflight, let
  typecheck/knip/lint tell you what broke, iterate to a fixpoint. Don't reason
  about safety in your head when the gate can prove it.
- **Surface the policy fork; don't decide it.** The tf-uc8u gate can't auto-fail
  (its TEST-ONLY class mixes cruft with public API exercised only by tests), so it
  ships report-only and the strict+allowlist decision was left to the PO.

## 3. "Count is not the truth" — it bit every tool, both directions

This is THE recurring lesson. A metric/count is a starting hypothesis, never the
answer. Per-item verification found:
- **Undercounts** from name-convention pre-filters: `PermissionRespondInputSchema`
  doesn't end in `ToolInputSchema`, so a regex filter missed it. → Iterate *all*
  exports, trust the annotation/AST, not the name.
- **Overcounts / false shielding** from resolver gaps:
  - **Type-position namespace access** (`import type * as NS` + `NS.Foo` in a
    type) is a TS `QualifiedName`, **not** a `PropertyAccessExpression` — missing
    it made every namespace look "opaque" and credited *all* its exports as used,
    which initially **hid `ApprovalCall*`**.
  - **Renamed re-exports** (`export { foo as bar }`) flagged the renamed origin as
    dead.
- **"DEAD" ≠ deletable.** Of 263 DEAD exports, only **58 are true orphans**
  (`intraModuleUse:false`); **205 are over-exports of live internal code**
  (`intraModuleUse:true`, e.g. `WaitForToolMatchSchema` helps the live
  `WaitForToolInputSchema`) — deleting their declarations breaks the build.
- **Detector false-positives** surfaced during deletion: `acpPermissionPolicies`,
  `runtimeContextMcpPath`, etc. were flagged DEAD but are genuinely used (the
  tf-uc8u resolver missed those refs). Grep-verify before deleting saved them.

Takeaway: when a tool reports N, read a sample of N against source before you
report or act. Especially before deleting.

## 4. Gotchas to avoid (mechanical)

- **`*/` inside a block comment terminates it.** Writing `packages/*/src` in a
  JSDoc comment broke the parse. Use `packages/<pkg>/src`.
- **`effect` is not hoisted at the repo root; `typescript` is.** A `scripts/*.ts`
  tool can `import "typescript"` but not `import "effect"` directly. Read the
  returned `Option` structurally (`o._tag === "Some" ? o.value : null`) instead of
  importing `effect`. Protocol/runtime modules resolve their own `effect`, so
  importing *them* is fine.
- **Effect Schemas are callable (functions, not plain objects).** `.ast` is
  reachable by property access but **`"ast" in schema` is false**. Don't gate on
  `typeof === "object"`; accept object-or-function with a truthy `.ast`.
- **`tsx` from `/tmp` can't resolve `typescript`/`effect`** — run probe scripts
  inside the worktree.
- **eslint flat config needs the root `.` invocation.** `eslint <file>` returns
  nothing ("no matching configuration") → empty `--format json`. Run
  `eslint . --format json` from the package root to get machine-readable findings.
- **`@typescript-eslint/no-unused-vars` has no autofixer here** (and `lint` is
  `--max-warnings 0`, so warnings fail). After deleting exports you must remove
  the now-unused imports + private helpers yourself. They **cascade** (removing a
  helper orphans its imports; removing an export can orphan a whole file →
  knip "unused file"). Iterate an AST cleaner to a fixpoint (took 4 passes here).
- **`git rm` fails on files with pending edits** — use `rm` + `git add`.
- **Background `pnpm preflight` exit code is easy to misread.** If you run it as
  part of a compound command, the *final echo's* exit (0) masks preflight's real
  exit — the task-notification "exit 0" was the compound's. Capture `$?`
  immediately after `pnpm preflight`, or grep its own output for the failure.

## 5. Repo-understandability insights

- **The op/schema surface is the fog the PO wanted cut.** The inventory tools
  *are* the map; keep them re-runnable and let the artifacts be the canonical
  reference rather than re-deriving by hand.
- **Heavy barrel / public-subpath re-export structure.** `@firegrid/protocol`
  exposes ~17 fine-grained subpaths (`./agent-tools`, `./channels/router`, …),
  each an `export *` barrel. This makes *every* src export an "entry export," which
  is exactly why **knip can't see test-only-used or barrel-shielded-dead code** —
  hence the bespoke tf-uc8u gate. Expect to fight this structure.
- **`firegridProjection` is the consolidation seam for 2 of 3 operation surfaces**
  (agent-tools + session-facade); the **channel surface is disjoint** (free-form
  target strings, no `operationId` back-reference). See `tf-7whh` findings.
- **CRUD-vs-primitive (tf-pxxe):** client lifecycle/observe ops reduce to
  DurableTable CRUD; the agent durable-wait ops (`sleep`/`wait.*`) are workflow
  primitives. `spawn`/`spawnAll`/`session.status`/`capability.execute` are
  *unported* in the MCP executor (hit the `default`) — that's real incompleteness,
  not a gap in the tool.
- **"Net LoC" is misleading on cleanup PRs.** tf-i2y3 showed +573/−1,960 total,
  but that included regenerated `docs/findings` artifacts; the real *source*
  removal was −1,228. Always split production-src net from docs/artifact net
  before judging a deletion PR.

## 6. Process improvements

- Build the inventory/evidence tool first; commit its artifact; *then* act.
- Validate against grep/source before trusting a count and before deleting.
- Reuse machinery (export helpers + entry-guarded `main()`); don't restart.
- Let preflight prove deletion safety; iterate cleanup to a fixpoint.
- Surface architecture/policy forks to the PO (gate report-only vs strict+
  allowlist); don't decide unilaterally. Bead the fork if the PO is away.
- For deletions, separate production-src net from docs/test net before reporting.

## 7. YOUR FIRST TASK — open issues this session surfaced

In rough priority:

1. ~~**Fix the tf-uc8u detector's reference-resolution false-positives.**~~
   **RESOLVED — and the diagnosis above was WRONG (tf-ztwu, 2026-06-03).** The
   six exports named below were NOT false-positives; every one is *genuinely
   dead*, verified against source:
   - `acpPermissionPolicies`, `runtimeContextMcpPath` — the live importers use a
     same-named **copy in `@firegrid/runtime`** (`stdio-edge.ts` /
     `runtime-context-mcp-base-url.ts`); the flagged `@firegrid/protocol` copies
     have zero importers (`@firegrid/protocol/mcp` is imported by nobody at all).
   - `insertLocalRuntimeContext`, `findRuntimeContextMcpChannel`,
     `RuntimeContextMcpChannelCatalogLive` — only barrel-forward or comment refs.
   - `evaluateFieldEquals` — re-exported through two barrels, but the only other
     mention is a *code comment*; no import/call anywhere.

   The grep-based refutation in the handoff matched **cross-package name
   collisions, barrel re-exports, and comments**, then asserted "used" without
   checking *which declaration* — the exact "inference ≠ verified ground-truth"
   trap. The gate's real import resolution was correct on all six.

   The detector *did* have one genuine gap, but a different one: **dynamic
   `import("literal")` was invisible** (only static `ImportDeclaration` parsed),
   which falsely flagged `permissionDecisionDeferred` (used via `import()` in
   `channel-bindings.ts`) and `sseStream` (in `Read.ts`). Rather than teach the
   detector to chase dynamic imports, tf-ztwu **enforces the invariant**: a new
   `local/no-literal-dynamic-import` ESLint rule bans literal-specifier dynamic
   imports (computed `import(expr)` plugin loaders stay legal), and the two sites
   were converted to static imports. DEAD is now 217 and trustworthy w.r.t. the
   import graph. **Lesson:** when a count looks wrong, verify the *specific
   declaration* against source before declaring the tool broken.

2. **The 205 over-exports (de-export pass).** Most "DEAD" is live internal code
   that's merely `export`ed with no consumer (`intraModuleUse:true`). The clean
   surface-reduction is to *drop the `export` keyword* (not delete the
   declaration). Net-zero LoC but big public-surface shrink. Verify preflight green
   per batch (a de-export can't break the build unless a test imports it — and
   DEAD means none does).

3. **Gate policy fork (tf-uc8u).** To make the gate *enforcing* (not just
   report-only), the TEST-ONLY class (currently 31) needs triage into
   `cruft → delete` vs `public API → allowlist`, then wire `--strict` into
   preflight. This is a PO decision — confirm before building the allowlist.

4. **Finish the safe DEAD deletions.** tf-i2y3 deleted 37 of the 58 true orphans
   in internal packages; the caution-zone orphans (client-sdk / host-sdk /
   effect-durable-* / observability / bin / experiment) were excluded as likely
   public API / entry points. If the PO confirms which are external API, the rest
   can go.

## 8. Carried-forward gotchas (from prior tooling handoffs — still true)

- **Read the screen, not the `lane-sweep running=` flag** — it's stale; read the
  tail (3× near-misses historically).
- **Unquoted heredocs in `cmux-dispatch` eval backticks/`$` break dispatch.** Use
  `<<'MSG'` + hardcoded ids. (Pre-write dispatch templates.)
- The **"How is Claude doing?" feedback dialog intercepts Enter** and can block a
  lane dispatch until dismissed.
- **Worktree/branch cleanup ordering:** remove the worktree *before* `git branch
  -D`; `gh --delete-branch` errors (benignly) while a worktree holds the branch.
  (This session's tf-i2y3 worktree was auto-reaped mid-task — the branch was
  already pushed, so re-`git worktree add <branch>` to continue.)
- **Off-vision re-tier (tf-p433):** a clean tier structure is the OUTPUT of
  resolved dependencies, not something you `git mv` onto a coupled module. Don't
  invent glue to force a layout.
- **Don't over-flag caveats as blockers.** "restart not proven" was dismissed by
  the PO twice (DurableTable replay-then-tail = free catch-up).
- **Phantom citations:** never cite a `doc@sha` you didn't open; re-ground to
  in-repo `file:line`.
- **Bead the fork, don't guess** when an irreversible/architecture decision arises
  and the PO is away.
