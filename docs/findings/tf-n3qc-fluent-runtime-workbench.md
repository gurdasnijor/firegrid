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
- fork-backed child sessions work when `Stream-Forked-From` carries the full
  stream pathname (`/v1/stream/...`) and the fork offset is the parent's
  observed offset.

## Evidence

Trace:
`packages/tiny-firegrid/.simulate/runs/2026-06-04T10-40-37-173Z__fluent-runtime-workbench/trace.jsonl`

Rendered summary:
`pnpm --filter @firegrid/tiny-firegrid simulate:show 2026-06-04T10-40-37-173Z__fluent-runtime-workbench`

Key source-verified observations:

| Observation | Evidence |
|---|---|
| Session stream was created and appended through Durable Streams. | Trace lines 1-7 include `fluent_runtime.store.session.create`, `fluent_runtime.store.session.append_event`, and HTTP `PUT`/`POST` spans. |
| Parent session read reached `Stream-Up-To-Date` but stayed open. | Trace line 43 annotates `fluent_runtime.parent.events=2`, `fluent_runtime.parent.closed=false`, and parent offset `0000000000000000_0000000000000314`. |
| Fork-backed child session was created through Durable Streams. | Trace line 15 shows fork `PUT` returned `201` with `http.request.header.stream-forked-from=/v1/stream/tiny-firegrid/sessions/tiny-firegrid-fluent-runtime-workbench-parent` and `http.request.header.stream-fork-offset=0000000000000000_0000000000000314`. |
| Fork boundary and divergence were observed. | Trace line 43 annotates `fluent_runtime.fork.result=Forked`, `fluent_runtime.fork.parent_events_after=3`, `fluent_runtime.fork.child_events_after=3`, and child event names `session.created,resource.mounted,child.diverged`, proving the child inherited the parent prefix and did not inherit the parent's post-fork event. |
| Turn completion used atomic append-and-close. | Trace line 35 shows the terminal turn `POST` with `http.request.header.stream-closed=true`; trace line 37 annotates `fluent_runtime.close.atomic=true`. |
| Turn replay/read-back observed closure. | Trace line 43 annotates `fluent_runtime.turn.events=2` and `fluent_runtime.turn.closed=true`; trace lines 38-42 show the following read/head spans. |

## Recommendation

Keep this package as the runtime workbench foundation and build the next slice
on top of the same domain/store/API split:

1. Land the store/API/session-turn slice.
2. Promote the fork probe into an explicit child-session API and preserve the
   pathname-header rule in the store boundary.
3. Add producer-id / epoch / 0-based sequence helpers before journal-backed
   replay writes depend on idempotent append semantics.
4. Add pull-wake/webhook subscription handlers after the local server/package
   version is confirmed to expose the claim/ack/release surface.
