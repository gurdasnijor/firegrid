# tf-2y01 import guardrails baseline

Date: 2026-05-20

Base: current `origin/main` for `codex/tf-2y01-binding-execution-import-guardrails`.

Canonical source: `docs/architecture/host-sdk-runtime-boundary.md`.

## Rule Posture

This PR adds dependency-cruiser guardrails in report mode (`severity: "warn"`). The warning posture is intentional: lanes B and C still need to move execution substrate below the binding line, so this slice records the debt surface without failing `pnpm run lint:deps`.

Existing hard zero package-direction rules remain in place:

- `runtime-no-host-sdk`
- `client-sdk-no-runtime`

Lane D adds warning-level scan mirrors for those package directions plus host-sdk-specific scan rules for runtime subpath and substrate imports.

## Proposed Sanctioned Runtime Capability Subpaths

These are the runtime subpaths the first-slice rule allows host-sdk binding/composition modules to import:

| Runtime subpath | Resolved file | Rationale |
|---|---|---|
| `@firegrid/runtime/errors` | `packages/runtime/src/runtime-errors.ts` | Shared error types crossing the binding/runtime boundary. |
| `@firegrid/runtime/tool-executor` | `packages/runtime/src/agent-event-pipeline/subscribers/runtime-tool-use-executor.ts` | Runtime-owned capability tag; host-sdk provides the live implementation. |
| `@firegrid/runtime/control-plane` | `packages/runtime/src/authorities/index.ts` | Narrow runtime authority/capability surface currently composed by host-sdk. |
| `@firegrid/runtime/runtime-output` | `packages/runtime/src/agent-event-pipeline/authorities/runtime-output-public.ts` | Public runtime-output observation authority surface. |
| `@firegrid/runtime/streams` | `packages/runtime/src/streams/index.ts` | Substrate-neutral stream observation types. |
| `@firegrid/runtime/events` | `packages/runtime/src/agent-event-pipeline/events/index.ts` | Event schemas shared with binding code. |
| `@firegrid/runtime/codecs` | `packages/runtime/src/agent-event-pipeline/codecs/index.ts` | Codec adapter surface currently consumed at host composition edges. |
| `@firegrid/runtime/agent-adapters` | `packages/runtime/src/agent-adapters/index.ts` | Runtime adapter composition surface; still subject to review as substrate moves down. |
| `@firegrid/runtime/sources/sandbox` | `packages/runtime/src/agent-event-pipeline/sources/sandbox/index.ts` | Host-bound sandbox provider options and live composition surface. |

Not sanctioned by this first-slice rule:

- `@firegrid/runtime/workflow-engine`
- `@firegrid/runtime/durable-tools`
- direct imports of runtime implementation files below exported subpath barrels
- `effect-durable-operators` durable table facades from host-sdk binding modules

This list is a proposal for coordinator/Gurdas confirmation, not a final public API declaration.

## Baseline Command

```bash
pnpm run lint:deps
```

Result:

```text
x 11 dependency violations (0 errors, 11 warnings). 221 modules, 547 dependencies cruised.
```

## Current Warning List

| Rule | From | To |
|---|---|---|
| `host-sdk-no-unsanctioned-runtime-subpaths-scan` | `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` | `packages/runtime/src/durable-tools/index.ts` |
| `host-sdk-no-unsanctioned-runtime-subpaths-scan` | `packages/host-sdk/src/host/control-request-reconciler.ts` | `packages/runtime/src/workflow-engine/index.ts` |
| `host-sdk-no-unsanctioned-runtime-subpaths-scan` | `packages/host-sdk/src/host/host-owned-durable-tools.ts` | `packages/runtime/src/durable-tools/index.ts` |
| `host-sdk-no-unsanctioned-runtime-subpaths-scan` | `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts` | `packages/runtime/src/workflow-engine/index.ts` |
| `host-sdk-no-unsanctioned-runtime-subpaths-scan` | `packages/host-sdk/src/host/runtime-input-deferred.ts` | `packages/runtime/src/workflow-engine/index.ts` |
| `host-sdk-no-workflow-or-durable-substrate-scan` | `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` | `packages/runtime/src/durable-tools/index.ts` |
| `host-sdk-no-workflow-or-durable-substrate-scan` | `packages/host-sdk/src/host/control-request-reconciler.ts` | `packages/runtime/src/workflow-engine/index.ts` |
| `host-sdk-no-workflow-or-durable-substrate-scan` | `packages/host-sdk/src/host/host-owned-durable-tools.ts` | `packages/runtime/src/durable-tools/index.ts` |
| `host-sdk-no-workflow-or-durable-substrate-scan` | `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts` | `packages/runtime/src/workflow-engine/index.ts` |
| `host-sdk-no-workflow-or-durable-substrate-scan` | `packages/host-sdk/src/host/runtime-input-deferred.ts` | `packages/runtime/src/workflow-engine/index.ts` |
| `host-sdk-no-workflow-or-durable-substrate-scan` | `packages/host-sdk/src/host/session-log-channel.ts` | `packages/effect-durable-operators/src/index.ts` |

## Interpretation

The warnings match the architecture doc's expected debt shape:

- Lane B should reduce `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` by splitting validated execution into runtime-owned services and leaving host-sdk with protocol decoding and `ToolResult` adaptation.
- Lane C should reduce `runtime-context-workflow-runtime.ts`, `runtime-input-deferred.ts`, and `control-request-reconciler.ts` by moving or wrapping workflow definitions/execution mechanics under runtime-owned subpaths.
- Phase-1 cleanup should remove the remaining durable-tools import in `host-owned-durable-tools.ts`.
- `session-log-channel.ts` is a channel binding that currently reaches a durable table facade directly. It may stay in host-sdk only if the public surface remains semantic channel binding and the durable table access is wrapped behind a sanctioned runtime capability.

The scan mirrors for runtime-to-host-sdk and client-sdk-to-runtime reported zero warnings. The existing hard rules already enforce those directions.

## Error-Gate Flip Plan

Flip the new host-sdk scan rules from `warn` to `error` when all of the following are true:

1. Lane B has moved the execution arms out of `agent-tools/execution` or replaced the durable-tools import with a sanctioned runtime capability.
2. Lane C has moved workflow definitions/execution mechanics out of host-sdk or replaced direct workflow-engine imports with sanctioned runtime-owned capability tags.
3. The durable-tools deletion path has removed `host-owned-durable-tools.ts` and any `@firegrid/runtime/durable-tools` imports.
4. `pnpm run lint:deps` reports zero warnings for `host-sdk-no-unsanctioned-runtime-subpaths-scan` and `host-sdk-no-workflow-or-durable-substrate-scan`, or every remaining warning has a deliberately documented exception.

After the flip, keep `runtime-no-host-sdk` and `client-sdk-no-runtime` as hard zero package-direction rules. The warning mirrors can then be removed or converted to comments on the existing hard rules.
