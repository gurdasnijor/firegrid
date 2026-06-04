# Handoff Correction — OCA review pass (2026-05-21)

Date: 2026-05-21
Repo state: `origin/main` at `2e62c7f8d`
Corrects: `02-GARY_ARCHITECTURE_ASSESSMENT.md` + `02b-COMPANION_ARCHITECTURE_ASSESSMENT.md`
(both assessed `7ecaa9102`, since superseded by the interim convergence wave).

This is a timestamped delta/amendment, not a re-assessment. 02 and 02b remain
the historical baseline assessed at `7ecaa9102`; the facts below have moved
since they were written.

## 1. Substrate debt scoreboard: now 4 files, not 8

`currentHostSdkSubstrateDebt` in `.dependency-cruiser.cjs` is down to four:

- `packages/host-sdk/src/host/internal/runtime-context-helpers.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-core.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts`
- `packages/host-sdk/src/host/session-log-channel.ts`

Cleared since the 02 assessment: `tool-use-to-effect.ts`, `toolkit-layer.ts`,
`control-request-reconciler.ts`, `runtime-input-deferred.ts`. The remaining four
are the runtime-context workflow spine plus the session-log channel schema.

## 2. STALE: the 02b host-sdk barrel-leak finding no longer holds

02b (Refinement 2, Finding 2, Gate A) flagged that host-sdk barrels still
exported `hostProjectionObserver`, `*EngineLive`, `*ReconcilerDaemonLive`,
`*Observation`, `CallerOwnedFactStreams`, codec-adapter helpers, etc. as public
surface.

On current main those are **gone** from the host-sdk public barrels
(`packages/host-sdk/src/index.ts`, `src/host/index.ts` — verified clean). The
interim convergence wave closed this; it was not #589. The surface-hygiene
number has moved up accordingly. Re-baseline before citing 02b's barrel-export
debt as open work.

## 3. Transport axis is now in scope (not covered by 02/02b)

Work has moved past pure carveout-ratcheting into the host-plane transport/router
layer that Phase 2 anticipated:

- **ACP host-edge transport** — spike landed (#586, `tf-5n1z.1`).
- **Host-Plane Channel Router SDD** — `docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md`
  (#590, `tf-rd3d`): protocol owns route contracts, runtime/kernel owns route
  implementations, host-sdk composes `FiregridHostChannelRouterLive` + edges.
- **Egress-receipt prompt routing** — `tf-fyyk` (prompts routed through egress receipts).

## 4. tf-9x11 is the keystone that makes the remaining host-sdk cleanup mechanical

`#589` (`tf-bffo`, merged `2e62c7f8d`) narrowed the runtime root barrel (12 kernel
internals removed, enforced by `packages/runtime/test/public-surface-boundary.test.ts`)
and relocated durable-state wiring into `@firegrid/runtime/channels` +
`/per-context-output`. It is an honest **partial** ratchet: `HostControlChannelsLive`
(`packages/host-sdk/src/host/channels/host-control/index.ts`) still binds
`RuntimeControlPlaneTable` to construct the request-row channel lives, and is
declared as an explicit bridge to **tf-9x11** (with `tf-77ab` for the session-self
checkpoint reads + `RuntimeAgentOutputAfterEvents` reach-past).

tf-9x11 (router end-to-end, replacing `HostControlChannelsLive`) is the keystone:
once the durable route bodies live below the host-sdk line, the remaining
host-sdk durable references collapse and the rest of the boundary cleanup becomes
mechanical relocation rather than design work.

## 5. Review-pass dispositions (2026-05-21)

- **#589 / tf-bffo** — MERGE-READY → merged `2e62c7f8d`. Clean transactional cutover;
  no overclaim.
- **#587 / tf-1r3h** — MERGE-READY. Durable sync/async production closure: all four
  session-dependent writes now share a bounded reflected-context barrier
  (`awaitSessionDependentContext`) that fails `ContextNotFound` on absent ids
  instead of hanging. `session.whenReady` deferred (Class D, `tf-2osu`).
  Recommendation carried to tf-2osu: close the unknown-id hang on `whenReady`
  via an existence floor (unbounded readiness wait only for contexts that exist),
  rather than treating it purely as deprecate-vs-remove cleanup.
- **#588 / tf-1fcd** — REQUEST CHANGES → closed for replan. The live coordination-topology
  sim computed its GREEN verdict in a bespoke driver-side evidence harness
  (`validateLiveEvidence`) instead of deriving it from native firelab
  artifacts (durable channel rows / trace spans); scripted-JSON prompts also made
  GREEN near-tautological. Host substrate + public-surface driver were keeper-quality.
