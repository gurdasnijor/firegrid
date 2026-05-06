# CA1 Firegrid/Firepixel Handoff

Date: 2026-05-06
Owner: CA1 implementation handoff
Scope: Firegrid and Firepixel implementation context for the next wave

## Summary

CA1 covered the Firegrid public-boundary, package-consumption, Lab, and Firepixel package-bridge lanes that made packed Firegrid artifacts usable from downstream product repos. The important outcome is that downstream smokes now exercise public package surfaces rather than Firegrid source paths or kernel/control-plane helpers.

Use `coordinator-handoff.md` in this folder as the source for the final multi-repo closeout baseline. This file records CA1-specific implementation details and advice.

## Firegrid Context

Recent CA1 Firegrid lanes included:

- R remediation lanes: state-machine cleanup, public package surface containment, typed Effect error/service consistency, workspace app/package layout, package rename cutover, strict static baseline, and runtime context/test discipline follow-ups.
- Runtime/process lanes: schema-derived CLI emitters, receiver scenario proof, declarative scenario row contract, RunWait primitive boundary, RunWait result surface, EventPlane public boundary, runtime composition docs/helper, and EventPlane projection-match wake capability.
- Lab lanes: app-local `LabClient` seam, shell production-client readiness, seam adoption of `FiregridClient`, and a typed operation workbench while keeping React components behind the lab-local boundary.
- Package lanes: PKG1 client package consumption, PKG2 runtime package consumption, PKG2A NodeNext runtime pack-smoke hardening, and PKG2B expanded forbidden-token guard.

Firegrid public surfaces that downstream work should prefer:

- `@firegrid/client` root for `FiregridClient`, `FiregridClientLive`, `Operation`, public operation state observation, `send`, `result`, and EventStream client behavior.
- `@firegrid/runtime` root for `run`, `Firegrid.handler`, `Firegrid.eventStream`, `Firegrid.subscribers.*`, and `Firegrid.composeRuntime`.
- `@firegrid/substrate` root for app-facing descriptor and wait primitives such as `Operation`, `EventStream`, `RunWait`, `ProjectionMatchTrigger`, and `triggerMatchersLayer`.
- `@firegrid/substrate/event-plane` for app-owned EventPlane definitions, producer/projection services, and layers.

Do not use `@firegrid/substrate/kernel` from app-owned examples or downstream smokes. If a next lane appears to need it, that is a Firegrid public API gap, not a reason to import the kernel.

## Firepixel Context

Recent CA1 Firepixel lanes proved package consumption from Firepixel without adding `@firegrid/*` dependencies to Firepixel manifests:

- FPX2: documented the honest dependency placement path and added a client package-consumption smoke from packed Firegrid artifacts.
- FPX3: proved packed `@firegrid/runtime` type consumption from Firepixel.
- FPX4: proved one simple end-to-end terminalization path: `client.send` to app-owned runtime handler to `client.result`.
- FPX5 and FPX5A: proved permission/wait terminalization through Firepixel-owned EventPlane rows, `RunWait`, projection-match subscriber, and a public `Pending` observation gate before writing approval.
- FPX6: added rejected permission decision parity, mapping rejected decisions to the operation typed error channel.
- FPX7: added bounded tool request/result terminalization with smoke-local EventPlane schemas, public `Pending` observation, completed result to typed output, and failed result to typed error.

The Firepixel package-consumption smokes intentionally use temporary external consumers. They clone/pin Firegrid, pack `@firegrid/substrate`, `@firegrid/client`, and `@firegrid/runtime`, install the tarballs into a temp project, typecheck, then run the product-loop smoke. That is the correct posture until Firegrid has a declared package publication channel.

## Checks And Evidence

Typical local targeted checks used for CA1 package/smoke lanes:

- `pnpm install --frozen-lockfile`
- repo typecheck when relevant, usually `pnpm typecheck` in Firepixel or targeted package typecheck in Firegrid
- target smoke script, for example `pnpm run test:pack:runtime`, `pnpm test:firegrid-permission-wait-terminalization`, or `pnpm test:firegrid-tool-result-terminalization`
- `node --check <script>`
- targeted ESLint for changed scripts where available
- `pnpm run check:specs` and `pnpm run check:docs` when Firegrid specs/docs were touched
- YAML parse for Firepixel feature specs when Firepixel specs were touched
- `git diff --check`

CI was treated as authoritative before review routing. PRs were routed only after CI was green and merge state was CLEAN.

## Worktree Cleanup Status

CA1 completed and cleaned up the assigned Firegrid/Firepixel worktrees after coordinator merge confirmation. Recently confirmed cleanups included:

- `/Users/gnijor/gurdasnijor/firegrid/.worktrees/pkg2a-runtime-pack-smoke-hardening`
- `/Users/gnijor/gurdasnijor/firegrid/.worktrees/pkg2b-runtime-pack-smoke-expanded-token-guard`
- `/Users/gnijor/gurdasnijor/firepixel-worktrees/fpx6-denial-and-tool-parity-smoke`
- `/Users/gnijor/gurdasnijor/firepixel-worktrees/fpx7-tool-result-terminalization-smoke`

Local branch deletion sometimes warned that the primary checkout had not fast-forwarded to the merge commit. That was expected and not a cleanup blocker because the branches had merged upstream.

The Firegrid primary checkout was locally divergent when this handoff was written, and `docs/handoffs/` was already untracked. Do not use the primary checkout as an implementation base. Start new work from fresh `origin/main` worktrees.

## Guardrails To Preserve

Package consumption:

- No local sibling Firegrid path dependencies in downstream manifests.
- No `workspace:` dependencies in external consumers.
- No checked-in tarballs or generated Firegrid package artifacts.
- No unpublished npm assumption until a release channel is explicitly specified.
- Keep temp consumers isolated and disposable.

Authority boundaries:

- No direct `durable.run` terminal row authorship from app/downstream code.
- No fake terminal state.
- No `@firegrid/substrate/kernel` in app-owned examples, scenarios, or downstream smokes.
- No `Choreography`, `DurableWaitsLive`, or raw completion/run/control-plane helpers in app-facing code.
- Handler returns and typed `Effect.fail` are the operation terminalization path.
- External decisions and tool results should be app-owned EventPlane rows emitted through public producers.
- Use public `client.observe(...)->Pending` as the current pre-decision/pre-result gate.

Expanded forbidden-token list used in recent package-consumption guards:

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

Product-scope boundaries:

- Do not introduce provider lifecycle, browser UI, broad tool registry, retry/cancellation, credential, or transport policy unless a lane explicitly specs that behavior.
- Keep smoke-local schemas smoke-local unless the task is explicitly to design reusable Firepixel/Fireline product APIs.
- Do not push Firepixel or Fireline product semantics into Firegrid.

## Next-Wave Surface-Hardening Advice

High-value Firegrid hardening lanes:

1. Public export audit.
   Re-run a source-level and packed-artifact review of `@firegrid/client`, `@firegrid/runtime`, `@firegrid/substrate`, and `@firegrid/substrate/event-plane`. Make sure the curated roots teach only app-facing concepts and that approved subpaths are documented.

2. Packed artifact parity.
   Keep the Firegrid pack smokes aligned with downstream Firepixel/Fireline smokes. If downstream smokes add a guard token or NodeNext behavior, backport that to Firegrid first.

3. Operation observation semantics.
   Downstream flows currently use `Pending` as the public pre-external-write gate. If a product needs a stricter distinction between started, blocked, waiting, or resumed, add a Firegrid spec/API lane rather than reading substrate rows.

4. Guard sharing.
   The expanded forbidden-token list is now repeated across repo-local smokes. A shared local helper inside each repo may be reasonable, but do not create a cross-repo utility package until there is a release-channel story.

5. Publication readiness.
   Current proof is packed local artifacts, not npm publication. Treat registry publication as a separate spec and release-management lane.

## Flamecast-Agents Advice

For `https://github.com/smithery-ai/flamecast-agents`, start read-only:

1. Inspect whether Flamecast exposes a public TypeScript runtime API, only CLI surfaces, or provider/transport internals.
2. Identify the smallest public seam that can be represented as a Firegrid `Operation`, EventStream, or EventPlane row family.
3. Start with a package-consumption smoke using packed Firegrid artifacts and a temp external consumer.
4. Use smoke-local descriptors/schemas first. Do not import Flamecast internals unless that repo documents them as public.
5. If a real integration requires provider lifecycle, credentials, process supervision, registry discovery, or browser UI, stop and write the missing-contract report.

Acceptable first Flamecast proof shapes:

- One operation with typed output/error through `@firegrid/client` and `@firegrid/runtime`.
- One app-owned EventPlane wait path using `RunWait`, `projectionMatch`, and public `Pending` observation before writing the external result row.
- One EventStream replay/materialization path if Flamecast has simple event-like output.

Avoid:

- Firegrid dev launchers.
- Dynamic runtime module loading.
- Kernel imports.
- Direct terminal row appends.
- Product-specific provider orchestration hidden inside Firegrid.

## Standby Posture

CA1 is idle after this handoff. For the next implementation lane:

- Dispatch an explicit repo, branch, and worktree path.
- Start from fresh `origin/main`.
- Use Acai specs first for behavior changes.
- Route review after CI green and CLEAN merge state.
- Keep the worktree until coordinator merge confirmation, then clean it up and report completion.
