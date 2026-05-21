# tf-1r3h: Durable Sync/Async Production Closure

Verdict: **production semantics closed; no C-class operation remains after this PR**.

`tf-lfxs` validated the sync/async channel framing as a spike, and `tf-lf9p`
shipped the first production slice for session-dependent writes. This PR closes
the remaining public dependent-write gap by making top-level `firegrid.prompt`
wait for reflected context state before it appends. Identity-only calls still
return request/handle acknowledgements immediately; the dependent operation owns
the reflection barrier when the next public write requires reflected state.

Framing sources: the SDD names the recurring problem as "dispatch, then wait
for reflection" and assigns the barrier to callable or dependent-operation
bindings when the result gates the next action
(`docs/sdds/SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md:129`, `:140`).
This PR also corrects the SDD wording so production closure no longer implies
globally blocking `createOrLoad`.

## Classification

Evidence anchor convention: the **symbol names** in each cell (e.g.
`awaitSessionDependentContext`, `appendInputIntent`, `hostSessionsCreateOrLoadChannel.binding.call`)
are authoritative — grep them to locate the cited behavior. Line numbers are
best-effort convenience pointers; in an actively-edited file they lag, so when a
number and a symbol disagree, trust the symbol. The rows that THIS PR changed
(the bounded session-dependent barrier) carry head-accurate lines.

Legend:

- **A already blocking/reflection-owned**: the operation waits for reflected
  state, or is an observation/snapshot read over reflected state.
- **B intentionally async/request-ack**: the operation returns a durable
  append/request receipt; terminal/reflected outcome is observed separately.
- **C missing sync handshake**: no entries remain after this PR.
- **D redundant explicit barrier API**: the explicit barrier is compatibility
  surface, no longer required as pre-write ceremony for normal dependent
  prompt/start paths.

| Operation / binding | Class | Source evidence | Test evidence | Rationale |
|---|---:|---|---|---|
| `firegrid.launch` / `HostContextsCreateChannel` | B | Client writes through `hostContextsCreateChannel.binding.call` then returns `open(contextId)` (`packages/client-sdk/src/firegrid.ts:1014`, `:1016`, `:1023`). Binding calls `requestRuntimeContextCreate` (`packages/protocol/src/launch/host-control-request.ts:91`, `:101`). The helper inserts `contextRequests` and returns `{sessionId, contextId}` without reading `contexts.rows()` (`packages/protocol/src/launch/host-context-request-binding.ts:20`, `:28`, `:35`). | The new dependent prompt test launches, starts `firegrid.prompt` before materialization, then materializes and proves the dependent write completes (`packages/client-sdk/test/firegrid.sessions.test.ts:478`, `:494`, `:500`, `:509`). | Launch is identity/request acknowledgement. It does not block every caller until host materialization; dependent writes own the wait. |
| `firegrid.prompt` / `HostPromptChannel` | A | Top-level prompt decodes, waits via `awaitSessionDependentContext(decoded.contextId)`, then appends through `HostPromptChannel` (`packages/client-sdk/src/firegrid.ts`, `prompt` at `:1025`). `awaitSessionDependentContext` is the **shared bounded barrier** (`packages/client-sdk/src/firegrid.ts:772`): it waits on `waitUntilContextReady` (`HostContextsChannel.binding.stream`, `:758`) under `Effect.timeoutOption(config.contextReflectionTimeoutMs)` (default 30s), and on timeout does one authoritative `control.contexts.get`, failing with `ContextNotFound` (wrapped in `AppendError`) if the context is absent. The append binding independently enforces existence via `appendInputIntent` before `inputIntents.insertOrGet` (`packages/protocol/src/launch/host-control-request.ts:62`, `:67`, `:72`). | Closure test forks `firegrid.prompt` before materialization, materializes later, observes a stored prompt intent. Bounded-error test drives an unknown context id with a short reflection window and asserts a bounded `AppendError`/`ContextNotFound`, not a hang (`packages/client-sdk/test/firegrid.sessions.test.ts`, "firegrid.prompt for an unknown context id errors (bounded)"). | This was the live gap. It is now closed with the shared dependent-operation barrier, explicitly **bounded** so invalid ids surface `ContextNotFound` rather than hanging forever. |
| `firegrid.sessions.createOrLoad` / `HostSessionsCreateOrLoadChannel` | B | Client calls `hostSessionsCreateOrLoadChannel.binding.call` then returns a handle (`packages/client-sdk/src/firegrid.ts:969`, `:979`, `:998`). Binding is explicitly annotated `binding_pattern=request-row-only` (`packages/protocol/src/launch/host-session-create-or-load-request.ts:31`, `:36`). | Idempotency test proves create/load returns deterministic identity and writes one request row (`packages/client-sdk/test/firegrid.sessions.test.ts:287`, `:300`, `:323`). | Identity-only create/load callers are not handshakes. The SDD now says dependent operations own reflected-context waits when they need the row. |
| `session.prompt` handle method / `SessionPromptChannel` | A | Handle prompt decodes, then calls the shared bounded `awaitSessionDependentContext(sessionId)` before appending (`packages/client-sdk/src/firegrid.ts:933`, `:772`). | Barrier test forks prompt before materialization, materializes later, and succeeds without `whenReady`. Bounded-error test attaches an unknown session id and asserts `session.prompt` fails bounded with `ContextNotFound`, not a hang (`packages/client-sdk/test/firegrid.sessions.test.ts`, "session.prompt for an unknown context id errors (bounded)"). | This is the shipped `tf-lf9p` production slice for prompt-after-create, now with the same bounded barrier as `firegrid.prompt`. |
| `firegrid.sessions.prompt` tool-shaped client projection | A | Top-level session prompt waits on the shared bounded `awaitSessionDependentContext(decoded.sessionId)` before appending (`packages/client-sdk/src/firegrid.ts:1037`, `:772`). | Test proves it preserves the ok output and stores the durable receipt. Bounded-error test asserts an unknown session id fails bounded with `ContextNotFound`, not a hang (`packages/client-sdk/test/firegrid.sessions.test.ts`, "firegrid.sessions.prompt for an unknown context id errors (bounded)"). | Same bounded barrier as session handle prompt, with tool-shaped output preserved. |
| `session.start` / `HostSessionsStartChannel` | A for context reflection, B for run outcome | `session.start` waits on the shared bounded `awaitSessionDependentContext` before calling `HostSessionsStartChannel` (`packages/client-sdk/src/firegrid.ts:945`, `:772`). The binding writes `startRequests.insertOrGet` and returns a `RuntimeStartRequestAck` (`packages/protocol/src/launch/host-control-request.ts:143`, `:160`, `:161`); it does **not** itself check context existence, so the bounded barrier is the only guard against an orphan start-request row for an id that never materializes. Start request schema states it is not a synchronous run result (`packages/protocol/src/launch/control-request.ts:115`, `:128`, `:130`). | Test forks start before materialization, materializes later, then observes the ack and stored request row. Bounded-error test attaches an unknown session id and asserts `session.start` fails bounded with `ContextNotFound` AND writes no orphan start-request row (`packages/client-sdk/test/firegrid.sessions.test.ts`, "session.start for an unknown context id errors (bounded) without an orphan start request"). Protocol test asserts start request rows are durable asks, not run results (`packages/protocol/test/launch/control-request.test.ts:44`, `:55`, `:94`). | Context reflection is owned by the dependent operation and bounded; runtime execution completion stays async and observable through run/output projections. |
| `session.whenReady` | D | The handle still exposes `whenReady` and implements it as `waitUntilContextReady(sessionId)` (`packages/client-sdk/src/firegrid.ts:928`). Dependent prompt/start now call the shared bounded barrier internally (`awaitSessionDependentContext`, `:772`). `whenReady` itself is an **explicit, intentionally unbounded** readiness wait — the caller opted in to "block until ready" — so it is not bounded by `contextReflectionTimeoutMs`. | `whenReady` still works as a projection wait, while prompt no longer needs it. | Redundant as pre-write ceremony for prompt/start. It remains safe as an explicit readiness/projection helper; removal/deprecation is API cleanup, tracked by a follow-up bead (see Closure Plan §4), not a blocking semantic gap. **Resolved by tf-2osu: `whenReady` was DELETED from the public surface (it leaked substrate materialization as a caller ceremony). Readiness was pushed into the operations that need it — prompt/start (the #587 barrier), snapshot, the wait/observe reads, and the CLI host ops — each owning a bounded internal `awaitContextMaterialized` barrier. Subsumes the absent-id floor (tf-5sb7, closed): no public `whenReady` means no unbounded readiness wait.** |
| `firegrid.sessions.attach` | A | Attach decodes a session id and returns a scoped handle without writing a request row (`packages/client-sdk/src/firegrid.ts:1004`, `:1006`, `:1007`). The returned handle's dependent writes own the (bounded) context readiness barrier (`packages/client-sdk/src/firegrid.ts:933`, `:945`, `:772`). | Attach test scopes snapshot/wait/start to the session id (`packages/client-sdk/test/firegrid.sessions.test.ts:337`, `:349`, `:370`). Start barrier test exercises attached start before materialization (`packages/client-sdk/test/firegrid.sessions.test.ts:995`, `:1011`, `:1016`). | Attach is not a request-row operation; the relevant reflection boundary is in handle operations. |
| `session.snapshot`, `firegrid.open(...).snapshot`, host snapshot channels | A | Client snapshot reads current `contexts`, `runs`, and output rows (`packages/client-sdk/src/firegrid.ts:598`, `:602`, `:620`, `:630`). Host-sdk snapshot channels are callable direct queries over `snapshotForContext`, not request rows (`packages/host-sdk/src/host/channels/host-control/index.ts:147`, `:153`, `:157`, `:162`). | Attach/snapshot test proves snapshot observes the reflected agent output (`packages/client-sdk/test/firegrid.sessions.test.ts:337`, `:370`, `:386`). | Snapshot is a read of reflected state; no request/ack closure needed. |
| `session.wait.forAgentOutput`, `session.wait.forPermissionRequest` | A | Wait helpers run `Stream.runHead` over the session agent-output channel/projection, with optional timeout (`packages/client-sdk/src/firegrid.ts:654`, `:672`, `:680`, `:691`; permission filter at `:718`, `:727`). | Snapshot/wait test proves the next output waits and returns normalized projection (`packages/client-sdk/test/firegrid.sessions.test.ts:628`, `:640`, `:659`). Permission wait test proves it ignores non-permission output then matches permission output (`packages/client-sdk/test/firegrid.sessions.test.ts:730`, `:742`, `:772`). | These are explicit blocking observation waits over reflected durable output, not request-row handshakes. |
| Agent `send` tool | B | `send` requires an egress channel, decodes the payload, and delegates to `RuntimeAgentToolExecution.send` with the channel append effect (`packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:408`, `:418`, `:430`, `:435`). | Tool test proves `send` returns `{sent:true}` only after the registered append effect runs, and rejects ingress-only channels (`packages/host-sdk/test/agent-tools/tool-use-to-effect.test.ts:479`, `:504`, `:509`, `:512`, `:533`). | This locks async mailbox send semantics: durable append/receipt, no response handshake. |
| Agent `wait_for` / `wait_for_any` tools | A | `wait_for` resolves a registered ingress/bidirectional channel into a durable wait execution (`packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:336`, `:345`, `:361`). `wait_for_any` builds ingress waits and races them through `RuntimeAgentToolExecution.waitForAny` (`packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:479`, `:493`, `:512`, `:534`). | Tests cover deterministic timeout, later-row match, and first-winner `wait_for_any` behavior (`packages/host-sdk/test/agent-tools/tool-use-to-effect.test.ts:320`, `:334`, `:408`, `:424`, `:433`, `:567`, `:602`). | This locks async mailbox observation: waits observe durable rows and timeout/race deterministically. |
| `session.permissions.respond` / `firegrid.permissions.respond` / `HostPermissionRespondChannel` | B | Session-scoped respond calls `HostPermissionRespondChannel` with the handle's context id (`packages/client-sdk/src/firegrid.ts:853`, `:864`). Top-level respond does the same with request context id (`packages/client-sdk/src/firegrid.ts:1018`, `:1021`, `:1022`). Binding verifies context, appends a required-action-result intent, and returns `{responded,inputId}` (`packages/protocol/src/launch/host-control-request.ts:178`, `:197`, `:201`, `:205`). | Session permission-response test proves durable input intent is appended (`packages/client-sdk/test/firegrid.sessions.test.ts:791`, `:799`, `:811`). Nonexistent-context regression proves no orphan receipt is minted (`packages/client-sdk/test/firegrid.sessions.test.ts:830`, `:854`, `:881`). Auto-approve tests prove downstream policy can wait and respond through this ack path (`packages/client-sdk/test/firegrid.sessions.test.ts:885`, `:922`, `:927`). | Permission response is producer-side acceptance evidence. The runtime consumes it asynchronously; terminal consequences are observed through permission/output/run projections. |
| Agent `session_new` tool / child context spawn | A | Host inserts a local child context, appends initial prompt, requires the local context, and starts the child workflow before returning running status (`packages/host-sdk/src/host/agent-tool-host-live.ts:208`, `:223`, `:228`, `:238`, `:239`). | Prompt-routing integration covers live `session_new` child start and initial prompt reconciliation (`packages/host-sdk/test/host/prompt-routing.test.ts:326`). | This host-local tool already owns its setup barrier. It is not the client request-row path. |
| Agent `session_prompt` tool | B | Tool lowers to `host.appendSessionPrompt` and returns `{appended,inputId}` (`packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:651`, `:659`, `:665`). Host append uses the host-owned ingress path and discards the receipt (`packages/host-sdk/src/host/agent-tool-host-live.ts:352`, `:354`, `:362`). | Tool test proves lowering to host append and ok output (`packages/host-sdk/test/agent-tools/tool-use-to-effect.test.ts:688`, `:704`, `:716`, `:721`). | Agent prompt send is intentionally async append/receipt semantics. The agent can wait separately if it needs output. |
| Agent `session_cancel` / `session_close` lifecycle tools | B | Tool lowering delegates to host lifecycle operations and returns `{cancelled}` / `{closed}` after the request append (`packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:672`, `:676`, `:680`, `:684`). Host writes committed lifecycle request rows (`packages/host-sdk/src/host/agent-tool-host-live.ts:374`, `:381`, `:396`; append at `:459`, `:477`). Schema says lifecycle rows are not synchronous terminal results (`packages/protocol/src/launch/control-request.ts:136`, `:139`, `:141`). | Existing tests prove explicit failure when no lifecycle primitive is available (`packages/host-sdk/test/agent-tools/tool-use-to-effect.test.ts:728`, `:740`, `:746`, `:758`). Reconciler tests prove lifecycle/start request processing and completion rows generally stay host-owned (`packages/host-sdk/test/host/control-request-reconciler.test.ts:228`, `:262`). | Cancel/close stay async request-ack; terminal state is observed through lifecycle/run projections. |
| Agent `schedule_me` | B | Schedules delayed `host.appendSessionPrompt` and returns scheduled evidence (`packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:711`, `:726`, `:732`, `:738`). | Tool test proves scheduled output and eventual host prompt append (`packages/host-sdk/test/agent-tools/tool-use-to-effect.test.ts:800`, `:827`, `:832`, `:834`). | Scheduling is durable async enqueue; no immediate result handshake is implied. |

## Closure Plan

1. **Implemented in this PR: top-level prompt reflection barrier + shared
   bounded barrier.** `firegrid.prompt` now waits for reflected context state
   before `HostPromptChannel` append, via the shared
   `awaitSessionDependentContext` helper. That helper is now **bounded** by
   `config.contextReflectionTimeoutMs` (default 30s): a real in-flight context
   materializes within the window, but an unknown/typo context id never
   materializes, so on timeout the barrier does one authoritative
   `control.contexts.get` and fails with `ContextNotFound` (wrapped in
   `AppendError`) if absent — rather than hanging indefinitely. Because the
   barrier is shared, the bound covers **all four** session-dependent writes
   (`firegrid.prompt`, `firegrid.sessions.prompt`, `session.prompt`,
   `session.start`); `session.start` especially relies on it because its
   binding has no append-side existence check (no orphan start row). Focused
   tests cover the happy-path barrier (`launch -> firegrid.prompt` without
   explicit `whenReady`) AND a bounded-error test per path for an unknown id.

2. **Locked in this PR: async mailbox semantics.** Agent `send` remains
   egress append/receipt; `wait_for` and `wait_for_any` remain durable
   observation waits over registered ingress rows. Existing focused tests cover
   durable append, direction rejection, deterministic timeout, later-row match,
   and first-winner racing.

3. **Corrected in this PR: SDD production wording.** The SDD now states the
   production rule: do not make identity-only `createOrLoad` globally
   blocking; put the reflection barrier in the dependent operation when that
   operation needs reflected context state.

4. **Semantic closure is complete; one deferred API-cleanup is tracked by a
   blocking follow-up bead.** The C-class set is empty — no operation is left
   without its handshake/async classification. The single deferred item is the
   Class-D `session.whenReady` deprecation/removal: it is **not** a half-shipped
   sync/async semantic (the bounded barrier now lives in the dependent writes),
   but it is redundant pre-write ceremony whose removal is a separate
   API-compat decision. Per the transactional cutover rule, it is captured as
   **`tf-2osu`** (follow-up to `tf-1r3h`) rather than left as a prose note, so
   the deferral cannot be silently dropped.

## Bottom Line

The durable sync/async axis is now production-closed for the public operations
enumerated here. Sync handshakes live in dependent operations whose next write
requires reflected context; async mailbox operations return durable
append/request evidence and use explicit wait surfaces for later observation.
