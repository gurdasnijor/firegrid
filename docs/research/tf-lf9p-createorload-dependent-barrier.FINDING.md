# tf-lf9p: createOrLoad dependent-operation barrier

Verdict: **Fork 2 implemented** - `createOrLoad` keeps returning the
deterministic session identity immediately, while dependent operations that
need a materialized context wait for reflected `RuntimeContext` projection
state internally.

## Caller Audit

- **Category A: production host/reconciler callers.** CLI and tiny-firegrid
  runnable paths already run a host reconciler and commonly call
  `session.whenReady` before prompt/start. Fork 2 is compatible; `whenReady`
  remains valid and redundant on those paths.
- **Category B: identity-only callers.** Fire-and-forget find-or-create callers
  that consume only `.contextId` intentionally rely on deterministic identity,
  not reflected context state. Fork 2 preserves that use; these callers are not
  sync handshakes by the "answer gates the next step" rule.
- **Category C: client-sdk harnesses.** Unit tests that manually materialize the
  context after `createOrLoad` no longer deadlock because `createOrLoad` is not
  the barrier. Only dependent operations that ran before manual materialization
  needed restructuring.

## Implemented Barrier

`firegrid-session-fact-client-surfaces.CLIENT_SESSION.6-2`

The client session facade now waits on the existing `HostContextsChannel`
projection before:

- scoped `session.prompt(...)`
- top-level `firegrid.sessions.prompt(...)`
- scoped `session.start()`

This preserves the request-row/control-plane dispatcher substrate and adds no
public verb or new channel abstraction. `session.whenReady` remains available as
an explicit compatibility/readiness effect.

## Follow-Up Candidates

- **`HostContextsCreateChannel` / `firegrid.launch`.** Same request-row then
  context-reflection shape as `createOrLoad`; assess whether launch callers need
  a dependent-operation barrier or whether returned identity remains sufficient.
- **`HostSessionsStartChannel`.** This slice waits for context reflection before
  writing a start request. It does not change whether `start` should later wait
  for run-row or terminal start evidence.
- **Prompt egress return.** `session.prompt` still uses the local input-intent
  helper because prompt egress channels return `void`; tf-fyyk owns the
  egress-return decision.
