# Workflow.make admission ledger (C2 / WORKFLOW_ADMISSION)

The workflow-identity admission guard (`firegrid-workflow-driven-runtime.WORKFLOW_ADMISSION`,
runtime design constraint **C2**) blocks net-new production `Workflow.make` definitions.
New owner workflows must be SDD-justified.

When Semgrep was retired (static-analysis consolidation, phase 2), this guard moved
from the Semgrep ERROR baseline (`semgrep-error-baseline.json`,
`firegrid-no-unclassified-workflow-make`) to the `effect-quality` ts-morph count
ratchet — `workflowMakeSiteCount` in `scripts/effect-artifacts/quality-metrics.mjs`,
grandfathered at the count below in `effect-quality-metrics-baseline.json`. The
ratchet fails CI on any increase (a new `Workflow.make`); to add a genuine owner
workflow, update the SDD, add the justification here, and re-baseline with
`pnpm run lint:effect-quality:baseline`.

> Note on coverage vs. the old Semgrep rule: the count ratchet scopes to
> `packages/**/src` (production, excluding `bin/`), so it cannot pin a finding to a
> specific path+line. It preserves the load-bearing "no net-new `Workflow.make`"
> guarantee; the per-site justifications are recorded here instead.

## Admitted workbench workflows (tiny-firegrid sims, not shipped production)

- `packages/tiny-firegrid/src/simulations/durable-deferred-and-serialization/host.ts:88` — tf-ogoj WORKBENCH workflow `workbench.deferred-gate` (H1). Awaits a standard `DurableDeferred` on the REAL `DurableStreamsWorkflowEngine` and is resolved externally, to gather trace evidence that `signal.ts`'s await/resolve is a second implementation of the engine seam (SDD §2.1). Lives only in the sim's host composition; the trace is the deliverable (`docs/findings/tf-ogoj-durable-deferred-and-serialization.md`).
- `packages/tiny-firegrid/src/simulations/durable-deferred-and-serialization/host.ts:145` — tf-ogoj WORKBENCH workflow `workbench.serialization` (H2). Per-event handler keyed `(contextId,inputKey)` over a durable cursor, driven by CONCURRENT same-`contextId` inputs. Isolated result: the cursor serializes (substrate single-row tx); the real per-`contextId` race is the adapter `startOrAttach` TOCTOU (5 spawns for one session). Sim-only.
- NOTE for owners: the `workflowMakeSiteCount` ratchet scopes to `packages/**/src`, which includes tiny-firegrid sims. Same admission posture as the tf-c71h workbench (PR #850): whether sim/workbench workflows should count against the production C2 ledger vs. an excluded sim scope is a standing tooling question — admitted conservatively so the gate stays intact.

## Grandfathered owner workflows (7, baseline `workflowMakeSiteCount: 7`)

- `packages/runtime/src/unified/subscribers/runtime-context.ts:66` — Owned durable runtime-context session workflow: one execution per context attempt, parks on Workflow.suspend while waiting for session input signals, owns adapter lifecycle start/send/deregister.
- `packages/runtime/src/unified/subscribers/permission-and-tool.ts:90` — Owned durable permission wait workflow: records the permission request, parks on the decision signal, then relays the decision back to the owning runtime-context session workflow.
- `packages/runtime/src/unified/subscribers/permission-and-tool.ts:203` — Tool dispatch is operation-shaped but intentionally owns at-most-once durable tool execution via Workflow idempotency + Activity memoization, then relays through the ToolExecutor/session signal seam.
- `packages/runtime/src/unified/subscribers/scheduled-webhook-peer.ts:62` — Owned durable scheduled-prompt workflow: records a schedule commitment and parks on DurableClock.sleep until the owned wake time.
- `packages/runtime/src/unified/subscribers/scheduled-webhook-peer.ts:313` — Owned durable webhook-fact observer workflow: parks on the webhook-fact signal and then reads the corresponding owned fact row written before signal delivery.
- `packages/runtime/src/unified/subscribers/scheduled-webhook-peer.ts:368` — Owned durable peer-event observer workflow: parks on the peer-event signal and then reads the corresponding owned peer-event row written before signal delivery.
- `packages/runtime/src/unified/mcp-host/tool-dispatch.ts:384` — Reviewed MCP-entry Shape D tool-dispatch owner workflow: one execution per toolUseId, uses Workflow idempotency and Activity memoization for at-most-once tool execution, then returns the synchronous MCP tools/call result without a relay.
