# agent-coordination-readiness — readiness smoke (PR #738 / #703 stack)

**Verdict: GREEN on the load-bearing assertion (step 5).** Steps 1 and 3 are
documented YELLOW; the remaining checklist steps are GREEN through real
production primitives.

## Scope

- Proves: a child session's first agent output is observable via BOTH the
  public client method `handle.wait.forAgentOutput({ afterSequence })` AND a
  direct `HostPlaneChannelRouter.dispatch({ verb: "wait_for", target:
  "session.agent_output", payload: { sessionId, afterSequence } })`, returning
  the same `sequence`. This is what #703 registered on the host-plane router
  via `sessionAgentOutputObservationRoute(sessionAgentOutput)` in
  `packages/runtime/src/channels/host-control-routes.ts:113`.
- Does NOT prove: in-session `session_new` agent-tool execution. The child
  spawn here is an OUTER-DRIVER surrogate. CC6 will fix
  `RuntimeAgentToolExecutionLive` in runtime composition; the matching
  second smoke (planner emits `session_new`, runtime executes it) belongs
  with that PR.
- Does NOT prove: runtime-bin binary surface. The host is composed
  in-process via `FiregridLocalHostLive`, which is the same `FiregridRuntimeHostLive`
  the runtime-bin will compose once CC6 lands.

## Readiness matrix

| # | Step | Status | Evidence |
|---|------|--------|----------|
| 1 | Host composed in-process | YELLOW | `agentCoordinationReadinessHost` mirrors what `packages/runtime/src/bin/{run,host,acp}.ts` will compose. Bin surfaces don't exist yet (CC6). `it.skip` with disclosure. |
| 2 | Planner createOrLoad + start | GREEN | Public `firegrid.sessions.createOrLoad` → `host.sessions.create_or_load` router target → planner handle. |
| 3 | Child session spawn | YELLOW (GREEN-surrogate) | Same router target as planner-emitted `session_new`, driven from outer driver. Real `session_new` tool-call path blocked on CC6. |
| 4 | Child agent emits TextChunk | GREEN | Deterministic `stdio-jsonl` fixture agent (`node -e <inline script>`) emits one JSONL `text` event; codec translates to `TextChunk`. |
| 5a | Observation via `handle.wait.forAgentOutput` | GREEN | Public client method returns the `TextChunk` observation. |
| 5b | Observation via `HostPlaneChannelRouter.dispatch` | GREEN (LOAD-BEARING) | Direct router-mediated `wait_for` on `session.agent_output` returns the SAME `sequence` as 5a. |
| 6 | OTel `firegrid.channel.dispatch` span | GREEN | Recording tracer captures `firegrid.channel.dispatch` with `firegrid.channel.target == "session.agent_output"` and `firegrid.channel.verb == "wait_for"`. |

## Run

Smoke (the readiness gate):
```
cd /Users/gnijor/gurdasnijor/firegrid-readiness-sim
pnpm --filter @firegrid/tiny-firegrid test test/agent-coordination-readiness/smoke.test.ts
```

Full tiny-firegrid suite (regression):
```
pnpm --filter @firegrid/tiny-firegrid test
```

Typecheck:
```
pnpm --filter @firegrid/tiny-firegrid typecheck
```

## Routing around a stale host-sdk barrel

On this stack (`origin/sidecar/runtime-bin-support`, head `91ed12b77`),
`packages/host-sdk/src/host/index.ts` still re-exports symbols from a
file that has been deleted (`./acp-stdio-edge.ts` was moved to
`packages/runtime/src/producers/codecs/acp/stdio-edge.ts` by `dcfb01f71`).
The package barrel imports throw at load time, so any test that imports
from `@firegrid/host-sdk` fails before `runtime-bin-support`'s own runtime
fix (`91ed12b77`) can be exercised.

The brief forbids edits outside `packages/tiny-firegrid/**`, so this
simulation routes around the broken barrel by importing the same
canonical symbols directly from runtime:

| Symbol | Canonical home |
|---|---|
| `FiregridLocalHostLive` | `@firegrid/runtime/composition/host-live` |
| `FiregridLocalProcessFromEnv` | `@firegrid/runtime/producers/sandbox/local-process-from-env` |
| `FiregridEnvBindingsFromEnv` | `@firegrid/runtime/producers/sandbox/local-process-from-env` |
| `FiregridHost` (type) | `@firegrid/runtime/composition/host-live` |
| `HostPlaneChannelRouter` | `@firegrid/runtime/channels` |

This matches the Class F3 cutover that landed `FiregridLocalHostLive` /
`FiregridRuntimeHostLive` / `FiregridHost` at the canonical runtime home
(`8fdae0b53`); host-sdk is being deleted in a follow-up
(`507da434c feat(host-sdk delete-first)`). The simulation has no
dependency on the host-sdk barrel — it's a pure runtime composition
consumer.

The 3 pre-existing failures in the full suite
(`agentic-patterns-primitive-profile`, `sleep-only-substrate-smoke`,
`spike-channel-deletion/sim2-multi-surface-projection`) ARE caused by
the same stale host-sdk barrel and are out of scope for this PR; they
will green either when host-sdk is deleted or when the barrel is
repaired.

## Follow-up

A second smoke must land WITH CC6 (`RuntimeAgentToolExecutionLive` fix in
runtime composition) that drives `session_new` through real agent-tool
execution: a planner subprocess emits a `tool_use` JSONL line for
`session_new`, the runtime executes the tool, and the child session
materializes through the same `host.sessions.create_or_load` router target.
The observation half (step 5) stays identical; what changes is the SPAWN
provenance — planner-emitted vs outer-driver-emitted.

## What this is NOT

- Not a new router, channel, schema, or composition path. Uses the existing
  `HostPlaneChannelRouter`, `session.agent_output` route, and
  `FiregridLocalHostLive` composition unchanged.
- Not a production edit. The simulation lives entirely under
  `packages/tiny-firegrid/**` (plus a one-line addition to the runner's
  `hiddenFolders` set so the smoke-only sim is not auto-discovered).
- Not a docs/research entry. This FINDING.md is local to the simulation
  folder.
- Not a direct durable-table cheat on the read side. Both observation paths
  go through the production `session.agent_output` route; the read source is
  `RuntimeOutputTable.events.rows()` via the host's `SessionAgentOutputChannelLive`.
- Not load-bearing for spawn shape. The `session_new` spawn shape is owned
  by `shape-c-channel-router-turn` and the upcoming CC6 follow-up smoke; the
  outer-driver createOrLoad here is a YELLOW surrogate explicitly to keep
  the load-bearing assertion focused on step 5.
