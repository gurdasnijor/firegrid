# Next Wave Coordinator Handoff

Date: 2026-05-06
Owner: coordinator/proxy handoff
Scope: Firegrid, Firepixel, Fireline package-bridge closeout and next-wave startup

## Executive Summary

The package-consumption and bridge-proof wave is closed. Firegrid, Firepixel, and Fireline now have merged coverage for packed Firegrid artifacts, external consumers, runtime composition, terminalization, app-owned EventPlane/EventStream flows, public `Pending` gates, and expanded forbidden-token guards.

The next wave should harden the public surface area and begin validating integration with additional agent runtimes, including:

```text
https://github.com/smithery-ai/flamecast-agents
```

Treat external runtime integration as a package-consumption problem first. Inspect public seams before coding. If a candidate runtime requires provider lifecycle, transport credentials, registry discovery, browser UI, or reusable adapter semantics, stop and report the missing public contract rather than inventing broad product behavior.

## Baseline At Closeout

Verified merged evidence:

- Firegrid: PKG1-PKG2C, PRs #100-104, final merge `b46e9e2`.
- Firepixel: FPX2-FPX8, PRs #121-129, final merge `4ba3977`.
- Fireline: FLX1-FLX9, PRs #913-926, final merge `c56de5a`.

Open queues at closeout:

- Firegrid: no open PRs.
- Firepixel: unrelated older #119 and #108.
- Fireline: unrelated older #912.

Local note: this handoff was written from `/Users/gnijor/gurdasnijor/firegrid`. The local `main` checkout was clean but divergent from `origin/main` when the handoff started (`ahead 270, behind 7` after fetch). Do not force-reset or rewrite that checkout without explicit user approval. Use fresh worktrees from the desired base for new implementation lanes.

## What Is Proven

### Firegrid

The Firegrid PKG lane proves:

- `@firegrid/substrate`, `@firegrid/client`, and `@firegrid/runtime` pack built `dist` artifacts rather than workspace-only source entrypoints.
- Workspace source resolution remains a development-only mapping for local lint, typecheck, and tests.
- The client external pack smoke installs packed client and substrate artifacts into a temporary consumer and typechecks public root and event-stream imports.
- The runtime external pack smoke installs packed runtime and substrate artifacts into a temporary NodeNext consumer and typechecks `run`, `Firegrid.handler`, `Firegrid.composeRuntime`, explicit subscriber/provider Layers, `RunWait`, and `EventPlane`.
- The runtime pack smoke asserts the packed `firegrid` binary manifest points at the built artifact.
- Client and runtime package edges remain separated: client smokes do not install runtime, and runtime smokes do not install client.
- Runtime consumer source is guarded against the expanded forbidden-token list before write.

### Firepixel

The Firepixel FPX lane proves:

- Packed Firegrid client/runtime/substrate consumption from Firepixel-owned temp consumers.
- Client-side descriptors and runtime-side composition typecheck through packed artifacts.
- Minimal terminalization through `Firegrid.composeRuntime`, `run`, public `client.send`, and public `client.result`.
- Permission request/decision terminalization through Firepixel-owned EventPlane rows, `RunWait`, `projectionMatch`, and public `client.observe(...)->Pending`.
- Approved decisions terminalize through typed output; rejected decisions terminalize through the typed error channel.
- Tool request/result terminalization through smoke-local Firepixel tool EventPlane schemas.
- Completed tool results terminalize through typed output; failed tool results terminalize through the typed error channel.
- All package-consumption smoke consumers now carry the expanded forbidden-token guard.
- Firepixel SDD coverage rollup is landed.

### Fireline

The Fireline FLX lane proves:

- The bridge smoke consumes packed Firegrid client/runtime/substrate artifacts from a pinned, SHA-checked Firegrid ref.
- Fireline session flow composes a real Firegrid runtime with `Firegrid.composeRuntime` and `run`.
- App-owned EventPlane permission rows cover approval and denial through `RunWait`.
- Public `client.observe(...)->Pending` gates external decision/result row writes.
- App-owned EventStream prompt chunks replay in exact expected order for both prompt-producing sessions.
- App-owned EventPlane tool request/result rows cover tool success and typed tool failure.
- The checked-in bridge smoke source is guarded before execution against the expanded forbidden-token list.
- Fireline README coverage rollup is landed.

## Explicit Deferrals

Do not treat these as silently in scope for the next wave:

- npm publication or release channel validation.
- Reusable adapter packages.
- Provider lifecycle management.
- Browser UI.
- Broad registries or tool discovery.
- Retry, cancellation, credential, or transport policy.
- Product-specific permission/tool semantics beyond smoke-local fixtures.

If a next-wave integration needs one of these, write a blocker report or spec proposal first.

## cmux Roles

Known surfaces from the closeout wave:

| Role | Surface | Typical Ownership |
| --- | --- | --- |
| Proxy/coordinator | `surface:33` | Dispatch, queue status, merge ownership, cleanup tracking |
| CA1 | `surface:37` | Firegrid and Firepixel implementation lanes |
| CA2 | `surface:54` | Backup implementation/context reserve |
| CA3 | `surface:68` | Fireline lanes, Firepixel reports/docs, closeout consolidation |
| OLA/Lead | `surface:66` | Lead reserve and primary review for many Firegrid/Firepixel lanes |
| OCA | `surface:81` | Cross-repo review reserve and primary Fireline review |

## cmux Etiquette

Use concise updates. Every update should state what changed, what remains blocked, and the exact next owner.

Always press Enter after every `cmux send`:

```sh
cmux send --workspace workspace:2 --surface surface:33 "[to-proxy-agent] <message>"
cmux send-key --workspace workspace:2 --surface surface:33 Enter
```

Coordinator updates should use `[to-proxy-agent]`.

Implementation updates should include:

- Lane name.
- Repo.
- Worktree path.
- PR number if opened.
- Head SHA.
- CI state.
- Merge state.
- Local targeted checks.
- Explicit cleanup status after merge.

Review updates should include:

- Verdict first: APPROVED, CHANGES REQUESTED, or BLOCKED.
- Repo, PR number, head SHA.
- Diff scope.
- Blocking findings first.
- Guardrails confirmed.
- Soft observations only after the verdict.

Standing coordination rules:

- Do not route review until CI is green and merge state is CLEAN.
- Reviewers do not merge.
- Coordinator owns merge and cleanup dispatch.
- After merge, assigned implementer removes the worktree and deletes the local branch, then pings cleanup complete.
- When all queued work is complete, keep OLA/OCA as unassigned review reserves rather than dispatching speculative product behavior.

## Engineering Guardrails

Use the repo-local Acai process for behavior changes:

- Specs and feature YAML are the source of truth.
- Add or modify specs before behavior changes.
- Reference complete ACIDs in tests or important code comments.
- Do not renumber ACIDs.
- Run spec/doc checks when specs or docs are touched.

Package-consumption guardrails:

- Use packed artifacts or explicitly report why a public package seam is missing.
- No local sibling dependencies.
- No `workspace:` dependencies in external consumers.
- No checked-in tarballs.
- No unpublished npm assumption unless the lane is explicitly about publication.
- Keep temp consumers isolated and cleaned up.

Forbidden app-code tokens:

- `durable.run`
- `@firegrid/substrate/kernel`
- `Choreography`
- `DurableWaitsLive`
- `WorkProducer`
- `SubstrateProducer`
- `processReadyWorkItem`
- `attemptClaim`
- `completeRun`
- `failRun`
- `blockRun`
- `resolveCompletion`
- `createPendingCompletion`
- `startRun`
- `client.work.declare`
- `FIREGRID_RUNTIME_MODULE`
- `firegrid dev`

Authority guardrails:

- Do not synthesize terminal rows.
- Do not append direct `durable.run` envelopes from app code.
- Handler return values and `Effect.fail` are the legitimate typed terminalization path.
- External decisions/results should be app-owned EventPlane rows emitted through public producers.
- Public `client.observe(...)->Pending` is the current external pre-decision gate. If stricter Started vs Blocked semantics are needed, that is a Firegrid API design lane.

## Next Wave: Surface Area Hardening

Recommended high-ROI lanes:

1. Public surface audit.
   - Re-check root exports for `@firegrid/client`, `@firegrid/runtime`, `@firegrid/substrate`, and approved subpaths.
   - Confirm no runtime-to-client or client-to-runtime package edge can slip through.
   - Confirm browser-safe exports remain browser-safe.

2. Operation state surface hardening.
   - Current public state collapses started/blocked as `Pending`.
   - If integrations need strict blocked-on-wait evidence, propose a spec/API addition rather than reading kernel state.

3. Shared forbidden-token maintenance.
   - Firegrid, Firepixel, and Fireline now share a 17-token guard list.
   - A shared utility may reduce drift, but do not add a cross-repo dependency unless the maintenance benefit is real.

4. Package publication readiness.
   - Current smokes prove packed local artifact consumption, not registry publication.
   - Treat npm publication or release-channel validation as a separate spec lane.

5. Documentation and examples.
   - Keep examples as smoke-local fixtures unless reusable adapter semantics are specified.
   - Add coverage rollup bullets when new lanes land.

## Next Wave: Agent Runtime Integration

Initial target:

```text
https://github.com/smithery-ai/flamecast-agents
```

Start with a read-only feasibility report:

1. Inspect the target repo's public package/runtime seams.
2. Identify whether it exposes TypeScript descriptors, runtime process APIs, CLI-only flows, provider child processes, credential flows, or transport lifecycle.
3. Map only public seams to current Firegrid public surfaces.
4. Propose the smallest smoke that proves one real integration path.
5. Stop with a blocker if the only available path requires provider lifecycle, registry, credentials, browser UI, or dev-launcher behavior.

Acceptable first integration shapes:

- Temp external consumer with packed Firegrid artifacts.
- Smoke-local descriptors and EventPlane/EventStream schemas.
- `DurableStreamTestServer` for local stream infrastructure.
- `Firegrid.composeRuntime` and `run`.
- Public `FiregridClient.send`, `result`, `observe`, and `events`.
- Public `RunWait`, `projectionMatch`, and `EventPlane` layers.
- Typed output/error assertions through `client.result`.

Non-acceptable shortcuts:

- Importing target repo internals without a public seam.
- Using Firegrid kernel/control-plane helpers.
- Direct durable terminal row authorship.
- Starting provider child processes unless provider lifecycle is the explicitly scoped lane.
- Adding credentials or external service dependencies to a smoke.

## Suggested Team Handoff Files

Each role should add one file under this folder:

- CA1: `ca1-firegrid-firepixel-handoff.md`
- CA2: `ca2-backup-context-handoff.md`
- CA3: `ca3-fireline-firepixel-bridge-handoff.md`
- OLA/Lead: `ola-lead-review-handoff.md`
- OCA: `oca-review-handoff.md`

Each team doc should include:

- Role and surface.
- Recent lanes owned or reviewed.
- Current clean/dirty/worktree status.
- Important guardrails.
- Known soft observations.
- Recommended next-wave lanes.
- Stop conditions.
- Exact checks the next agent should run.

## Recommended Checks For This Handoff Folder

For docs-only edits in Firegrid:

```sh
pnpm run check:docs
pnpm run check:specs
git diff --check
```

Do not run `acai push --all` unless the user explicitly asks.
