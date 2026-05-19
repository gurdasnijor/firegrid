# FINDING — tf-ke7: CallerFact wait matches after host restart, but participant does not resume

Status authority is the bead (`tf-ke7`). This file is the narrative
artifact; live evidence is the gitignored `.simulate` run
`2026-05-19T12-35-51-506Z__wait-for-caller-fact-restart-pipeline`.

## What was built

`packages/tiny-firegrid/src/simulations/wait-for-caller-fact-restart-pipeline.ts`
is a self-contained tiny-firegrid simulation for the factory-vision section
6 durability claim:

1. a participant emits `wait_for` against a caller-owned `CallerFact` stream;
2. host generation 1 observes the durable wait row;
3. generation 1 is closed before the matching fact exists;
4. host generation 2 starts with the same durable-streams base URL and
   namespace;
5. the matching `factoryWaitRestart.facts` row is appended only after
   generation 2 starts;
6. the public Firegrid client waits for the same participant context to emit
   the resolved result.

The app code does not drive a phase chain. It only composes the host,
provides the caller-owned DurableTable fact stream, writes the post-restart
fact at the edge, and observes through the public client.

## Evidence

Run summary:

- `waitToolUseObserved: true`
- `waitActiveBeforeRestart: true`
- `gen1ClosedBeforeFact: true`
- `gen2StartedBeforeFact: true`
- `factAppendedAfterRestart: true`
- `callerFactWaitCompletedAfterRestart: true`
- `callerFactWaitCompletionOutcome: "match"`
- `sameParticipantResumed: false`
- `waitMatchedAfterRestart: false`

Trace localization:

- `firegrid.durable_tools.wait_for.upsert_active` records
  `firegrid.wait.name="tool:caller-fact-wait-1"` and
  `firegrid.wait.source="CallerFact"`.
- After the post-restart fact append, `firegrid.durable_tools.wait_router.complete_match`
  records `firegrid.wait.name="tool:caller-fact-wait-1"`,
  `firegrid.wait.source="CallerFact"`, and
  `firegrid.wait.trigger_matched=true`.
- The router writes completion state:
  `firegrid.durable_tools.wait_store.completion.upsert` with
  `firegrid.wait.outcome="match"` and then
  `firegrid.workflow_engine.deferred.done` for
  `firegrid.workflow.deferred.name="wait-for/tool:caller-fact-wait-1"`.
- Generation 2 repeatedly resumes the workflow, but the tool-use activity is
  not owned by the new worker:
  `firegrid.workflow_engine.activity.claim` for
  `firegrid.workflow.activity.name="firegrid.runtime-context.tool.caller-fact-wait-1"`
  has `firegrid.workflow.activity.claim_owned=false`; the span also shows the
  new `firegrid.workflow.worker_id` differs from the persisted
  `firegrid.workflow.activity.claim_worker_id`.
- The participant never receives a `tool_result`; the public client sees no
  `FIREGRID_CALLER_FACT_WAIT_RESUMED:` output.

## Verdict

The CallerFact source and wait router do survive the host restart enough to
match the post-restart fact and complete the durable wait. The load-bearing
failure is narrower: the suspended tool-use activity remains claimed by the
generation-1 workflow worker, and generation 2 cannot re-own/replay that
activity to deliver the completed wait result back to the same participant.

This leaves the factory-vision section 6 "wait survives interruption and
resumes without compute while suspended" property unproven through the
current public Firegrid path. The next substrate slice should address
workflow activity-claim recovery or an equivalent restart-safe handoff for
tool calls that suspend on durable waits.

## Triage

This is a production durability gap, not a tiny-firegrid fixture issue:
caller-owned facts, wait completion, workflow resume, and participant output
are all exercised through the public Firegrid client and runtime surfaces.
