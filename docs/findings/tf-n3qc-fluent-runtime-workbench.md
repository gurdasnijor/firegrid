# tf-n3qc Fluent Runtime Workbench Findings

## Summary

This slice adds a small `@firegrid/fluent-runtime` workbench package and a
`tiny-firegrid` simulation proving the first managed-agent runtime substrate
shape over Effect + Durable Streams:

- sessions are domain streams, not generic workflow invocations;
- turns are finite streams;
- turn completion uses an atomic append-and-close request;
- read-back exposes `streamClosed`, so callers do not treat
  `Stream-Up-To-Date` as terminal;
- fork is probed through Durable Streams fork headers, but this run did not
  verify working fork semantics.

## Evidence

Trace:
`packages/tiny-firegrid/.simulate/runs/2026-06-04T10-34-25-679Z__fluent-runtime-workbench/trace.jsonl`

Rendered summary:
`pnpm --filter @firegrid/tiny-firegrid simulate:show 2026-06-04T10-34-25-679Z__fluent-runtime-workbench`

Key source-verified observations:

| Observation | Evidence |
|---|---|
| Session stream was created and appended through Durable Streams. | Trace lines 1-7 include `fluent_runtime.store.session.create`, `fluent_runtime.store.session.append_event`, and HTTP `PUT`/`POST` spans. |
| Parent session read reached `Stream-Up-To-Date` but stayed open. | Trace line 31 annotates `fluent_runtime.parent.events=2`, `fluent_runtime.parent.closed=false`, and a parent offset. |
| Turn completion used atomic append-and-close. | Trace line 23 shows the terminal turn `POST` with `http.request.header.stream-closed=true`; trace line 25 annotates `fluent_runtime.close.atomic=true`. |
| Turn replay/read-back observed closure. | Trace line 31 annotates `fluent_runtime.turn.events=2` and `fluent_runtime.turn.closed=true`; trace lines 26-30 show the following read/head spans. |
| Fork is not proven by this sim. | Trace line 31 annotates `fluent_runtime.fork.result=Unsupported`; source code currently treats fork as a best-effort `create({ headers: Stream-Forked-From, Stream-Fork-Offset })` probe. |

## Recommendation

Keep this package as the runtime workbench foundation and build the next slice
on top of the same domain/store/API split:

1. Land the store/API/session-turn slice.
2. Let the substrate proof lane finish direct fork, producer, and subscription
   verification.
3. Add fork-backed child-session semantics only after the server behavior is
   source-verified by a sim that reads the child stream and proves inherited
   parent history.
4. Add pull-wake/webhook subscription handlers after the local server/package
   version is confirmed to expose the claim/ack/release surface.
