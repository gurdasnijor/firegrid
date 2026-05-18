# Legacy cleanup pass — follow-up tracker

Date: 2026-05-17
Type: live follow-up tracker (status-bearing; update as items close)
Parent: `docs/research/legacy-cleanup-pass-2026-05-17.md` (PR #319)

PR #319 was a mechanical sweep that deliberately **deferred four
findings** as out-of-scope. Burying actionable follow-ups in a dated
research note means they evaporate. This is the live tracker; each item
has an explicit status and the next concrete action. Update the status
column when an item lands — do not let this rot into prose.

| ID | Finding | Status | Where |
| --- | --- | --- | --- |
| F1 | `RuntimeIngressTable` dead surface | **RESOLVED** | PR #322 |
| F2 | `apps/factory` knip coverage | **RESOLVED** | this PR |
| F3 | knip `includeEntryExports` policy (725 dataset) | **OPEN — needs decision** | — |
| F4 | runtime root-barrel redundant duals | **OPEN — blocked** | — |

## F1 — `RuntimeIngressTable` dead surface → RESOLVED (PR #322)

#319 flagged this as "genuinely dead but out of scope (protocol
public-API change → own review)." Acted on in **PR #322**.

Scope correction over #319's framing: the dead set is **not** the
`runtime-ingress` module. It is exactly `RuntimeIngressTable` (class),
`RuntimeIngressTableService` (type), `nextRuntimeIngressSequence` (the
sole consumer of that service type), the file-local `runtimeIngressSchemas`
const, and the now-unused `DurableTableService` import. The rest of
`runtime-ingress/schema.ts` (`PublicPromptRequestSchema`,
`RuntimeIngressInputRowSchema`, `makeRuntimeIngressInputRow`,
`promptToRuntimeIngressRequest`, …) is **live** across client-sdk,
host-sdk, `apps/factory`, and protocol contract tests. Excision, not a
module delete. Gates green (typecheck 17/17, lint:deps clean, knip 0).

## F2 — `apps/factory` knip coverage → RESOLVED (this PR)

#319 deferred this estimating "~102 internal unused-export candidates +
7 false-positive deps … judgment-heavy, defer." **That estimate was an
artifact of the wrong config**, not the real cost.

#319's projection assumed adding factory with a naive `src/**`-only
`project` glob and no Next entries — under which everything in
`app/`,`components/`,`lib/` is unreachable and falsely "unused" (factory
has zero `.tsx` in `src/`). The **correct** config is gate-clean:

```jsonc
"apps/factory": {
  "entry": ["src/index.ts", "src/bin/live-smoke.ts", "src/bin/env.ts"],
  "project": ["{app,components,lib,src}/**/*.{ts,tsx,mts}"],
  "ignoreDependencies": [
    "tailwindcss", "tw-animate-css", "@tailwindcss/postcss", "postcss"
  ]
}
```

Why it works:
- knip's built-in **Next.js plugin** (active because `next` is a
  dependency) auto-registers app-router entries — `app/**/{page,layout,
  route}.tsx`, `next.config.mjs` — so `app/`,`components/`,`lib/`
  exports are entry-reachable and not false-flagged. No manual Next
  entry list needed.
- `ignoreDependencies` covers **exactly** the four deps knip cannot see
  statically: `tailwindcss` + `tw-animate-css` (`@import`-ed in
  `app/globals.css`), `@tailwindcss/postcss` + `postcss` (PostCSS build
  chain). Verified: each has **0** JS `import`/`require` occurrences in
  factory source.
- The shadcn JS deps (`@radix-ui/react-slot`/`-tabs`,
  `class-variance-authority`, `clsx`, `tailwind-merge`) are **not**
  ignored — they are statically visible in `components/ui/*.tsx`, so
  knip resolves them as used. No over-ignoring → no masked dead deps.

Measured result: **global knip gate stays 0 issues / 0 files**,
`.knip-baseline.json` unchanged (0). factory is now covered for real,
with no triage backlog. #319's "~102 candidates" does not exist under
the correct config.

## F3 — knip `includeEntryExports` policy → OPEN (needs a decision)

Genuinely not mechanical. Enabling `includeEntryExports: true` globally
surfaces ~725 entry-reachable "unused" exports across 8 packages — the
overwhelming majority legitimate public/app API with no
workspace-internal importer, because `protocol`/`runtime` root barrels
`export *` everything (every symbol is entry-reachable → knip is
structurally blind to dead public exports there).

**Decision required (human, tooling-policy owner):** which packages must
have zero dead *public* exports, and the mechanism — per-package
`includeEntryExports`, `@public`/knip tags for intentional surface, or
`--production` semantics. This is a scoped tooling project, not cleanup.

Regenerate the dataset: set `includeEntryExports: true` in `knip.json`,
`pnpm knip --reporter json`. Bucketing in
`docs/research/legacy-cleanup-pass-2026-05-17.md` (231 runtime, 161
protocol, 102 factory, 96 host-sdk, 61 client-sdk, 57 e-d-streams, 15
e-d-operators, 2 cli).

## F4 — runtime root-barrel redundant duals → OPEN (blocked)

`packages/runtime/src/index.ts` re-exports 5 symbol groups that are also
canonical subpaths (`./control-plane`, `./runtime-output`,
`./durable-tools`, `./codecs`, `./agent-adapters`). Workspace
consumption is decisively subpath-canonical (bare `@firegrid/runtime` =
4 importers; subpaths = 56).

**Blocked on:** migrating the 4 bare `@firegrid/runtime` importers to
subpaths first; only then can the redundant root duals be removed (a
public-API change needing its own review). The one genuine architectural
question is `verified-webhook-ingest`, exposed **only** via the root
barrel with no subpath — promote to a `./verified-webhook-ingest`
subpath (intended public API) or internalize (root leak). Matches
finding F2 of the package-boundary verification note
(`firegrid-package-boundary-verification-2026-05-17.md`); decide there,
not here.

## Maintenance

When F3 or F4 lands, flip its row to **RESOLVED** with the PR link and
keep the rationale. When all four are closed, this tracker and its
parent (`legacy-cleanup-pass-2026-05-17.md`) can be archived together.
