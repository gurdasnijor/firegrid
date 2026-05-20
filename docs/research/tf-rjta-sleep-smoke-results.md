# tf-rjta Sleep-Only Substrate Smoke Results

## Scope

This slice adds a deterministic tiny-firegrid integration smoke for the smallest
factory-vision delivery path that does not spend LLM/provider cycles.

The smoke composes the existing dark-factory host and drives the public
runtime-context MCP HTTP route directly. It does not start Claude, ACP, or any
external provider process, and it does not exercise factory choreography.

## Verified

- The dark-factory host composes with its app-owned ChannelInventory.
- A run-scoped external key creates a deterministic runtime context id through
  the public Firegrid session facade, rather than using a singleton context.
- The host materializes the runtime context through the runtime-control
  reconciler.
- The materialized runtime context resolves the host-injected
  `firegrid-runtime-context` MCP URL.
- `tools/list` exposes `x-firegrid-channels` metadata on the runtime-context MCP
  tool schema, including:
  - `factory.events`
  - `event.plan.ready`
  - `dm.operator`
  - `notification.operator`
  - `approval.operator`
- `tools/call` for `sleep` returns `{ slept: true }` through the MCP/toolkit
  path.

## Validation

Local targeted validation:

```bash
pnpm --filter @firegrid/tiny-firegrid test -- sleep-only-substrate-smoke.test.ts
```

Result: pass.

## What This Does Not Prove

- No LLM or ACP runtime was launched.
- No planner prompt or provider-backed agent turn was run.
- No `wait_for`, `wait_for_any`, `send`, or `call` choreography was exercised.
- No full factory §6 live run was attempted.

This is a substrate-plumbing proof only: composed host, channel metadata, route
scoping, runtime-context materialization, and one MCP tool execution path.
