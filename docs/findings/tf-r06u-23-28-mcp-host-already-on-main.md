# tf-r06u.23 / .28 — the host-owned MCP-surfacing tier is already implemented + wire-validated on main

Date: 2026-06-01
Owner: tf-r06u.23 / tf-r06u.28 (agent2 / lane-b)
TL;DR: **Don't build the workbench from scratch and don't re-derive the contract — main already has both.** Re-scope: tf-r06u.28 = *port-forward* (not rebuild); tf-r06u.23's "design + prove" premise is subsumed.

## What's on `origin/main` (deleted by #765, hence the "deleted mcp-host")

- **`packages/runtime/src/composition/mcp-host.ts`** — `FiregridMcpServerLayer` composes `@effect/ai/McpServer.layerHttp` + `McpServer.registerToolkit(FiregridAgentToolkit)` behind `@effect/platform-node/NodeHttpServer` on loopback, per-context path `/runtime-context/:contextId`. Comment: *"no custom MCP router, no wrapper toolkit, no manual tools/list"* — the idiomatic `@effect/ai` approach.
- **`packages/runtime/src/subscribers/tool-dispatch/toolkit-layer.ts`** — `FiregridAgentToolkit` + `FiregridAgentToolkitLayer` (the choreography toolkit: `sleep`/`wait_for`/`wait_for_any`/`schedule_me`/`spawn`…) and `FiregridPrimitiveProfileToolkit(Layer)` (a locked subset). These are `@effect/ai` `Toolkit`s.
- **`runtime-context-mcp-base-url.ts`** + **`producers/codecs/mcp`** — the TFIND-048 host-owned URL late-binding (`FiregridRuntimeContextMcpBaseUrl`) that injects the contextId-scoped MCP URL post-materialization.

## The `@effect/ai` McpServer ↔ ACP-adapter wire-compat is ALREADY validated (tf-x3sv)

`mcp-host.ts:240-257` documents and fixes the exact wire-compat issue this spike was going to "discover":

> `McpServer.registerToolkit` pushes tools one at a time (each `addTool` fires `notifications/tools/list_changed`); the `tools/list`/`initialize` handlers read `server.tools` live. When registration was a sibling of `HttpRouter.Default.serve()` in the `mergeAll` (built concurrently), a client listing mid-registration saw a *prefix* — **codex-acp, which snapshots `tools/list` once and has no `list_changed` handler, observed only `sleep`** (the first-registered tool). Fix: make registration a **build-time dependency** of the serving layers (happens-before edge) so the first `tools/list` is always complete.

Commits `d24e45734` / `3da108a60` ("register full MCP toolset before serving for no-refresh clients"). Main-side tests `agentic-patterns-primitive-profile.test.ts` + `sleep-only-substrate-smoke.test.ts` hit the real bound HTTP endpoint (`FiregridRuntimeContextMcpBaseUrl` → `tools/list`) and assert the locked toolset.

## Reconciliations

- **Stale memory corrected** (`project_codex_acp_defers_mcp_tools`, 2026-05-22: "codex-acp defers MCP → only `sleep` surfaced of 11"): that was **not** a codex dialect limitation — it was the tf-x3sv **registration-ordering race** (no-`list_changed`-refresh client listing mid-registration). Fixed at the host. Do not treat codex as MCP-deferring.
- **Consistent with B1** (`tf-r06u.12`): my live tests showed both codex-acp + claude-agent-acp discover *and call* a Firegrid-surfaced MCP tool. That's the post-fix behavior (full toolset registered before serving). B1 is complementary end-to-end evidence; tf-x3sv is the host-side invariant that makes it reliable for no-refresh clients.

## Re-scope (recommended)

- **tf-r06u.28 (was "rebuild the deleted mcp-host") → PORT-FORWARD.** Bring `composition/mcp-host.ts` + `toolkit-layer.ts` (`FiregridAgentToolkit(Layer)` + primitive profile) + `runtime-context-mcp-base-url.ts` + `producers/codecs/mcp` from main onto the #765 unified substrate, reconciling imports against the new tiers. **Preserve the tf-x3sv invariant** (register full toolset before serving — it's a happens-before requirement, not incidental) and the `toolProfile` full/primitive split. Acceptance = port the `agentic-patterns` + `sleep-only` tests (deleted-as-dead on #765 in PR #766 because their `composition/host-live` + `producers/codecs/mcp` imports were gone) back once the tier lands.
- **tf-r06u.23 (workbench "design Context.Tag + stub + prove").** Premise **subsumed by main** — the contract isn't a new `McpHost` Context.Tag to invent; it's the existing `FiregridMcpServerLayer` (Layer) + `FiregridAgentToolkit` (`@effect/ai` Toolkit), and the `@effect/ai`↔adapter wire-compat is already proven. **Recommend: close tf-r06u.23, or fold its residual (a unified-kernel public-surface sim exercising the ported mcp-host) into tf-r06u.28's acceptance** rather than build a parallel workbench. The "workbench pattern" stays valuable as methodology (documented in PR #766) for *future* not-yet-built tiers; this particular tier is already built.

## Why this is the right call

"tiny-firegrid = empirical answer machine" cuts both ways: before building a workbench to answer "does `@effect/ai` McpServer work with these adapters and what's the contract," check whether the answer already exists. It does, on main, with a documented wire-compat fix (tf-x3sv) and tests. Porting-forward + preserving the invariant beats re-deriving it.
