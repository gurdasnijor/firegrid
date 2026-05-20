# FINDING - workflow-core WaitFor paths empirical baseline

Bead: `tf-9ut` · run: `2026-05-20T04-41-55-047Z__workflow-core-paths`

Trace artifact:
`packages/tiny-firegrid/.simulate/runs/2026-05-20T04-41-55-047Z__workflow-core-paths/trace.jsonl`

This is a measurement artifact, not a Shape A decision. The sim exists at
`packages/tiny-firegrid/src/simulations/workflow-core-paths/` and is listed by
`simulate:list`. Its host pre-seeds one caller-owned fact source
(`host.ts:20-22`, `host.ts:72-86`) and exposes it through
`CallerOwnedFactStreams` (`host.ts:88-95`). Its driver launches real
`claude-agent-acp@0.36.1` (`driver.ts:18-22`), prompts exactly one `wait_for`
CallerFact query (`driver.ts:24-45`), and polls `session.wait.forAgentOutput`
with `afterSequence` (`driver.ts:94-130`).

## Observability re-baseline

Do **not** use raw `firegrid.durable_tools.wait_router.complete_match` as
"successful wait completions." Source shows the span wraps the whole candidate
row evaluation: the span starts before `evaluateFieldEquals` (`wait-router.ts:178`)
and only emits `wait.satisfied` after the trigger matched, `deferredDone` ran,
and status was written completed (`wait-router.ts:201-220`). Therefore this
doc uses:

- `complete_match` count = candidate evaluation pressure.
- `complete_match` spans containing a `wait.satisfied` event = actual wait
  completions.

Raw `complete_match` orphan profile is still useful for graph health, but it
inflates the completion-specific orphan number. On current `main` after #445,
the orphan-parent class itself is gone for this sim: raw `complete_match` and
completion-only `complete_match` are both 0% orphaned. The pre-#445 halt trace
that showed `108/119` raw orphaned and `6/14` completion-only orphaned should
be treated as stale baseline evidence for the fixed observability bug, not as
the current Shape A input.

```bash
TRACE=packages/tiny-firegrid/.simulate/runs/2026-05-20T04-41-55-047Z__workflow-core-paths/trace.jsonl

jq -rs '
  map(select(.name=="firegrid.durable_tools.wait_router.complete_match"))
  | {
      total:length,
      satisfied:(map(select((.events // []) | any(.name=="wait.satisfied")))|length),
      by_source:(group_by(.attributes["firegrid.wait.source"])
        | map({source:.[0].attributes["firegrid.wait.source"],
               total:length,
               satisfied:(map(select((.events // []) | any(.name=="wait.satisfied")))|length)}))
    }
' "$TRACE"
# total=125, satisfied=18
# AgentOutputAfter total=123, satisfied=16
# CallerFact total=2, satisfied=2
```

Equivalent DuckDB sketch:

```sql
CREATE TABLE spans AS
SELECT * FROM read_json_auto('packages/tiny-firegrid/.simulate/runs/2026-05-20T04-41-55-047Z__workflow-core-paths/trace.jsonl');

SELECT
  attributes['firegrid.wait.source'] AS source,
  count(*) AS complete_match_total,
  count_if(list_contains(list_transform(events, e -> e.name), 'wait.satisfied')) AS satisfied
FROM spans
WHERE name = 'firegrid.durable_tools.wait_router.complete_match'
GROUP BY 1;
```

## Run summary

`simulate:perf` reported 3,330 spans over a 14.147s window. Top self-time was
durable table row streaming (`firegrid.durable_table.rows` at 6,117ms and
3,354ms) followed by one workflow engine execution span at 2,130ms. HTTP rolls
were dominated by `POST /mcp/runtime-context/:contextId` (7 spans / 291.2ms).
Idle gaps above 1,000ms were 4,004ms, 1,251ms, 1,013ms, and 1,341ms.

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:perf \
  2026-05-20T04-41-55-047Z__workflow-core-paths \
  --top 5 --idle-threshold-ms 1000
```

## Did both WaitFor.match paths fire?

Yes.

Trace counts:

```bash
jq -r '.name' "$TRACE" \
  | sort | uniq -c | sort -nr \
  | rg 'wait_for.match|runtime_context.workflow.output.wait|wait_router.complete_match|wait_router.initial_check|wait_router.start'
# 148 firegrid.durable_tools.wait_for.match
# 146 firegrid.runtime_context.workflow.output.wait
# 125 firegrid.durable_tools.wait_router.complete_match
#  18 firegrid.durable_tools.wait_router.initial_check
#   2 firegrid.durable_tools.wait_router.start
```

Wait names by source:

```bash
jq -r '
  select(.name=="firegrid.durable_tools.wait_for.match")
  | [.attributes["firegrid.wait.source"], .attributes["firegrid.wait.name"]]
  | @tsv
' "$TRACE" | sort -u | awk -F'\t' '{count[$1]++} END{for (k in count) print count[k], k}'
# 14 AgentOutputAfter
# 1 CallerFact
```

Source citations:

- Runtime-context output wait call site:
  `packages/host-sdk/src/host/runtime-context-workflow-core.ts:188-211`.
- Agent-tool `wait_for` lowering call site:
  `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:172-252`.

DuckDB equivalent:

```sql
SELECT attributes['firegrid.wait.source'] AS source,
       count(DISTINCT attributes['firegrid.wait.name']) AS wait_names
FROM spans
WHERE name = 'firegrid.durable_tools.wait_for.match'
GROUP BY 1;
```

## Per-wait lifecycle

CallerFact tool wait:

```bash
TOOL_WAIT=$(jq -r '
  select(.name=="firegrid.durable_tools.wait_for.match"
    and .attributes["firegrid.wait.source"]=="CallerFact")
  | .attributes["firegrid.wait.name"]
' "$TRACE" | head -1)

jq -r --arg w "$TOOL_WAIT" '
  select((.attributes["firegrid.wait.name"] // "") == $w) | .name
' "$TRACE" | sort | uniq -c | sort -nr
# 4 wait_store.wait.find
# 3 wait_store.wait.upsert
# 2 wait_router.stream_for_wait
# 2 wait_router.initial_check
# 2 wait_router.complete_match
# 2 wait_for.upsert_active
# 2 wait_for.match
```

Runtime output wait sample, `output-after/1/6`:

```bash
RUNTIME_WAIT=$(jq -r '
  select(.name=="firegrid.durable_tools.wait_for.match"
    and .attributes["firegrid.wait.source"]=="AgentOutputAfter"
    and (.attributes["firegrid.wait.name"]|endswith("/6")))
  | .attributes["firegrid.wait.name"]
' "$TRACE" | head -1)

jq -r --arg w "$RUNTIME_WAIT" '
  select((.attributes["firegrid.wait.name"] // "") == $w
    or (.name=="firegrid.runtime_context.workflow.output.wait"
        and (.attributes["firegrid.runtime.output.after_sequence"]|tostring)=="6"))
  | .name
' "$TRACE" | sort | uniq -c | sort -nr
# 20 wait_store.wait.find
# 12 wait_router.complete_match
#  8 runtime_context.workflow.output.wait
#  8 wait_for.upsert_active
#  8 wait_for.match
#  3 wait_store.wait.upsert
#  2 wait_router.stream_for_wait
#  2 wait_router.initial_check
```

Interpretation bounded by code: `completeMatch` re-reads the wait row and
returns early when the wait is absent, retired, or the trigger does not match
(`wait-router.ts:168-182`). The repeated `complete_match` spans are therefore
candidate evaluations, not necessarily repeated completions.

## Orphan-parent profile

Raw `complete_match` profile:

```bash
jq -rs '
  (map(.spanId) | unique) as $ids
  | map(select(.name=="firegrid.durable_tools.wait_router.complete_match")) as $all
  | ($all | map(select(. as $s |
      .parentSpanId != null and ($ids|index($s.parentSpanId)==null)))) as $orphans
  | {
      complete_match:($all|length),
      orphaned:($orphans|length),
      orphan_ratio:(($orphans|length)/(if ($all|length)==0 then 1 else ($all|length) end)),
      by_source:($all|group_by(.attributes["firegrid.wait.source"])|map(. as $g |
        {source:$g[0].attributes["firegrid.wait.source"],
         count:($g|length),
         orphaned:($g|map(select(. as $s |
           .parentSpanId != null and ($ids|index($s.parentSpanId)==null)))|length)}))
    }
' "$TRACE"
# complete_match=125, orphaned=0, orphan_ratio=0%
# AgentOutputAfter 0/123, CallerFact 0/2
```

Parent distribution:

```bash
jq -rs '
  (map({key:.spanId, value:.name}) | from_entries) as $byId
  | map(select(.name=="firegrid.durable_tools.wait_router.complete_match")
    | $byId[.parentSpanId])
  | group_by(.) | map({parent:.[0], count:length}) | sort_by(-.count)
' "$TRACE"
# wait_router.start 116
# wait_router.initial_check 9
```

Completion-only re-baseline:

```bash
jq -rs '
  (map(.spanId) | unique) as $ids
  | map(select(.name=="firegrid.durable_tools.wait_router.complete_match"
    and ((.events // []) | any(.name=="wait.satisfied")))) as $satisfied
  | ($satisfied | map(select(. as $s |
      .parentSpanId != null and ($ids|index($s.parentSpanId)==null)))) as $orphans
  | {
      satisfied:($satisfied|length),
      orphaned:($orphans|length),
      orphan_ratio:(($orphans|length)/(if ($satisfied|length)==0 then 1 else ($satisfied|length) end)),
      by_source:($satisfied|group_by(.attributes["firegrid.wait.source"])|map(. as $g |
        {source:$g[0].attributes["firegrid.wait.source"],
         count:($g|length),
         orphaned:($g|map(select(. as $s |
           .parentSpanId != null and ($ids|index($s.parentSpanId)==null)))|length)}))
    }
' "$TRACE"
# satisfied=18, orphaned=0, orphan_ratio=0%
# AgentOutputAfter 0/16, CallerFact 0/2
```

DuckDB equivalent:

```sql
WITH ids AS (SELECT spanId FROM spans),
satisfied AS (
  SELECT *
  FROM spans
  WHERE name = 'firegrid.durable_tools.wait_router.complete_match'
    AND list_contains(list_transform(events, e -> e.name), 'wait.satisfied')
)
SELECT attributes['firegrid.wait.source'] AS source,
       count(*) AS satisfied,
       count_if(parentSpanId IS NOT NULL AND parentSpanId NOT IN (SELECT spanId FROM ids)) AS orphaned
FROM satisfied
GROUP BY 1;
```

Parenting source citation: `completeMatchSpanOptions` sets row-arrival as the
parent and wait registrar as a span link (`wait-router.ts:47-72`). The
completion span comments say the row producer should be the trace parent and
registrar should be a link (`wait-router.ts:222-230`).

## Registration-replay path

This sim did **not** restart the host, so it does not prove the external-worker
reattach-after-restart path. It did exercise router startup and initial checks:
`wait_router.start` appeared twice and `initial_check` appeared 18 times in the
same trace query above. After #445, `active_wait_rows`, `attach_wait`, and
`attach_source` are deliberately no longer spans, so absence of those names is
not evidence that the code path disappeared.

Source confirms what that path is for:

- Convergence doc says the non-redundant role of `DurableToolsTable` is pending
  wait discovery after host restart (`docs/research/durable-tools-vs-workflow-engine-convergence.md:54-59`).
- Router source says startup reads active waits, dedupes by wait key, runs
  `completeInitialIfPresent`, and forks the source-attached worker
  (`wait-router.ts:296-393`).
- `RuntimeWaitStreamsLive` merges an initial lookup and live stream for
  `AgentOutputAfter` (`runtime-wait-streams.ts:116-141`) and has a separate
  `initialAgentOutputAfter` used by router initial checks
  (`runtime-wait-streams.ts:142-155`).

## Workflow body coupling

The runtime-context workflow body currently loops by checking completed runtime
input deferreds, then following agent output (`runtime-context-workflow-core.ts:500-516`).
The agent-output branch enters `WaitFor.match` through `waitForAgentOutput`
(`runtime-context-workflow-core.ts:188-211`) and converts timeout-vs-match in
`nextAgentOutput` (`runtime-context-workflow-core.ts:213-234`).

The ACP ToolUse branch is intentionally not executed by the runtime-context
workflow body: ACP ToolUse is treated as provider-executed observation and
returns `Continue` (`runtime-context-workflow-core.ts:399-413`). The real
`wait_for` call in this sim goes through MCP/toolkit lowering and the
`tool-use-to-effect.ts` call site (`tool-use-to-effect.ts:237-251`).

Shape A footprint, from these sources only: the runtime-context body would need
the `AgentOutputAfter` wait currently hidden behind `WaitFor.match` to become an
inline raced effect at `followAgentOutput` / `nextAgentOutput`, while the
agent-tool `wait_for` surface would still need to preserve dynamic source +
scalar-AND predicate + optional timeout at `tool-use-to-effect.ts:190-241`.

## Deferred-input rewrite footprint scan

Search command:

```bash
rg -n "RuntimeInputIntent|TODO|FIXME|deferred-input|rewrite|tracked, deliberately-deferred|RuntimeInput|runtimeInputDeferred" \
  packages/host-sdk/src/host/runtime-context-workflow-core.ts \
  packages/host-sdk/src/host/runtime-input-deferred.ts \
  packages/host-sdk/src/host/runtime-context-engine-registry.ts \
  docs/research/durable-tools-vs-workflow-engine-convergence.md
```

Observed source hits:

- `runtime-context-workflow-core.ts` defines runtime input deferred names and
  deferred awaits/results (`runtime-context-workflow-core.ts:178-184`,
  `runtime-context-workflow-core.ts:236-270`).
- Runtime input intent dispatch lives outside the workflow body in
  `runtime-context-engine-registry.ts` and appends deferred input through
  `appendRuntimeInputDeferred` (`runtime-context-engine-registry.ts:106-118`,
  `runtime-context-engine-registry.ts:265-280`,
  `runtime-context-engine-registry.ts:303-315`).
- The convergence doc says Shape A "should ride with the deferred-input rewrite"
  (`docs/research/durable-tools-vs-workflow-engine-convergence.md:83-89`).
- No `TODO`/`FIXME` hit appeared in `runtime-context-workflow-core.ts` for a
  deferred-input rewrite. The one "tracked, deliberately-deferred future option"
  in that file is about ToolUse event discrimination, not runtime input
  deferred plumbing (`runtime-context-workflow-core.ts:399-413`).

## Trade-off matrix

| Question | Evidence from this run/source | Bound |
|---|---|---|
| Does one sim hit both WaitFor.match call sites? | Yes: 146 `runtime_context.workflow.output.wait` spans and 2 CallerFact `wait_for.match` spans; source call sites cited above. | This run used ACP + MCP, so host-side stdio-jsonl ToolUse execution was not exercised. |
| Is raw `complete_match` a completion baseline? | No: 125 candidate spans but only 18 with `wait.satisfied`; source shows `complete_match` wraps pre-match evaluation. | Re-baseline completion metrics on `wait.satisfied`. |
| Is the complete_match orphan-parent class still present after #445? | No: raw profile is 0/125 orphaned; completion-only profile is 0/18 orphaned. | This supersedes the pre-#445 halt trace numbers for current-main decisions. |
| Is the durable wait index used in a non-restart run? | Router startup and initial checks fire (`wait_router.start` x2, `initial_check` x18), but the long-lived attach/active wrapper spans were deleted by #445. | The external-worker restart path itself was not exercised; no restart in this sim. |
| Does Shape A look mechanically small at the runtime-context call site? | The runtime-context branch is localized around `waitForAgentOutput` / `nextAgentOutput` and `runReactiveLoop`. | The agent-tool `wait_for` call remains a separate dynamic-source surface. |
| Is there code evidence that a deferred-input rewrite is already in-flight? | Source has runtime input deferred plumbing and intent dispatch; docs mention a rewrite, but `runtime-context-workflow-core.ts` has no TODO/FIXME for it. | This is source-scan evidence only; not a project-plan decision. |
| Does this evidence support Shape A now? | It supports "feasible to prototype against known call sites"; it refutes using raw `complete_match` orphan ratio as completion evidence. | It does not decide Shape A because restart reattach and deferred-input rewrite coupling were not empirically exercised here. |

## Follow-up query set

Use this minimum query set for future comparisons:

```bash
# Candidate pressure vs actual completions
jq -rs 'map(select(.name=="firegrid.durable_tools.wait_router.complete_match"))
  | {total:length, satisfied:(map(select((.events // []) | any(.name=="wait.satisfied")))|length)}' "$TRACE"

# Completion-only orphan profile
jq -rs '(map(.spanId) | unique) as $ids
  | map(select(.name=="firegrid.durable_tools.wait_router.complete_match"
    and ((.events // []) | any(.name=="wait.satisfied")))) as $satisfied
  | ($satisfied | map(select(. as $s |
      .parentSpanId != null and ($ids|index($s.parentSpanId)==null)))) as $orphans
  | {satisfied:($satisfied|length), orphaned:($orphans|length)}' "$TRACE"

# Runtime output wait distribution
jq -r 'select(.name=="firegrid.runtime_context.workflow.output.wait")
  | .attributes["firegrid.runtime.output.after_sequence"]' "$TRACE" | sort -n | uniq -c
```
