# Factory Primitive Surface Gaps Review

Date: 2026-05-15

Scope: PR #256, `apps/factory/**`, current `@firegrid/client/firegrid` and
`@firegrid/runtime` public surfaces.

## Summary

PR #256 leaves factory able to build the core runtime flow from current public
primitives: public client sessions, public runtime host layers, durable source
registration, and protocol-owned runtime observation source names. The remaining
glue in `apps/factory/src/host.ts` is mostly app read-model assembly and
factory product semantics. The one useful public-surface gap is a client-facing
normalized runtime output observation surface so apps do not parse raw runtime
event envelopes.

## What Builds Cleanly Today

- Session lifecycle and ingress are covered by `@firegrid/client/firegrid`.
  Factory creates or loads the planner session, attaches by session id, appends
  the initial prompt, starts the runtime, responds to permissions, and waits for
  permission requests through `FiregridSessionHandle` methods
  (`apps/factory/src/host.ts:220`, `apps/factory/src/host.ts:233`,
  `apps/factory/src/host.ts:311`, `apps/factory/src/host.ts:400`,
  `apps/factory/src/host.ts:557`, `apps/factory/src/host.ts:625`). The public
  client interface exposes those same session methods and snapshot shape in
  `packages/client/src/firegrid.ts:122` and
  `packages/client/src/firegrid.ts:155`.
- Local runtime hosting is covered by current runtime-host exports. Factory
  imports `FiregridLocalHostLive`, `RuntimeStartCapabilityLive`,
  `localProcessSpawnEnvFromHostEnv`, and `RuntimeHostTopologyOptions` from
  `@firegrid/runtime/runtime-host` (`apps/factory/src/host.ts:16`), then
  composes them in `DarkFactoryHostLive` (`apps/factory/src/host.ts:171`). The
  package root also exports these host/config primitives
  (`packages/runtime/src/index.ts:5`).
- App-owned durable facts can be registered as observation read surfaces with
  the existing durable-tools API. Factory registers `darkFactory.facts` with
  `SourceCollections` and `sourceCollectionStreamHandle`
  (`apps/factory/src/host.ts:28`, `apps/factory/src/host.ts:161`), matching the
  public durable-tools exports (`packages/runtime/src/index.ts:106`).
- Runtime observation source names are no longer an app-local compatibility
  re-export. Factory prompt construction now imports
  `FiregridRuntimeObservationSourceNames` from protocol agent tools
  (`apps/factory/src/prompts.ts:1`) and renders those names into planner prompt
  context (`apps/factory/src/prompts.ts:45`).

## Remaining Factory Glue

- `DarkFactoryHostLive` still composes the app table, app source registration,
  local host, client service, and runtime start capability
  (`apps/factory/src/host.ts:171`). This is awkward but not evidence of a
  missing runtime host primitive; the app table and fact source are factory
  concerns.
- `readFactoryRunStatus` builds a factory-specific status view by joining
  factory facts and runs with a client runtime snapshot, sorting runtime rows,
  and deriving permission requests from output rows
  (`apps/factory/src/host.ts:481`). That read model is app-owned, but the raw
  output parsing inside it is the clearest primitive gap.
- `decodeAgentOutputWrapper` and `permissionFromRow` parse `RuntimeEvent.raw`
  JSON envelopes in app code to recover normalized agent output and permission
  requests (`apps/factory/src/host.ts:423`, `apps/factory/src/host.ts:439`).
  Runtime already exports envelope helpers and observation conversion from
  `@firegrid/runtime/events` (`packages/runtime/src/index.ts:141`), but those
  are not surfaced through the browser-safe client snapshot.
- `waitForPermissionRequest` must check existing snapshot rows, then loop
  through `session.wait.forPermissionRequest` in small timeout slices
  (`apps/factory/src/host.ts:585`). The existing client wait primitive is useful
  for one durable permission wait; the extra loop is factory's
  existing-first/status-view behavior.
- `waitForNextAgentOutput` polls the factory status read model for new runtime
  output (`apps/factory/src/host.ts:645`). That would be simpler with a client
  wait/stream primitive for normalized output observations.
- `respondToFactoryPermission` coordinates an app fact write, the client
  permission response, a snapshot lookup for the response input row, and a
  factory run status update (`apps/factory/src/host.ts:521`). The Firegrid
  permission response itself is public and sufficient; the surrounding
  fact/run updates are factory semantics.

## Missing Public Primitives

### Add Client Primitive: Normalized Output Observations

Desired package/subpath: `@firegrid/client/firegrid`.

Rough shape:

```ts
interface RuntimeContextSnapshot {
  readonly agentOutputs: ReadonlyArray<RuntimeAgentOutputObservation>
}

interface FiregridSessionWaitClient {
  readonly forAgentOutput: (
    request?: { readonly afterSequence?: number; readonly timeoutMs?: number },
  ) => Effect.Effect<
    { readonly matched: false } | {
      readonly matched: true
      readonly output: RuntimeAgentOutputObservation
    },
    LaunchInputError | PreloadError
  >
}
```

Why current surfaces are insufficient: `RuntimeContextSnapshot` currently
exposes raw `events` rows (`packages/client/src/firegrid.ts:122`), so factory
has to parse `RuntimeEvent.raw` and know the `firegrid.agent-output` envelope
shape (`apps/factory/src/host.ts:423`). Runtime has the normalization helpers
(`packages/runtime/src/index.ts:141`), but apps should not need runtime event
envelope parsing to build a browser-safe status view from the client.

### No New Runtime Host/Config Primitive Recommended

Factory's host layer remains local because it combines Firegrid runtime host
configuration with `DarkFactoryTable` and `darkFactory.facts`
(`apps/factory/src/host.ts:171`). Existing runtime-host and durable-tools
exports are enough for this composition (`packages/runtime/src/index.ts:5`,
`packages/runtime/src/index.ts:106`).

## App-Owned Semantics

These are not public Firegrid surface gaps:

- Factory identity, subscriber ids, and permission idempotency keys
  (`apps/factory/src/identity.ts:45`, `apps/factory/src/identity.ts:87`,
  `apps/factory/src/identity.ts:102`).
- `darkFactory.facts`, trigger/fact/run schemas, run statuses, and the
  `DarkFactoryTable` durable table (`apps/factory/src/tables.ts:11`,
  `apps/factory/src/tables.ts:68`, `apps/factory/src/tables.ts:92`,
  `apps/factory/src/tables.ts:108`, `apps/factory/src/tables.ts:147`).
- Planner prompt wording, provider capability copy, Linear fields, and
  factory-specific tool guidance (`apps/factory/src/prompts.ts:36`).
- Factory status view shape and UI-facing vocabulary
  (`apps/factory/src/host.ts:100`, `apps/factory/src/host.ts:481`).

## Do Not Promote

Do not move these into `@firegrid/client` or `@firegrid/runtime`:

- `darkFactory.facts`, `darkFactory.run`, or `darkFactory.permission` source
  names and fact shapes.
- Linear/GitHub/Slack/provider vocabulary from trigger payloads or planner
  prompts.
- Factory run statuses such as `planner_started`, `waiting_permission`, and
  `resumed`.
- Factory permission-resolution fact writes and idempotency-key format.
- The factory read model that joins app facts, app runs, runtime rows, logs,
  ingress inputs, and permissions into one UI status payload.

## Recommendation

Add one future client primitive for normalized runtime output observations on
`@firegrid/client/firegrid`. Keep it browser-safe and runtime-source-free by
projecting the existing protocol/runtime output schema into the client snapshot
and wait API, rather than exposing raw runtime event envelope parsing to apps.

Do not add a runtime host/config primitive for factory yet. Retire only the raw
agent-output envelope parsing and polling glue once the client observation
primitive exists. Keep identity, tables, prompts, provider/product vocabulary,
and UI status assembly in `apps/factory`.
