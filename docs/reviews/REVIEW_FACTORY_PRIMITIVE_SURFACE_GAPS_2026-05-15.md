# Factory Primitive Surface Gaps Review

Date: 2026-05-15

Scope: PR #256, `apps/factory/**`, current `@firegrid/client/firegrid` and
`@firegrid/runtime` public surfaces.

## Summary

PR #256 left factory able to build the core runtime flow from current public
primitives: public client sessions, public runtime host layers, durable source
registration, and protocol-owned runtime observation source names. After PR #264
and the runtime boundary PR9 work, factory consumes normalized agent-output
observations through the client/session surface and consumes env policy plus
app-owned source registration through `@firegrid/runtime/runtime-host`.

The remaining glue in `apps/factory/src/host.ts` is app read-model assembly and
factory product semantics.

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
- Env binding policy and app-owned durable fact source registration are covered
  by runtime-host exports. Factory imports `RuntimeEnvResolverPolicy` and
  `registerRuntimeHostAppSource` from `@firegrid/runtime/runtime-host`, so it no
  longer reaches into `@firegrid/runtime/sources/sandbox` or
  `@firegrid/runtime/durable-tools` for production composition.
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
  and deriving permission requests from normalized `snapshot.agentOutputs`
  (`apps/factory/src/host.ts:481`). That read model is app-owned.
- `waitForPermissionRequest` must check existing snapshot rows, then loop
  through `session.wait.forPermissionRequest` in small timeout slices
  (`apps/factory/src/host.ts:585`). The existing client wait primitive is useful
  for one durable permission wait; the extra loop is factory's
  existing-first/status-view behavior.
- `waitForNextAgentOutput` uses the client `session.wait.forAgentOutput`
  primitive for normalized output observations.
- `respondToFactoryPermission` coordinates an app fact write, the client
  permission response, a snapshot lookup for the response input row, and a
  factory run status update (`apps/factory/src/host.ts:521`). The Firegrid
  permission response itself is public and sufficient; the surrounding
  fact/run updates are factory semantics.

## Missing Public Primitives

### Resolved Client Primitive: Normalized Output Observations

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

This is now covered by `RuntimeContextSnapshot.agentOutputs` and
`session.wait.forAgentOutput`.

### Runtime Host/Config Primitive Added For PR9

Factory's host layer remains local because it combines Firegrid runtime host
configuration with `DarkFactoryTable` and `darkFactory.facts`
(`apps/factory/src/host.ts:171`). PR9 adds the narrow runtime-host
app-source-registration surface so factory does not import wait internals for
that composition.

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

Keep identity, tables, prompts, provider/product vocabulary, and UI status
assembly in `apps/factory`. Factory should use `@firegrid/client/firegrid` for
session semantics and `@firegrid/runtime/runtime-host` for embedded host/config
composition.
