# Legacy cleanup pass — post-migration sweep

Date: 2026-05-17
Type: findings note (mechanical cleanup; no architectural commitments)
Branch: `codex/legacy-cleanup-pass`
Migrations swept after: PR #315 (per-context engine), reconcile.ts deletion
(#316), the `authority.ts` streamPrefix doc correction.

## Headline

The recent migration PRs were **thorough in production code**. The
deleted-symbol surface (`appendRuntimeIngressToOwner`,
`RuntimeContextWorkflowLayer`, `runRuntimeContext`, `ScheduledInputWorkflow*`,
`appendScheduledPrompt`, `hostOwnedWorkflowEngineLayer`) has **zero**
remaining references anywhere in `packages/**` or `apps/**` — production *or*
test. What survived was almost entirely **comments/docstrings** and one
**tooling-config blind spot**, not dead code.

The single substantive finding is a tooling gap, not legacy code: **knip was
not analyzing `host-sdk`, `client-sdk`, `effect-durable-operators`, or
`apps/factory` at all** (absent from `knip.json` `workspaces`), so their
imports never counted as usage and no tool could see dead public-API exports
hidden behind `export *` barrels. Fixed for the three libraries; `apps/factory`
deferred (Next.js-app config concern).

## What was cleaned up (in the PR)

### Cat 1 — stale comments/docstrings (2 edits)
- `packages/host-sdk/src/index.ts`: barrel comment listed
  "scheduled-input workflow" as a component of the `execution` subpath;
  `ScheduledInputWorkflow` was deleted in #315. Replaced with "toolkit
  handler Layer" (matches `execution/index.ts`'s own docstring + actual
  exports).
- `packages/host-sdk/test/host/two-host-isolation.test.ts`: a `//` comment
  asserted "no workflow row appears in host B's host-owned workflow stream";
  the host-owned workflow stream was deleted in #315. Reworded to "no
  workflow execution occurs" (test behavior unchanged; assertion intent
  identical).

### Cat 4 — dependency-cruiser carve-out (1 edit)
- `.dependency-cruiser.cjs` `no-circular` rule carried a `from.pathNot`
  exception for `packages/runtime/src/durable-launch/(launcher|resources/secrets).ts`.
  That directory is **gone** (deleted in earlier path-x work). Removed the
  carve-out and the stale "tracer 001 removes that path" comment; the rule is
  now a clean global `no-circular`. `pnpm lint:deps` passes (143 modules / 320
  deps, no violations). No other `pathNot` in the file references a deleted
  directory (lines 32/47/105/192/238/262 all target live paths).

### Tooling — knip workspace coverage (1 config edit)
- `knip.json` `workspaces` omitted `packages/host-sdk`,
  `packages/client-sdk`, `packages/effect-durable-operators`,
  `apps/factory`. Added the **three libraries** (entry = their
  `package.json` `exports` points, `project = src/**/*.ts`, mirroring the
  existing `cli`/`protocol`/`runtime` convention). Result: knip still reports
  **0 issues**, baseline stays `0` (no rot), and cross-package imports of
  `protocol`/`runtime` from those libraries now count as usage. `apps/factory`
  was **not** added — see findings.

## Candidates found but NOT cleaned up (with reasoning)

### `RuntimeIngressTable` — dead, but out of scope
`packages/protocol/src/runtime-ingress/schema.ts` exports the
`RuntimeIngressTable` class + `RuntimeIngressTableService` type. **Zero
consumers** anywhere in the workspace (the only same-file use is the
*type alias* at `schema.ts:214`, not the class). The dispatch's premise
that it "was deleted in #309" is **factually wrong** — it was never
deleted. Not acted on: protocol exported-schema changes are explicitly
out of scope for this pass, and removing it is a public-API change for
`@firegrid/protocol` needing its own review. **Recommended:** delete in a
protocol-scoped follow-up (it is genuinely dead).

### Why knip never flagged `RuntimeIngressTable` (root-cause finding)
Three compounding causes:
1. It is re-exported up to protocol's knip entry (`src/index.ts:4`
   `export * as RuntimeIngress from "./runtime-ingress/index.ts"` →
   `export * from "./schema.ts"`), and `./runtime-ingress` is a declared
   `exports` subpath. knip treats entry-reachable exports as the public
   contract and does not report them as unused in default mode.
2. knip runs default mode (`pnpm knip --reporter json`), not
   `--production` / `--include exports` / `includeEntryExports`.
3. `.knip-baseline.json` is empty — nothing suppressed; this is structural
   classification, not baseline rot.
The deeper truth: `protocol`/`runtime` root barrels `export *` /
`export * as` everything, making **every** symbol entry-reachable, so
knip is structurally blind to dead public-API exports there.

### The `includeEntryExports` experiment — 725 candidates (deferred)
Enabling `includeEntryExports: true` globally surfaced **725** "unused"
entry-reachable exports across 8 packages (231 runtime, 161 protocol, 102
factory, 96 host-sdk, 61 client-sdk, 57 e-d-streams, 15 e-d-operators, 2
cli). The overwhelming majority are **legitimate public/app API with no
workspace-internal importer**, not dead code. Reverted. Catching real dead
public exports requires a per-package policy decision (which packages must
have zero dead public exports, `@public`/knip tags for intentional surface,
or `--production` semantics) — a scoped tooling project, **not** mechanical
cleanup. The 725 bucketed dataset is the input artifact for that future
work (regenerable: set `includeEntryExports: true`, `pnpm knip`).

### `apps/factory` knip coverage — separate Next.js-config concern
Adding `apps/factory` as a knip workspace surfaced (a) 7 "unused
dependencies" that are all **false positives** — `tailwindcss` /
`tw-animate-css` consumed via CSS `@import` in `app/globals.css` +
PostCSS; the five shadcn JS deps (`@radix-ui/react-slot`/`-tabs`,
`class-variance-authority`, `clsx`, `tailwind-merge`) used throughout
`apps/factory/components/ui/*.tsx`, `lib/utils.ts`, `app/page.tsx` — and
(b) ~102 factory-internal "unused export" candidates from its `src/`
barrel. Root cause: factory's UI lives in `app/`,`components/`,`lib/`
(0 `.tsx` in `src/`), which a `src/**` glob can't see; correct fix needs
a Next.js-aware knip config + `ignoreDependencies` for CSS-only build
deps. This is app-owner territory and judgment-heavy; **deferred** rather
than mass-edit factory's manifest or barrel. Recommended follow-up:
factory-scoped knip config (`{app,components,lib,src}` project + Next
entries + ignore CSS deps), then triage the ~102 internal candidates.

### `makeHostStreamPrefix` — live, not a legacy fixture
14 references across host-sdk tests. The dispatch flagged it as a possible
legacy workflow-URL helper. It is **live**: per the `authority.ts:550-561`
doc correction, `streamPrefix` is output-stream addressing only (not
prompt/workflow routing). It is current infrastructure with many
consumers. No action.

### `docs/proposals/**` + `docs/architecture/**` — ~95 stale references
~95 hits for deleted symbols (`ScheduledInputWorkflow`,
`RuntimeIngressTable`, `RuntimeContextWorkflow`, etc.) live in design
proposals and architecture docs. Treated like `docs/research/` and
`docs/sdds/` (53 + 67 hits, also left): these are **historical design
records**, not current code documentation. Rewriting them is judgment-heavy
and out of mechanical scope. Flagged for awareness; not acted on.

## Cat 2 — unused imports/exports: nothing actionable

`pnpm typecheck` (16/16) and `pnpm lint` (eslint `--max-warnings 0`) are
green on `main`, so unused imports cannot exist in committed code. knip
(now with corrected library coverage) reports **0** dead exports.
`durable-tools/index.ts` (which lost `DurableWaitCompletionRows` in #316)
is clean. There is no Cat-2 debt; the gates already enforce it. The only
export-hygiene gap was knip's *coverage blindness*, addressed above.

## Cat 3 — dead test fixtures: none

Precise per-symbol grep: `ScheduledInputWorkflowLayer`,
`RuntimeContextWorkflowLayer`, `appendScheduledPrompt`, `runRuntimeContext`,
`hostOwnedWorkflowEngineLayer`, `appendRuntimeIngressToOwner` → **0 files
each**. The migration PRs deleted their test fixtures with the production
code. No mock of a deleted interface survived. `makeHostStreamPrefix` is
live (above).

## Cat 5 — runtime root-barrel audit (audit only, no deletion)

`packages/runtime/package.json` declares 11 `exports` subpaths.
`packages/runtime/src/index.ts` (the `.` entry) re-exports from 10 internal
modules. Consumption reality across the workspace: **bare
`@firegrid/runtime` = 4 importers; subpath `@firegrid/runtime/* = 56`**
(events 15, errors 10, workflow-engine 9, durable-tools 7, control-plane 7,
runtime-output 4, tool-executor 3, codecs 1). Subpaths are decisively
canonical.

Categorization:

| Symbol group (root barrel re-export) | Also a subpath? | Verdict |
| --- | --- | --- |
| `authorities/index.ts` (= `./control-plane`) | yes | **remove from root barrel** — redundant dual; subpath canonical |
| `runtime-output-public.ts` (= `./runtime-output`) | yes | **remove from root barrel** — redundant dual |
| `durable-tools/index.ts` (= `./durable-tools`) | yes | **remove from root barrel** — redundant dual |
| `agent-event-pipeline/codecs/index.ts` (= `./codecs`) | yes | **remove from root barrel** — redundant dual |
| `agent-adapters/index.ts` (= `./agent-adapters`) | yes | **remove from root barrel** — redundant dual |
| `verified-webhook-ingest/index.ts` | **no subpath** | **needs judgment** — exposed only via root; either promote to a `./verified-webhook-ingest` subpath (if intended public API) or it is internal leaking through root |
| `sources/sandbox/secrets.ts`, `…/effect-ai.ts` (deep files) | partial (`./sources/sandbox` → sandbox/index.ts) | **needs judgment** — root re-exports specific deep symbols not necessarily on the subpath barrel |
| `events/output.ts` (deep file) | `./events` → events/index.ts | **needs judgment** — verify the subpath barrel re-exports these symbols; if so, redundant dual |

**Not acted on (per dispatch):** trimming the root barrel is a public-API
change. Prerequisite: migrate the **4 bare `@firegrid/runtime` importers**
to subpaths first, then remove the redundant duals. The `verified-webhook-ingest`
root-only exposure is the one genuinely architectural question (promote vs.
internalize) — handed off, not decided. This matches finding **F2** of the
package-boundary report (`firegrid-package-boundary-verification-2026-05-17.md`).

## Pattern observed

Migration PRs (#315, #316) updated **production code and its tests
completely** — zero dead symbols, zero dead fixtures. What they
underweighted was (a) **barrel/aggregator comments** (host-sdk index
docstring) and (b) **cross-cutting config** (the dep-cruiser carve-out,
knip workspace coverage). The debt that survives a thorough migration is
not in the changed files — it's in the *meta* layer (tooling configs,
aggregator docstrings, design docs) that no single PR owns. The knip
coverage gap is the clearest instance: it silently predates these
migrations and would have hidden any dead public export indefinitely.
