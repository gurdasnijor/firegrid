# Workflow.make admission ledger (C2 / WORKFLOW_ADMISSION)

The workflow-identity admission guard (`firegrid-workflow-driven-runtime.WORKFLOW_ADMISSION`,
runtime design constraint **C2**) blocks net-new production `Workflow.make` definitions.
New owner workflows must be SDD-justified.

This guard has moved twice. Semgrep `firegrid-no-unclassified-workflow-make`
(ERROR baseline) → the `effect-quality` ts-morph count ratchet
(`workflowMakeSiteCount`) → **(tf-q6vf)** the AST-precise ESLint rule
`local/no-unclassified-workflow-make`. The ratchet + its baseline JSON were
deleted; the guard is now a **per-site annotation gate**: every production
`Workflow.make(...)` must carry a nearby `// workflow-make-admission` comment.
A net-new `Workflow.make` without the annotation fails `pnpm run lint`. To add a
genuine owner workflow: update the SDD, add the justification to the list below,
and annotate the call site with `// workflow-make-admission`.

> Coverage note: the ESLint rule pins each finding to its exact path+line (an
> improvement over the count ratchet, which could only scope to `packages/**/src`).
> The annotation makes the admission decision visible at the call site; this ledger
> records the per-site justifications.

## Owner workflows (7, each annotated `// workflow-make-admission`)

- `packages/runtime/src/unified/subscribers/runtime-context.ts:66` — Owned durable runtime-context session workflow: one execution per context attempt, parks on Workflow.suspend while waiting for session input signals, owns adapter lifecycle start/send/deregister.
- `packages/runtime/src/unified/subscribers/permission-and-tool.ts:90` — Owned durable permission wait workflow: records the permission request, parks on the decision signal, then relays the decision back to the owning runtime-context session workflow.
- `packages/runtime/src/unified/subscribers/permission-and-tool.ts:203` — Tool dispatch is operation-shaped but intentionally owns at-most-once durable tool execution via Workflow idempotency + Activity memoization, then relays through the ToolExecutor/session signal seam.
- `packages/runtime/src/unified/subscribers/scheduled-webhook-peer.ts:62` — Owned durable scheduled-prompt workflow: records a schedule commitment and parks on DurableClock.sleep until the owned wake time.
- `packages/runtime/src/unified/subscribers/scheduled-webhook-peer.ts:313` — Owned durable webhook-fact observer workflow: parks on the webhook-fact signal and then reads the corresponding owned fact row written before signal delivery.
- `packages/runtime/src/unified/subscribers/scheduled-webhook-peer.ts:368` — Owned durable peer-event observer workflow: parks on the peer-event signal and then reads the corresponding owned peer-event row written before signal delivery.
- `packages/runtime/src/unified/mcp-host/tool-dispatch.ts:384` — Reviewed MCP-entry Shape D tool-dispatch owner workflow: one execution per toolUseId, uses Workflow idempotency and Activity memoization for at-most-once tool execution, then returns the synchronous MCP tools/call result without a relay.
