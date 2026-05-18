# SDD: TFIND-031 DurableWait substrate ownership (architectural fork)

Status: draft — FRAMING-GATED. Autonomous work STOPPED here per dispatch
discipline ("if it turns out architectural, stop and SDD + framing-gate").
No further production code until coordinator review + Gurdas signoff.

Parent: TFIND-031 root provision (single-root diagnosis). Branch:
`sidecar/durable-tag-provision`. Verified against `origin/main`
`078a384ec` with #326's curry diff transiently overlaid (the only way
the leaks are observable).

## What is already resolved (contained, NOT part of the fork)

The single-root diagnosis was correct for the **ambient** host tag
family. These are fixed and verified (production src clean for these):

- `client-sdk/src/firegrid.ts` `launch`: `insertLocalRuntimeContext`
  omitted `Effect.provideService(RuntimeControlPlaneTable, control)`
  that the sibling `createOrLoadSession` path already had. `control` is
  in scope (`make`, `const control = yield* RuntimeControlPlaneTable`).
  Pure honest provision; mirrors existing pattern. **Done.**
- Ambient host substrate capture seams (`commands.ts`
  `RuntimeStartCapabilityLive`, `runtime-context-workflow-core.ts`
  `RuntimeContextWorkflowNativeLayer`, `agent-tool-host-live.ts`
  `RuntimeHostAgentToolHostLive`, `toolkit-layer.ts`
  `ToolCallHostEnvironment`): `Effect.context<never>()` → capture the
  genuinely-ambient `HostRuntimeContextExecutionEnv =
  RuntimeControlPlaneTable | RuntimeOutputTable | CurrentHostSession |
  RuntimeHostConfig`. These tags ARE ambiently provided by the canonical
  host layer (`FiregridRuntimeHostLive` via `namespaceScopedLayer` +
  `hostOwnedOutputLayer` + `currentHostSessionLayer`). **Done.**

## The fork — `DurableWait*` substrate ownership

After the contained fixes, **3 production seams still leak** the
durable-wait tag family (`DurableWaitRowLookup`, `DurableWaitRowUpsert`,
`DurableWaitCompletionRowLookup`, `DurableWaitCompletionRowUpsert`):

- `toolkit-layer.ts:215` (tool handlers)
- `agent-tool-host-live.ts:90` (spawnChildContext → child workflow)
- `commands.ts:163` (RuntimeStartCapability → workflow)

Root: these deferred effects genuinely require the 4 `DurableWait*`
tags, but those tags are **neither**:

1. ambiently provided by the canonical public host layer
   `FiregridRuntimeHostWithWorkflowLive` (deliberately — they are
   execution-scoped, materialized per-run via
   `runtimeContextWorkflowSupportLayer` →
   `HostRuntimeObservationSubstrateLive` /
   `HostOwnedDurableToolsWaitForLive`), **nor**
2. fully discharged at the type level by the
   `runtimeContextWorkflowSupportLayer` provide that already wraps
   `executeRuntimeContextWorkflow*` at these seams.

The `any` from `DurableTable.layer` collapsed this entire channel, so
the gap was invisible. With precise `.layer` typing it is real and must
be resolved one of two architecturally-different ways.

### Option X — ambient: host layer owns the durable-wait substrate

Widen `HostRuntimeContextExecutionEnv` to include the 4 `DurableWait*`
tags and capture them ambiently (the originally-attempted broad env).

- Effect: pushes `DurableWait*` into the **RIn of the public exported
  layer** `FiregridRuntimeHostWithWorkflowLive` (host-sdk public API,
  `index.ts:50`). Every consumer — including the 8 host-sdk test files
  and any external caller — must now ambiently provide the durable-wait
  store.
- This is a **public host-composition contract change**: the host layer
  would assert it requires (and callers must provide) the durable-wait
  substrate ambiently, contradicting the current design where it is
  execution-scoped. Rejected unless Gurdas explicitly re-frames the host
  substrate lifecycle.

### Option Y — execution-scoped: support layer self-contains it (recommended)

`DurableWaitStoreLive` exists
(`runtime/src/durable-tools/internal/durable-wait-store.ts:88`,
`Layer.mergeAll` of all 4 tags). Merge it into
`runtimeContextWorkflowSupportLayer` (or
`HostRuntimeObservationSubstrateLive`) so the deferred workflow effects'
`DurableWait*` requirements are discharged **execution-scoped**, where
they are already conceptually owned. The public
`FiregridRuntimeHostWithWorkflowLive` contract is **unchanged**; the 8
test files need no new ambient provision.

- No public boundary change. Smallest blast radius. Matches the existing
  "execution-scoped substrate" design intent.
- **Framing subtlety requiring signoff:** `HostOwnedDurableToolsWaitForLive`
  already builds a host-owned durable-tools wait stream
  (`DurableToolsWaitForLive` over the host-owned `durableTools`
  segment). Adding `DurableWaitStoreLive` must NOT introduce a *second,
  divergent* materialized wait store: the wait-router that wakes
  suspended workflow deferreds and the store that records waits must be
  the **same materialized instance**, or a wait is recorded in one store
  and never observed by the router (silent hang, not a type error).
  Whether `DurableWaitStoreLive` and the host-owned wait stream are
  already the same instance — or must be unified — is the architectural
  question. This is precisely the emit-then-wait correctness bar:
  observation must wake on the caller-owned collection.

## Recommendation

**Option Y**, conditioned on resolving the store-instance-sharing
question. Concretely the framing decision needed from Gurdas:

> Is the durable-wait substrate execution-scoped (owned by the
> per-context workflow support layer) or an ambient host capability? If
> execution-scoped (recommended, matches current design), confirm that
> `DurableWaitStoreLive` and `HostOwnedDurableToolsWaitForLive` resolve
> to one shared materialized wait store so router/recorder cannot
> diverge.

## Verification strategy (once framing signed off)

- Re-apply #326 curry transiently; production src must be 0 errors.
- Test fallout then re-triaged per the existing Cat A/B/C buckets:
  - Cat A (TS2352, `as Layer<never>` masks: `WaitFor.test.ts`,
    `tool-use-to-effect.test.ts`, `runtime-observation-sources.test.ts`)
    — remove the now-false casts.
  - Cat B (TS2379, ~35 across 7 files via
    `FiregridRuntimeHostWithWorkflowLive`) — resolved by Option Y with
    NO test edits if the support layer self-contains `DurableWait*`;
    this is the key reason Y is preferred (X would force 8 test edits +
    a public-contract change).
  - Cat C (TS2769, `react-types.test.ts`) — explicit `createElement`
    type args; provider is generic+correct.
- Full `pnpm turbo run typecheck` + `pnpm run lint` + affected suites +
  tiny-firegrid green. macOS: NO `timeout`.

## Status of branch

WIP committed (contained fixes + narrowed `HostRuntimeContextExecutionEnv`
+ this SDD). Intentionally RED at the 3 fork seams — that redness IS the
documented open fork, not a regression. #326 remains untouched/draft.
