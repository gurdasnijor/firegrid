# Firegrid / Flamecast Handoff

## Situation

Coordinator context should be treated as reset. The recent PR #121 guidance is unreliable and must not be used as implementation authority.

Current user intent:

- Stop broad planning.
- Stop speculative cookbook writing.
- Move implementation forward using actual existing package APIs and merged specs.
- For `apps/flamecast`, use the real Flamecast web shell and implement the backend/client seam correctly.
- If an API surface is missing, report the exact gap instead of inventing wrappers, orchestrators, topology files, or test harnesses.

## Repos

Primary repo:

```text
/Users/gnijor/gurdasnijor/firegrid
```

Related Flamecast source UI:

```text
/Users/gnijor/smithery/flamecast-agents/web
```

Important Flamecast web files:

```text
/Users/gnijor/smithery/flamecast-agents/web/src/App.tsx
/Users/gnijor/smithery/flamecast-agents/web/src/api.ts
/Users/gnijor/smithery/flamecast-agents/web/src/index.css
/Users/gnijor/smithery/flamecast-agents/web/src/main.tsx
```

## Source Of Truth

Use these, in order:

```text
features/firegrid/*.feature.yaml
features/flamecast/flamecast-product-contract.feature.yaml
packages/client/README.md
packages/runtime/README.md
packages/runtime/bin/firegrid.ts
current package source/types
```

Do not use PR #121 as authority unless the user explicitly revisits and fixes it.

## Acai Procedure

Acai is mandatory for planning, implementation, and review.

Rules:

- Specs are source of truth.
- Requirements are ACIDs: `<feature-name>.<GROUP>.<id>`.
- Code/tests should cite full ACIDs when implementing behavior.
- Do not invent behavior beyond specs.
- If implementation and specs diverge, stop and report the mismatch.
- Do not renumber feature YAML requirements.

## Current Repo State

At last check, primary `firegrid` main had an uncommitted planning edit:

```text
M docs/replatforming/README.md
```

Do not assume it is yours. Check before editing:

```sh
git status -sb
```

Active/important worktrees mentioned:

```text
/Users/gnijor/gurdasnijor/firegrid/.worktrees/fc-lt02-real-flamecast-ui
```

CA1 was working on:

```text
branch agent1/fc-lt02-real-flamecast-ui
```

CA2 had durable subscriber work in a separate worktree earlier:

```text
/Users/gnijor/gurdasnijor/firegrid-ca2-durable-subscriber
```

Do not delete active worktrees without explicit user approval.

## Recent PRs

Relevant merged PRs:

- `#115` LT-02 initial Flamecast chassis merged.
- `#118` observability merged.
- `#119` projection query facade merged.
- PRs `#111/#112/#113` spec stack merged earlier.
- `#121` was opened to restore patterns from #114, but user rejected its content. Treat it as unreliable. Close or ignore per user direction.

PR `#120` durable subscriber primitives:

- Was open and sitting.
- Review found it should not merge as-is.
- Problems found:
  - dirty against current main
  - conflict in `scripts/effect-artifacts/analyze.mjs`
  - retry semantics broken
  - lease/fence fields modeled but not enforced
  - dedupe retention policy declared but unused
  - outcome recording returns recorded terminal without projection confirmation
  - terminal winner depends on selector iteration order
  - public DurableChannel API too raw
  - runtime durableChannelCompletion helper under-baked

Recommended reset for #120:

- descriptor/fold/query first
- producer/dedupe second
- claim/retry/outcome third
- runtime wait integration fourth

## apps/flamecast Desired Direction

The existing `apps/flamecast` on main is a small LT-02 proof chassis, not the target end state.

Existing main shape:

```text
apps/flamecast/src/client/main.tsx       # bespoke mini UI
apps/flamecast/src/client/firegrid.ts    # small Firegrid client adapter
apps/flamecast/src/runtime/main.ts       # problematic runtime/test-server mix
apps/flamecast/src/runtime/handler.ts    # mocked deterministic handler
apps/flamecast/src/shared/protocol.ts    # SessionTurn + SessionEvents
```

User wants:

- lift the real Flamecast web UI from `flamecast-agents/web`
- replace the Flamecast web `api.ts` behavior with a Firegrid-backed implementation
- write actual backend/client code against existing Firegrid APIs
- no toy smoke scripts
- no fake UI
- no fake provider content

## Known Bad Code / Do Not Preserve

### `apps/flamecast/src/client/main.tsx`

Had browser fetch:

```ts
fetch("/topology.json")
```

Problem:

- `pnpm --filter @firegrid/flamecast dev` starts only Vite.
- If runtime did not pre-write `public/topology.json`, browser parses bad/missing Vite output.
- User saw:

```text
SyntaxError: The string did not match the expected pattern.
```

Do not preserve generated `public/topology.json` as browser/runtime contract.

### `apps/flamecast/src/runtime/main.ts`

Had:

- `DurableStreamTestServer`
- direct `@durable-streams/client`
- stream head/create
- write `public/topology.json`

User strongly rejected this.

Do not hide test-server/dev-stream setup inside product runtime entry.

### `apps/flamecast/src/runtime/handler.ts`

Had mocked content:

- reversed-word assistant output
- `provider: "local-deterministic"`
- `model: "echo-rewrite-count"`
- fabricated success timeline

User strongly rejected this.

Acceptable behavior:

- real local adapter boundary
- call existing Flamecast runtime/provider if available
- or configured local command/process adapter
- or typed `adapter-not-configured` error
- no fake successful assistant response

## Major Architectural Corrections

Current user position:

- Default local app dev should be easy from a user perspective.
- Do not ask the developer to manually provide `DURABLE_STREAMS_URL` for the normal `apps/flamecast` dev path unless the package API truly requires it and the gap is reported.
- Do not invent unsupported app orchestration docs as if package specs authorize them.
- If current Firegrid APIs do not provide the needed embedded/local dev host, report the API gap exactly.

`packages/runtime/bin/firegrid.ts` fact:

- `firegrid` binary is attached-only in current code.
- It reads `DURABLE_STREAMS_URL`.
- It explicitly says it does not launch Durable Streams or child dev processes.

Do not conflate this with desired app dev UX.

## Critical Open API Question

CA1 reported:

> Current origin/main runtime types reject `FiregridClientLive` as a provider layer during app typecheck.

This must be verified directly from current types before coding further.

Question:

- Can a runtime handler depend on `FiregridClient` by providing `FiregridClientLive` through `Firegrid.composeRuntime({ provide })` using current merged `@firegrid/runtime` types?
- If not, what is the correct public boundary for runtime-authored EventStream emits?
- Do not create app-local type bridges unless user explicitly authorizes. Report exact type error and file/type definitions.

Relevant docs/source:

```text
packages/client/README.md
packages/runtime/README.md
packages/runtime/src/composition.ts
packages/runtime/src/runtime-api.ts
packages/client/src/index.ts
```

## Current Useful Firegrid APIs

Client README says `@firegrid/client` provides:

```ts
FiregridClient
FiregridClientLive(config)
Operation
EventStream
client.send
client.result
client.call
client.observe
client.emit
client.events
```

Runtime README says `@firegrid/runtime` provides:

```ts
run({ connection, runtime })
Firegrid.handler(operation, handler)
Firegrid.eventStream(descriptor, materialize)
Firegrid.subscribers.*
Firegrid.composeRuntime({ handlers, subscribers, provide })
```

Important distinction:

- `Firegrid.eventStream(...)` is materializer/subscriber, not emitter.
- `client.emit(...)` is EventStream append on client surface.

But verify runtime/client Layer composition types before recommending handler yields `FiregridClient`.

## Real Flamecast Web API Surface

From `flamecast-agents/web/src/api.ts`, the real UI expects exports including:

```ts
apiFetch
Event
SessionListItem
AgentMeta
HiveMeta
WorkspaceFile
WorkspaceListing
AgentSessionRef
agentWorkspaceFileUrl
deleteSession
getAgent
hiveFileUrl
listAgentSessions
listAgentWorkspace
listAgents
listHiveWorkspace
listHives
listSessions
listWorkspace
liveEventsUrl
sendMessage
workspaceFileUrl
```

`App.tsx` uses:

- routes under `/ui`
- session list/detail views
- WebSocket live events via `liveEventsUrl`
- session messages via `sendMessage`
- workspace/agents/hives surfaces, which can likely be stubbed as unsupported/empty if not needed for LT-02

Implementation should map this API surface to Firegrid where possible.

## apps/flamecast Target Acceptance

Fresh checkout path:

```sh
pnpm i
pnpm --filter @firegrid/flamecast dev
```

Expected:

- opens usable Flamecast-local app
- no topology JSON parse error
- no direct browser runtime imports
- no direct Durable Streams product seam
- real Flamecast shell visible, not mini chassis
- user can start a local session
- events appear in session timeline
- user can send follow-up
- timeline survives browser refresh via durable replay
- if local adapter not configured, UI shows typed setup error, not fake assistant success

## Forbidden / Avoid

For `apps/flamecast` implementation:

- No docs-only PR for this task.
- No new smoke script as primary artifact.
- No fake deterministic assistant success.
- No generated `public/topology.json`.
- No browser `@firegrid/runtime`.
- No browser `@firegrid/substrate/kernel`.
- No product app seam using direct `@durable-streams/client` stream head/create.
- No Cloudflare Worker/DO/DB/auth/WorkOS/provider infra.
- No Vite plugin that loads runtime as browser dev server middleware.
- No arbitrary wrapper functions in docs/examples that obscure the actual API seam.
- No cookbook guidance unless verified against current types.

## cmux Usage

Available workspace/panes at last check:

```text
workspace:2 "Firepixel"
surface:37 "Coding agent"        # CA1, apps/flamecast real UI task
surface:54 "Coding Agent 2"      # CA2, durable subscriber work
surface:66 "Opus Lead Agent"
surface:81 "Opus Coding Agent"
surface:98 "Coding Agent 4"
surface:99 "Opus Coding Agent 2"
```

Basic commands:

```sh
cmux list-pane-surfaces --workspace current
cmux read-screen --workspace workspace:2 --surface surface:37 --lines 80
cmux send --workspace workspace:2 --surface surface:37 "message"
cmux send-key --workspace workspace:2 --surface surface:37 Enter
```

When sending to agents:

- send text
- then press Enter
- keep instructions short and exact
- do not broadcast bad guidance
- if reset, tell them explicitly what to ignore and what source of truth to use

## Team Communication Reset Message

If starting a new coordinator session, send this to active agents:

```text
COORDINATOR RESET NOTICE

Coordinator context has been reset. Ignore PR #121 and any previous cookbook guidance from the prior coordinator unless explicitly reissued.

Use only:
- merged feature specs in features/firegrid and features/flamecast
- packages/client/README.md
- packages/runtime/README.md
- current package source/types
- direct user/coordinator instructions

If an API shape is unclear, report the exact type/file question. Do not invent wrappers, topology files, dev orchestrators, direct Durable Streams product seams, or mock provider behavior.
```

For CA1 specifically:

```text
CA1 FC-LT02 reset

Continue real Flamecast UI implementation, but pause any implementation based on PR #121. Verify current package APIs/types directly.

Immediate question to answer before coding further:
Can current @firegrid/runtime composeRuntime({ provide }) accept FiregridClientLive so a handler can yield FiregridClient and call client.emit? If no, report exact type error and relevant type definitions. Do not add app-local type bridge without approval.

Keep target:
- real Flamecast web shell from flamecast-agents/web
- Firegrid-backed api.ts
- no topology.json
- no direct @durable-streams/client in product seam
- no fake assistant success
```

For CA2 specifically:

```text
CA2 PR #120 reset

PR #120 is not merge-ready. Do not push broad fixes blindly. Split or reduce scope.

Known blockers:
- dirty against main
- retry cannot reclaim after retry row
- lease/fence fields ignored
- dedupe retention unused
- recordOutcome not projection-confirmed
- terminal order depends on selector order
- public API too raw
- runtime completion helper under-baked

Return with a reduced plan: descriptor/fold/query first, then producer/dedupe, then claim/retry/outcome, then runtime wait integration.
```

## Immediate Next Coordinator Actions

1. Close or mark PR #121 not for merge.
2. Tell CA1 to ignore PR #121 and verify actual runtime/client composition types.
3. Decide whether `apps/flamecast` should first land:
   - real UI copy + API stubs
   - or backend/runtime API correction
   The user wants “just get it to work,” but correctness blockers in runtime/client seam must be resolved first.
4. For #120, require CA2 to reduce scope or close/reopen smaller PR.
5. Do not author more docs unless user explicitly asks.

## User Preference

The user is frustrated and wants direct execution management.

Avoid:

- long speculative plans
- cheerleading
- inventing abstractions
- cookbook examples not verified against code
- defensive explanations

Prefer:

- “This is wrong; here is the exact correction.”
- “This API does/does not exist; here is the file/type proof.”
- “I stopped the agent and gave this bounded instruction.”
- “This PR should/should not merge because X.”
