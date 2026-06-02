# tf-0awo.30 — factory capstone sim on the post-section-12 substrate

**Bead:** `tf-0awo.30` · **Sim:** `factory-capstone` · **Date:** 2026-06-02  
**Run:** `.simulate/runs/2026-06-02T12-44-30-818Z__factory-capstone/trace.jsonl`

## What the sim proves

The capstone host composes the real post-section-12 `FiregridRuntime(spec, adapter)`
with the production ACP codec adapter and the unified MCP host. The driver uses
only `@firegrid/client-sdk/firegrid` plus Effect, launches the real Claude ACP
planner, and drives the scenario through public session APIs.

The app-owned `darkFactory.facts` stream is bound as a durable caller fact route
and is reachable from the runtime-context MCP `wait_for` tool:

- Line 27 seeds `darkFactory.facts:...:factory.trigger.accepted`.
- Line 40 registers the full runtime-context MCP toolkit, including
  `session_new`, `session_prompt`, and `wait_for`.
- Lines 375 and 384 show the MCP `wait_for` call reading
  `darkFactory.facts` with `eventType = factory.trigger.accepted`.
- Lines 379 and 383 show the MCP tool-dispatch workflow completing
  successfully.

The ACP permission gate is also exercised over the public path: the driver
observed two permission requests, auto-approved them, and the runtime wrote
permission response signals before the planner continued.

## Finding

The full external-trigger -> delegated reviewed-action loop does **not** complete
yet. The trace reaches the planner's first delegated action and then fails at the
MCP `session_new` tool:

- Line 620: `unified.mcp-tool.execute/...` fails with `tool "session_new" is not
  yet ported onto the unified executor`.
- Line 625: `Toolkit.handle` shows the planner called `session_new` with a real
  delegated prompt.
- Line 815: the driver records `firegrid.factory_capstone.status = "finding"`,
  with `finding_marker_observed = true`.

Source verification: `packages/runtime/src/unified/mcp-host/toolkit.ts:119-162`
advertises `session_new`, `session_prompt`, `execute`, and other tools in the MCP
toolkit, but `packages/runtime/src/unified/mcp-host/tool-dispatch.ts:290-335`
only lowers `sleep`, `wait_until`, `wait_for`, and `wait_any`; all other
advertised tools fall through to the "not yet ported" error.

## Triage

**Category 2: implementation gap.** The sim is not reaching past the public
surface: the planner uses the advertised runtime-context MCP toolkit, and the
driver stays on public client APIs. The production MCP toolkit advertises
`session_new`, but the unified executor cannot run it yet. The capstone becomes
green when the MCP executor ports at least `session_new` and `session_prompt`
onto the post-section-12 host/session routes.
