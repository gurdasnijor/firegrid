# Shape C Cutover Operating Plan

Doc-Class: internal-contract
Status: active
Date: 2026-05-22
Owner: Firegrid Architecture

Branch: `rearch/shape-c-cutover`

This document operationalizes the greenfield Shape C cutover. It is the branch
level contract for lane dispatch, integration, and the remaining waves after
the current cutover branch lands.

The governing frame is greenfield: Firegrid has no production users or durable
user contexts to preserve. The branch is therefore a replacement branch, not a
compatibility migration. Do not add bridge layers whose purpose is to keep the
old RuntimeContext shape alive while the new one is being built.

## Wave 1: One Replacement Merge

Wave 1 is the active `rearch/shape-c-cutover` branch. It lands as one coherent
greenfield replacement to `main`.

Wave 1 must not partially merge. Wave 2 does not begin from sidecar branches,
proof branches, or a "mostly merged" main. The first Wave 2 precondition is:

```text
main contains the full Shape C cutover branch, green.
```

The Wave 1 branch succeeds when:

- `RuntimeContextWorkflowNative` no longer represents the lifetime of a
  RuntimeContext entity;
- RuntimeContext input delivery no longer uses a per-sequence
  `DurableDeferred` mailbox;
- RuntimeContext state transitions no longer scan dense raw output for
  progress;
- child/delegated output observation uses existing channel/router surfaces;
- Shape C subscribers do not require workflow machinery in their `R` channel;
- Shape D subscribers are narrow and justified by a concrete workflow
  capability;
- the line/module delta against
  `docs/architecture/2026-05-22-shape-c-cutover-baseline.md` is negative, or
  any positive movement names the target-shaped capability it adds.

## Wave 2: Runtime Proof And Deletion

Wave 2 starts only after Wave 1 is merged to `main`.

Wave 2 is not a hardening wave that carries the old path forward. Each lane
proves one runtime behavior end-to-end through the new shape and deletes the
old code that behavior makes unreachable in the same PR.

Wave 2 success criterion:

```text
a real runtime turn works end-to-end through the new shape without fallbacks
```

Stop condition:

If a Wave 2 test needs special-casing, a substrate mock that bypasses the real
composition, or a skipped lifecycle step to pass, the lane stops and reports
the architecture gap. Tests must expose integration gaps, not paper over them.

Expected Wave 2 lanes:

- start context -> send input -> observe output -> terminate; delete the old
  RuntimeContext lifecycle path this proves unreachable;
- tool call -> durable result correlation -> continuation; delete obsolete
  tool bridge/wrapper code;
- permission request -> permission response -> continuation; delete obsolete
  mailbox/response bridge code;
- wait/channel observation -> child output through existing router; delete
  parallel observation or request/response artifacts;
- restart/reload -> no double processing; delete replay/cursor scaffolding no
  longer used by RuntimeContext state.

## Wave 3: Final Sweep Only

Surface deletion is not a separate migration wave. It is part of Wave 2.

Wave 3 is a final audit sweep for residue missed by Wave 2:

- no `_archive/` runtime files remain;
- no old RuntimeContext workflow path remains reachable;
- no SDD or architecture doc describes bridge machinery as target
  architecture;
- no stale beads remain open for write+arm, cursor, mailbox, or parallel
  child-output protocol shapes;
- the final line/module delta is recorded.

If Wave 3 finds major runtime deletion work, Wave 2 missed its contract.

## Wave 4: Enforcement Runs With Wave 2

Architecture enforcement does not wait for a later cleanup wave. `tf-zchu`
guardrails are already active, and additional guards land with the behavior
they protect.

When a Wave 2 lane proves an invariant, it also adds or updates the guard that
keeps that invariant true:

- no Shape C `WorkflowEngine` requirement;
- no cross-event `DurableDeferred` mailbox;
- no dense RuntimeContext output scan;
- no `session_read` / `ChildOutput*` parallel protocol family;
- transform modules stay pure;
- baseline ratchet prevents runtime surface growth without explicit
  justification.

Wave 4 is therefore a parallel enforcement thread plus a final CI audit, not a
future permission slip to drift after Wave 2.

## Wave 5 Entry Gate

Product feature work starts only after all of these are true:

- Shape C cutover is on `main`;
- one production agent turn runs through the new shape under load;
- no fallback path to the old RuntimeContext workflow remains;
- no `_archive/` runtime files remain;
- all architecture guards are active;
- cumulative runtime line/module delta is negative;
- `pnpm run verify` passes.

Until this gate passes, work that looks like feature work is architecture
completion work.

## Operating Rules For Lanes

- Use `origin/rearch/shape-c-cutover` as the base for Wave 1 sidecar work.
- Keep write surfaces narrow and disjoint; coordinate through type boundaries,
  not bridge adapters.
- Do not wait on proof PR CI before making production progress unless the proof
  itself invalidates the current slice.
- A dedicated shepherd lane owns proof PR cleanup and merge.
- A dedicated integration owner may merge/rebase sidecar branches, run the
  branch verification loop, and maintain the line-count report.
- Greenfield deletion is allowed and expected. If deleting a wrong-shape module
  exposes a missing target capability, build the target capability directly.
