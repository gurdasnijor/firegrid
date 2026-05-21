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
| `firegrid.launch` / `HostContextsCreateChannel` | B | Client writes through `hostContextsCreateChannel.binding.call` then returns `open(contextId)` (`packages/client-sdk/src/firegrid.ts:970`, `:976`, `:983`). Binding calls `requestRuntimeContextCreate` (`packages/protocol/src/launch/host-control-request.ts:91`, `:101`). The helper inserts `contextRequests` and returns `{sessionId, contextId}` without reading `contexts.rows()` (`packages/protocol/src/launch/host-context-request-binding.ts:20`, `:28`, `:35`). | The new dependent prompt test launches, starts `firegrid.prompt` before materialization, then materializes and proves the dependent write completes (`packages/client-sdk/test/firegrid.sessions.test.ts:478`, `:494`, `:500`, `:509`). | Launch is identity/request acknowledgement. It does not block every caller until host materialization; dependent writes own the wait. |
| `firegrid.prompt` / `HostPromptChannel` | A | Top-level prompt decodes, waits via `awaitSessionDependentContext(decoded.contextId)`, then appends through `HostPromptChannel` (`packages/client-sdk/src/firegrid.ts:985`, `:988`, `:989`). The wait lowers to `HostContextsChannel.binding.stream` (`packages/client-sdk/src/firegrid.ts:744`, `:751`, `:758`). The append binding still enforces context existence before `inputIntents.insertOrGet` (`packages/protocol/src/launch/host-control-request.ts:62`, `:67`, `:72`). | New closure test forks `firegrid.prompt` before context materialization, materializes later, and observes a stored prompt intent (`packages/client-sdk/test/firegrid.sessions.test.ts:478`, `:494`, `:500`, `:509`, `:515`). Receipt test still proves returned row equals stored row (`packages/client-sdk/test/firegrid.sessions.test.ts:437`, `:447`, `:475`). | This was the live gap. It is now closed with the same dependent-operation barrier used by session-scoped prompt. |
| `firegrid.sessions.createOrLoad` / `HostSessionsCreateOrLoadChannel` | B | Client calls `hostSessionsCreateOrLoadChannel.binding.call` then returns a handle (`packages/client-sdk/src/firegrid.ts:921`, `:939`, `:958`). Binding is explicitly annotated `binding_pattern=request-row-only` (`packages/protocol/src/launch/host-session-create-or-load-request.ts:31`, `:36`). | Idempotency test proves create/load returns deterministic identity and writes one request row (`packages/client-sdk/test/firegrid.sessions.test.ts:287`, `:300`, `:323`). | Identity-only create/load callers are not handshakes. The SDD now says dependent operations own reflected-context waits when they need the row. |
| `session.prompt` handle method / `SessionPromptChannel` | A | Handle prompt decodes, then calls `awaitSessionDependentContext(sessionId)` before appending (`packages/client-sdk/src/firegrid.ts:893`, `:898`, `:903`). The barrier is `waitUntilContextReady` over `HostContextsChannel.binding.stream` (`packages/client-sdk/src/firegrid.ts:744`, `:751`, `:758`). | Barrier test forks prompt before materialization, materializes later, and succeeds without `whenReady` (`packages/client-sdk/test/firegrid.sessions.test.ts:561`, `:572`, `:577`, `:583`). Stored-row receipt test proves the append lands as the expected durable intent (`packages/client-sdk/test/firegrid.sessions.test.ts:398`, `:417`, `:434`). | This is the shipped `tf-lf9p` production slice for prompt-after-create. |
| `firegrid.sessions.prompt` tool-shaped client projection | A | Top-level session prompt waits on `awaitSessionDependentContext(decoded.sessionId)` before appending (`packages/client-sdk/src/firegrid.ts:994`, `:997`, `:998`, `:1004`). | Test proves it preserves the ok output and stores the durable receipt (`packages/client-sdk/test/firegrid.sessions.test.ts:522`, `:533`, `:543`, `:545`). | Same barrier as session handle prompt, with tool-shaped output preserved. |
| `session.start` / `HostSessionsStartChannel` | A for context reflection, B for run outcome | `session.start` waits on `awaitSessionDependentContext` before calling `HostSessionsStartChannel` (`packages/client-sdk/src/firegrid.ts:905`, `:910`, `:911`). The binding writes `startRequests.insertOrGet` and returns a `RuntimeStartRequestAck` (`packages/protocol/src/launch/host-control-request.ts:143`, `:160`, `:161`). Start request schema states it is not a synchronous run result (`packages/protocol/src/launch/control-request.ts:115`, `:128`, `:130`). | Test forks start before materialization, materializes later, then observes the ack and stored request row (`packages/client-sdk/test/firegrid.sessions.test.ts:995`, `:1014`, `:1016`, `:1028`). Protocol test asserts start request rows are durable asks, not run results (`packages/protocol/test/launch/control-request.test.ts:44`, `:55`, `:94`). | Context reflection is already owned by the dependent operation. Runtime execution completion stays async and observable through run/output projections. |
| `session.whenReady` | D | The handle still exposes `whenReady` (`packages/client-sdk/src/firegrid.ts:180`, `:183`) and implements it as `waitUntilContextReady(sessionId)` (`packages/client-sdk/src/firegrid.ts:887`, `:888`, `:892`). Dependent prompt/start now call the same barrier internally (`packages/client-sdk/src/firegrid.ts:898`, `:910`). | `whenReady` still works as a projection wait (`packages/client-sdk/test/firegrid.sessions.test.ts:596`, `:607`, `:620`), while prompt no longer needs it (`packages/client-sdk/test/firegrid.sessions.test.ts:561`, `:572`, `:583`). | Redundant as pre-write ceremony for prompt/start. It remains safe as an explicit readiness/projection helper; removal/deprecation is API cleanup, not a blocking semantic gap. |
| `firegrid.sessions.attach` | A | Attach decodes a session id and returns a scoped handle without writing a request row (`packages/client-sdk/src/firegrid.ts:961`, `:966`, `:967`). The returned handle's dependent writes own context readiness (`packages/client-sdk/src/firegrid.ts:898`, `:910`). | Attach test scopes snapshot/wait/start to the session id (`packages/client-sdk/test/firegrid.sessions.test.ts:337`, `:349`, `:370`). Start barrier test exercises attached start before materialization (`packages/client-sdk/test/firegrid.sessions.test.ts:995`, `:1011`, `:1016`). | Attach is not a request-row operation; the relevant reflection boundary is in handle operations. |
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

1. **Implemented in this PR: top-level prompt reflection barrier.**
   `firegrid.prompt` now waits for reflected context state before
   `HostPromptChannel` append. The focused test covers `launch ->
   firegrid.prompt` without explicit `whenReady`.

2. **Locked in this PR: async mailbox semantics.** Agent `send` remains
   egress append/receipt; `wait_for` and `wait_for_any` remain durable
   observation waits over registered ingress rows. Existing focused tests cover
   durable append, direction rejection, deterministic timeout, later-row match,
   and first-winner racing.

3. **Corrected in this PR: SDD production wording.** The SDD now states the
   production rule: do not make identity-only `createOrLoad` globally
   blocking; put the reflection barrier in the dependent operation when that
   operation needs reflected context state.

4. **No blocking follow-up bead required for semantic closure.** The C-class
   set is empty. `session.whenReady` remains a redundant compatibility/readiness
   helper and can be deprecated in a separate API-cleanup slice, but it is not
   a half-shipped sync/async semantic.

## Bottom Line

The durable sync/async axis is now production-closed for the public operations
enumerated here. Sync handshakes live in dependent operations whose next write
requires reflected context; async mailbox operations return durable
append/request evidence and use explicit wait surfaces for later observation.
