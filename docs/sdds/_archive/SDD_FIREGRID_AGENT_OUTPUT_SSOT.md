> **HISTORICAL (pre-#765).** References paths deleted in #765 (packages/substrate, packages/host-sdk/src/host, and legacy packages/runtime/src/{subscribers,durable-tools,workflow-engine,agent-event-pipeline,agent-tools,runtime-host,composition}); kept for provenance. Current architecture: docs/cannon/.

# SDD: Agent-Output Event Single Source of Truth

Status: draft — framing for coordinator review + Gurdas signoff, NO code
Created: 2026-05-18
Owner: Firegrid (sidecar `sidecar/agent-output-ssot`)

Resolves: Beads DB (`bv --robot-triage`, join key `tfind:035`) → tracked
dependent of TFIND-030 #329, merged `a7c76c268`.

Completion signal (explicit): removal of the scoped `.jscpd.json` ignore on
`packages/protocol/src/session-facade/agent-output-event.ts`.

Related code (verified on `origin/main` @ `dbe817ea8`):

- `packages/runtime/src/agent-event-pipeline/events/contract.ts` — runtime
  canonical `AgentOutputEventSchema` + part sub-schemas
- `packages/runtime/src/agent-event-pipeline/events/output.ts` — runtime
  decoder (`RuntimeAgentOutputEnvelopeSchema`, `decode/encode`,
  `runtimeAgentOutputObservationFromRow` — lean observation)
- `packages/protocol/src/session-facade/agent-output-event.ts` — the #329
  byte-mirror union (jscpd-ignored debt marker)
- `packages/protocol/src/session-facade/schema.ts` — protocol decoder +
  projection observation (`source`/`sessionId`, strict, projection metadata)

---

## 1. Verified state (the fork is real)

There are **two** agent-output envelope decoders, both now parsing the
*same logical union*:

| | runtime `events/output.ts` | protocol `session-facade/schema.ts` |
|---|---|---|
| union source | `./contract.ts` (canonical, runtime-owned) | `./agent-output-event.ts` (#329 byte-mirror) |
| envelope schema | `RuntimeAgentOutputEnvelopeSchema` | `RuntimeAgentOutputEnvelopeSchema` (same name, dup) |
| decode | `decodeUnknownEither` → typed | `decodeUnknownOption` → typed (TFIND-030) |
| observation shape | lean: `{contextId, activityAttempt, sequence, _tag, event, permissionRequestId?, toolUseId?, toolName?}` | projection: adds `source`, `sessionId`, `RuntimeContextId`-typed `contextId`, `options`, projection metadata, strict `onExcessProperty` |

The duplicated union (`AgentOutputEventSchema` + `AgentTextDeltaPartSchema`,
`AgentToolCallPartSchema`, `StopReasonSchema`, `PermissionOption*Schema`,
`AgentCapabilitiesSchema`) is the jscpd-ignored debt.

**Dependency direction is forced.** `@firegrid/protocol` must not depend on
`@firegrid/runtime` (verified: it does not; runtime depends on protocol —
`output.ts` imports `@firegrid/protocol/launch`). Therefore the canonical
union **must live in `@firegrid/protocol`** and runtime must consume it. This
is not an open question; Q1 below is only *how* runtime adopts it.

## 2. Blast radius (verified importers of the union / part sub-schemas)

Non-test, non-definition importers:

- **runtime codecs/pipeline:** `codecs/acp/index.ts`, `codecs/acp/mapping.ts`,
  `codecs/contract.ts`, `codecs/stdio-jsonl/index.ts`,
  `subscribers/runtime-tool-use-executor.ts`, `events/output.ts`
- **host-sdk:** `agent-tools/execution/tool-use-to-effect.ts`,
  `host/per-context-runtime-output.ts` (uses runtime's lean
  `runtimeAgentOutputObservationFromRow`),
  `host/runtime-context-workflow-core.ts`
- **client-sdk:** `firegrid.ts`, `index.ts` (uses protocol projection)
- **apps/factory:** `src/host.ts`
- **protocol:** `session-facade/schema.ts` (#329)
- **tiny-firegrid:** 4 configs + 2 runtime mirrors (toy; not edited by
  sidecar — its adoption is maintainer-driven, noted)
- barrel: `@firegrid/runtime/events` re-exports `contract.ts` + `output.ts`
  (subpath consumers rely on these names existing)

Back-compat lever: if runtime `contract.ts` / `events/output.ts`
**re-export** the protocol canonical names, every importer above compiles
unchanged. That keeps blast radius at "internals moved, public names stable."

## 3. End-state (the only sound direction)

1. Promote `packages/protocol/src/session-facade/agent-output-event.ts` (or a
   dedicated `@firegrid/protocol` agent-output module/subpath) to the **single
   canonical** `AgentOutputEventSchema` + part sub-schemas.
2. Runtime `agent-event-pipeline/events/contract.ts` **re-exports** those
   names from `@firegrid/protocol` instead of redefining them (delete the
   duplicate definitions). All runtime/codec/host-sdk importers keep their
   current import paths.
3. Collapse to **one envelope decoder** (`RuntimeAgentOutputEnvelopeSchema` +
   `encode`/`decode`). The two *observation* functions are NOT identical
   (lean vs projection) — see Q2.
4. Delete the scoped `.jscpd.json` ignore (completion signal). Duplication
   returns to 0 because the definition is no longer duplicated.

## 4. Narrow framing questions (no code until answered)

- **Q1 — runtime adoption mechanism:**
  (A) **Relocate + runtime re-export** (recommended): canonical in protocol;
  `contract.ts` becomes `export { … } from "@firegrid/protocol/…"`. Smallest
  blast radius, no consumer churn, single PR. Risk: a thin permanent
  re-export shim in runtime.
  (B) **Protocol-canonical + staged consumer migration:** delete runtime
  re-exports, repoint every importer (§2) to `@firegrid/protocol` directly,
  retire the runtime names. True SSOT with no shim; large mechanical diff
  across runtime/host-sdk/factory; higher review surface; sequencing risk
  vs. in-flight codec work.
- **Q2 — decoder/observation collapse depth:** one envelope schema is
  unambiguous. But runtime's lean `RuntimeAgentOutputObservation` (no
  `sessionId`/`source`) and protocol's projection observation are different
  contracts with different consumers (host-sdk per-context vs client-sdk).
  Collapse to one observation type (which? protocol projection is the public
  one — does host-sdk adopt `sessionId`/`source`?), or keep two observation
  *shapes* over one shared envelope decoder? The latter is the smaller,
  safer down-payment and still closes the duplication (the union, not the
  observation, is what jscpd flags).
- **Q3 — module placement & subpath:** does the canonical union belong under
  `@firegrid/protocol/session-facade` (where #329 put it) or a dedicated
  `@firegrid/protocol/agent-output` subpath (cleaner for runtime codecs that
  have no session-facade concern)? Affects the runtime re-export import path
  and `package.json` `exports`.
- **Q4 — `@effect/ai` already a protocol dep** (#329, blessed). Confirm no
  further dep escalation; runtime keeps its own `@effect/ai` dep
  independently.

Recommendation: **end-state §3 via Q1=A + Q2=one envelope decoder, two
observation shapes retained** as the smallest sound down-payment that fully
closes the jscpd debt (removes the duplicated *definition*), with full
observation unification tracked separately if desired. Not pre-committing —
A-vs-B and observation-collapse depth are coordinator/Gurdas calls.

## 5. Verification plan (for the implementation PR, post-signoff)

- `pnpm turbo run typecheck` (all 17) — re-export must not break any importer.
- Full CI gate set locally: `pnpm run lint && pnpm run lint:dead &&
  pnpm run lint:dup && pnpm run lint:deps` — `lint:dup` must pass with the
  `.jscpd.json` ignore **removed** (the completion signal); `lint:deps`
  (depcruise) must show no new boundary violation from runtime→protocol
  re-export.
- `pnpm turbo run test` (all 17) incl. every codec consumer
  (acp/stdio-jsonl), host-sdk per-context, client-sdk projection, factory.
- Confirm via CI (`gh pr checks`) before reporting green — not local alone.

## 6. Adjacent (coordinator → Beads DB, not this PR)

- tiny-firegrid has its own runtime mirrors (`src/runtime/agent-event-pipeline/…`);
  their reconciliation is maintainer/toy-driven, out of sidecar scope.
- Relates to TFIND-040 (client per-event observation) and TFIND-041
  (ToolUse lifecycle) — both consume the typed union; neither is in scope
  here.

## 7. Acceptance gate

This document is the deliverable. No production code until Q1–Q4 are
answered. On signoff the implementation lands on `sidecar/agent-output-ssot`
scoped to the chosen option; the `.jscpd.json` ignore deletion is the
explicit completion signal; Beads DB updates are coordinator-owned.
