# FINDING — tf-trc: residual trace-graph defects post-#431 integration

Three observability defects observed in live trace of the post-merge
`origin/main` (commit `8647705f6`) running `codex-acp-tool-calls` for 90s.
PR #431 closed the load-bearing items A/B/C/D/E/G; this finding catalogs
what the integration trace shows still needs work, with root-cause analysis
where reached and proposed fixes.

Trace artifact:
`packages/firelab/.simulate/runs/2026-05-20T00-00-43-070Z__codex-acp-tool-calls/trace.jsonl`
(4017 spans).

## 1. 98/425 `wait_router.complete_match` parents reference unexported spans

### Evidence

```bash
jq -r 'select(.name == "firegrid.durable_tools.wait_router.complete_match") | .parentSpanId' $TRACE \
  | sort -u | while read pid; do
    if ! grep -q "\"spanId\":\"$pid\"" $TRACE; then echo "$pid not in file"; fi
  done | wc -l
# → ~14 distinct orphan parent IDs, accounting for 98 of 425 complete_match spans
```

Of 425 `wait_router.complete_match` spans:
- 23 parented to in-file `wait_router.initial_check` (correct, internal-only path)
- **402 parented to a span ID not present in the trace file** (queue carrier
  references a `_otel.traceparent` whose source span was never exported)

Each orphan parent ID is shared by multiple `complete_match` instances
(2–12), so the IDs cluster per-row — each agent-output row stamps one
producer span ID and all waits matching that row reference it.

### Root cause (proposed)

Agent-output rows get `_otel` stamped via `stampRowOtel(row)` at the row
write site. `stampRowOtel` captures `Effect.currentSpan` — the innermost
active span at producer time. For agent-output writes, that producer site
sits inside a long-lived scope (e.g. the per-context workflow output handler
or the ACP codec's session-update callback), wrapped in an outer
`Effect.withSpan(...)` that **stays open for the duration of the session**.

A span that's still open at trace-collection time has not been pushed
through `BatchSpanProcessor`. When the run interrupts on
`SimulationTimeout` at 90s, the open parent spans are interrupted but the
exporter shutdown does not reliably flush them. Their IDs survive in the
row carriers; the consumers' `complete_match` spans dereference IDs that
never made it to disk.

Cross-check: on a fully-completed run (no timeout), these spans WOULD
likely export at scope end and the trace would be fully connected. We
haven't verified that yet because codex-acp doesn't complete fast enough
for the simulation's deadline.

### Proposed fix

Two options, complementary:

1. **Producer-side**: at the agent-output write site, wrap the write in a
   short-lived `Effect.withSpan("firegrid.runtime_context.workflow.output.write", { kind: "producer" })`
   so `Effect.currentSpan` returns a span that ends as the write returns
   (within milliseconds). That span flushes promptly via BatchSpanProcessor
   even on simulation-timeout interrupts.

2. **Shutdown discipline**: ensure the OTel SDK's `forceFlush` is awaited on
   simulation shutdown. The runner's scope finalizer should explicitly
   `forceFlush` before the BatchSpanProcessor's batch interval elapses, so
   in-flight spans on open parents land in the file.

Likely fix site: `packages/host-sdk/src/host/runtime-context-workflow-core.ts`
(the `firegrid.runtime_context.workflow.output.handle` span at line ~447 is
the parent — wrap the row insert it does inside its execution body in its
own producer span).

## 2. 11 ACP codec callback spans share one phantom parent

### Evidence

```bash
jq -r 'select(.name | startswith("firegrid.agent_event_pipeline.acp.")) | .parentSpanId' $TRACE | sort | uniq -c
#  11 269f3eff6b0fbb3f   ← phantom: not in file
#   1 <none>             ← acp.exit (correctly a root)
```

All 11 `session_update` consumer spans, plus `acp.initialize` and
`codec.sdk.call`, parent to the same spanId `269f3eff6b0fbb3f` which is not
present anywhere in the trace file.

### Root cause

Same family as #1, but on the ACP-callback path:

```ts
// packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts
const runtime = yield* Effect.runtime<never>()
const runPromise = Runtime.runPromise(runtime)
// ... runtime is captured INSIDE Layer.scoped(AgentSession, ...) which
// stays open for the entire session lifetime ...
sessionUpdate: async params => {
  await runPromise(
    mapSessionUpdate(params, textDeltaId).pipe(
      Effect.withSpan("firegrid.agent_event_pipeline.acp.session_update", {
        kind: "consumer",
        // (no `root: true` — inherits OTel active context from captured runtime)
      }),
    ),
  )
},
```

`Effect.runtime<never>()` captures the fiber's OTel context. That context's
active span is the outer scope wrapping `AcpSessionLive` setup — same
long-lived parent that's open for the whole session and not yet exported.
Every `runPromise` callback inherits this captured span as its parent.

### Attempted fix and why it was wrong

Marking the callback spans `root: true` eliminates the phantom parent but
**fragments the trace**: each callback becomes a new trace root with a new
traceId. Verified empirically: with `root: true` on `session_update` and
`permission_request`, the trace went from `traces: 1` (correct) to
`traces: 26` (broken). The cure was worse than the disease.

### Proposed fix

Same shape as #1's option 1: wrap the long-lived `AcpSessionLive` outer
gen in an explicit `Effect.withSpan("firegrid.agent_event_pipeline.acp.session", { kind: "internal" })`
whose ID gets captured by `Effect.runtime`. Then EITHER:

- Close that span at session-handle creation (so it ends in milliseconds,
  flushes, and is a real exported span — callbacks parent to it correctly);
- OR end it at session shutdown (so it's open during the session but flushes
  on scope release). Combined with shutdown `forceFlush`, this gives a
  connected trace on both completed and timed-out runs.

## 3. MCP HTTP well-known OAuth 404 spans report `status.code=2`

### Evidence

```bash
jq -c 'select(.status.code == 2 and (.name | startswith("firegrid.mcp.http")))' $TRACE
# {"name":"firegrid.mcp.http GET /runtime-context/:contextId","message":"GET /.well-known/oauth-authorization-server/mcp/runtime-context/<ctx>/ not found"}
# {"name":"firegrid.mcp.http GET /runtime-context/:contextId","message":"GET /mcp/runtime-context/<ctx>/.well-known/oauth-authorization-server not found"}
# {"name":"firegrid.mcp.http GET","message":"GET /.well-known/oauth-authorization-server not found"}
```

Three spans flagged as errored in the trace (inflating the `errored: 14`
count by 3 spurious entries). Each is a standard MCP/ACP discovery probe
for OAuth configuration on a server that does not advertise OAuth — the
404 is the *expected* answer, not an application error.

### Root cause

The HttpRouter wraps each route in a span; missing routes raise NotFound
effectfully, which marks the span `code=Error`. The 404 status is
semantically correct at the HTTP layer; what's wrong is the *trace status*
treating a documented protocol negotiation outcome as an error.

### Proposed fix

Either:

- At the MCP HTTP layer (`packages/host-sdk/src/host/mcp-host.ts`),
  short-circuit `/.well-known/oauth-authorization-server` paths to return
  a 404 *response* without raising the route-not-found error. The trace
  status stays OK; the HTTP response stays 404.
- Or, at the OTel side, downgrade `status.code` for `.well-known` 404s in
  a span-processor onEnd hook.

Option 1 is the right shape (treat protocol-negotiation 404s as expected
outcomes at the route layer). Option 2 is a workaround.

## Triage

| # | Category | Severity | Owner |
|---|---|---|---|
| 1 | cat-2 (impl gap — producer scope not flushable) | high — affects ~25% of consumer spans | host-sdk + runtime |
| 2 | cat-2 (impl gap — same root as #1, ACP variant) | medium — affects all codec callbacks | runtime/agent-event-pipeline |
| 3 | cat-2 (impl gap — error-status pollution) | low — cosmetic, 3 spans | host-sdk |

#1 and #2 share a root cause: **producer spans wrapping long-lived scopes
don't flush in time, breaking queue-context propagation.** A single
shutdown-flush fix on the runner side combined with producer-span
shortening at the two write sites would close both. The right next move
is a small SDD discussion of "producer span lifetime discipline" rather
than three independent patches.

Run-provenance from this finding's trace:
- `firegrid.git.commit`: `8647705f6aebe0055e81a0bcb7ce77fb621732bf`
- `firegrid.git.branch`: `main` (at time of capture; integration was just merged)
- `firegrid.firelab.version`: `0.0.0`
