# tf-uc8u — closing the test-only / dead production-export leak: findings

**Status:** additive detection only. No existing gate weakened; nothing auto-deleted.
**Artifacts (machine-generated, re-run with `pnpm gate:test-only-exports`):**
- `scripts/test-only-export-gate.ts` — the detector (deterministic; `--strict` and `--json` flags).
- `docs/findings/tf-uc8u-test-only-exports.{md,json}` — the committed backlog (every finding, `file:line`).

## The leak

knip (`lint:dead`) cannot flag a **production-source export** (in `packages/<pkg>/src`, non-test) whose only references are test files — or none at all. Two mechanisms hide it:

1. **Test files are entry points** — a production export imported by a test reads as "used."
2. **Public-subpath barrels** — `@firegrid/protocol` exposes ~17 fine-grained subpaths (`./agent-tools`, `./channels/router`, …), each a `export *` barrel, so *every* protocol src export is an "entry export," shielded regardless of who imports it.

`ApprovalCall*` (the tf-nors example) is the degenerate case: re-exported through the `./agent-tools` barrel, imported by **nothing** (prod or test), invisible to knip.

## Why not knip (investigated first, as instructed)

| knip configuration | result |
| --- | --- |
| production-only pass, `includeEntryExports:false` (default; required to respect real public API) | flags **0** — every src export is a barrel entry-export, all shielded |
| same, `includeEntryExports:true` | flags **~387**, including legitimate cross-package public types (`FiregridHostOptions`, …) — massive over-match |

knip's entry-export concept is **binary and file-level**; it cannot express "exported-and-public-shaped but imported by no real (non-test) module." `includeEntryExports` is supported per-workspace, but scoping it to protocol/runtime still floods (387→ those packages have large cross-package public surfaces). So this is an **additive, precise scan** — it does not replace or weaken knip, which keeps doing what it does well.

## The detector

Real import resolution (NOT text grep — a test's local `const Approval = …` must never be confused with the `ApprovalCall*Schema` exports):

- relative imports + `@firegrid/*` package-export subpaths;
- **rename-aware** barrel origin-following (`export { foo as bar } from "x"`);
- **member-precise** namespace handling — `import * as P` credits only the `P.member` accesses actually present, in both value position (`PropertyAccess`) and **type position (`QualifiedName`)**; an opaque whole-namespace use falls back to crediting all;
- **intra-module use** detection (an export used by live code in its own module is not "test-only," even if no other module imports it);
- **value-only gating** — only `const`/`function`/`class`/`enum` exports are gated; types/interfaces are used structurally without an import, so a 0-import count is not evidence of deadness (reported as informational).

Three classes (each with `file:line`):

| class | meaning | count |
| --- | --- | --- |
| **TEST-ONLY** | zero production reference anywhere (not even intra-module); kept alive solely by a test | **30** |
| **TEST-EXPOSED-INTERNAL** | used by live code within its own module, but imported by no other production module — only tests | **43** |
| **DEAD** | no production consumer and no test consumer (incl. obsolete self-contained clusters) | **258** |
| _informational_ | type/interface exports with no import refs (not gated) | 216 |

`ApprovalCall*` (`ApprovalCallRequestSchema`/`ApprovalCallPermissionRequestSchema`/`ApprovalCallOutputSchema`, `protocol/src/agent-tools/schema.ts:785/800/817`) lands in **DEAD** — flagged, as required. ✅

## Validation (against the current tree)

Every TEST-ONLY finding was spot-checked against an exhaustive grep: the only production occurrences are barrel re-exports, comments, and string literals — no real use. Examples confirmed test-only: `mergeWebhookSourceChannels` (0 prod refs), `makeSessionPermissionChannelContract` (the tf-7whh orphan `session.permissions.respond` channel), `decodeLaunchConfig`/`normalizeRuntimeIntent` (only the `launch/index` barrel re-exports them). Real tool schemas (`SleepToolInputSchema`, `SessionNewToolInputSchema`) are correctly **not** flagged (used via `AgentToolSchemas.*`). Output is deterministic.

### Precision catches (the prior burn was over-matching — these were fixed before shipping)
- **Renamed re-exports** were falsely flagging the renamed origin → fixed (follow `as`).
- **Type-position namespace access** (`import type * as NS` + `NS.Foo`) is a `QualifiedName`, not a `PropertyAccess` — it was making the namespace look "opaque" and crediting **all** exports (this is what hid `ApprovalCall*` initially) → fixed.
- **Intra-module use** (`makeHostStreamPrefix` is used inside `authority.ts` but imported nowhere else) was falsely "test-only" → reclassified TEST-EXPOSED-INTERNAL.
- **Types/interfaces** (216) are excluded from gating — structural usage isn't import-tracked.

## The fork — how to actually close the leak (decision needed)

The **TEST-ONLY** class is precise (zero false "used" — verified) but it is **not all cruft**. Two structurally-identical kinds live there:
- **obsolete cruft** — e.g. `mergeWebhookSourceChannels`, `makeSessionPermissionChannelContract`, the `authority.ts` test-only helpers;
- **barrel-exported public API exercised only by tests** — e.g. `FiregridHost` (re-exported by `@firegrid/host-sdk` for external users), `decodeLaunchConfig`, `resolveMcpServerHeaders` (re-exported by `runtime/src/index.ts`).

Nothing in the code distinguishes these — only intent does. So the gate **cannot auto-fail** without false-positiving on public API. It is therefore **report-only** today (`pnpm gate:test-only-exports`, exit 0 — **preflight stays green**, knip unchanged). `--strict` (exit 1 on any TEST-ONLY) exists but is **not wired into preflight**.

**To make it enforcing (truly close the leak), a policy decision is needed** — I did not make it unilaterally (FLAG, not delete; surface forks):
1. Triage the 30 TEST-ONLY into `cruft → delete` vs `intended public API`.
2. Either (a) move genuinely-public symbols behind a small curated allowlist (or a `@public` JSDoc tag the scan can read), then wire `--strict` into preflight as a ratchet — new un-allowlisted TEST-ONLY exports fail; or (b) keep it report-only and review the backlog periodically.

Recommended: (a) — it converts a one-time cleanup into a standing gate. The allowlist is a precise `file:line`+name list (not a heuristic baseline), shrinking as cruft is removed.
