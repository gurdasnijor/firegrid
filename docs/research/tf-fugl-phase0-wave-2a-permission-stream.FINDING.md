# tf-fugl Phase 0 Wave-2A Permission Stream Finding

## VERDICT

`GREEN-zip-2`

Precision: `GREEN-zip-2-routing-confirmed; CORRELATION-NEEDS-WAVE-2C-RESOLUTION`

Permission-response intents can be consumed as ordinary runtime input stream
events in the stream-zip body. The bounded sim proved the permission response
is appended through the normal runtime input intent path, materialized as the
next runtime input deferred row, and observed by the `runtimeInputStream` side
of the two-stream body.

The request side is also in the ordinary runtime output stream. Trace line 453
records the per-context runtime output append for output sequence 7, and trace
line 454 identifies that row as `firegrid.agent_output.tag:
"PermissionRequest"`. This confirms case (a), not case (b): the remaining
issue is not a permission-routing or missing-request-stream gap. It is
correlation/replay behavior inside the zip body, where replay repeatedly paired
the permission response row with earlier outputs such as `Ready` rather than
the already-recorded `PermissionRequest`.

I did not select `GREEN-zip-3`: this pre-flight did not need a separate third
stream to prove permission-response routing into `runtimeInputStream`.

## Probe

Sim: `packages/firelab/src/simulations/phase0-wave-2a-permission-stream/`

Run:

```bash
pnpm --filter @firegrid/firelab simulate:run phase0-wave-2a-permission-stream --timeout-ms 120000 --watch
```

Run id: `2026-05-20T08-30-45-817Z__phase0-wave-2a-permission-stream`

Trace: `packages/firelab/.simulate/runs/2026-05-20T08-30-45-817Z__phase0-wave-2a-permission-stream/trace.jsonl`

The sim reuses the merged INV-1 stream-zip runtime-context body and drives `claude-agent-acp` through the public session surface. The prompt asks for one `sleep` MCP tool call and then a marker. The driver responds to the ACP `PermissionRequest` with `Allow`, waits 60 seconds, and records the routing verdict span.

## Evidence

- Trace line 15: runtime-context MCP is registered with `sleep` available.
- Trace line 159: the ACP prompt asks for exactly one `Firegrid sleep` call and the marker `FIREGRID_PHASE0_WAVE2A_PERMISSION_STREAM_DONE`.
- Trace lines 422-431: the agent issues `mcp__firegrid-runtime-context__sleep` with `rawInput: {"durationMs":0}`.
- Trace lines 433-454: ACP emits `session/request_permission`; the runtime output substrate appends output sequence 7, then the runtime output subscriber records `firegrid.agent_output.tag: "PermissionRequest"` for that same sequence.
- Trace line 462: the driver writes a `required_action_result` permission response through the normal runtime input intent path.
- Trace line 469: the host appends that permission response into the runtime input deferred stream as `firegrid.input.sequence: 1`.
- Trace lines 498-499: the stream body awaits input sequence 1, decodes the permission-response row, then records `firegrid.agent_input.event_tag: "PermissionResponse"` with `firegrid.inv1.permission_response_matched: false`.
- Trace lines 501, 580, 626, 672, 718, 767, 816, and 865: the same input sequence 1 appears in `firegrid.inv1.stream_zip.pair`, proving the body did pair the response-side input. Those pairs use `firegrid.runtime.output.sequence: 0` and `firegrid.agent_output.event_tag: "Ready"`, not the permission request at output sequence 7. Trace line 529 also pairs input sequence 1 with output sequence 1 `Status`; the observed body still does not correlate the response with output sequence 7.
- Trace line 878: the driver span records `verdict: "GREEN-zip-2"`, `saw_tool_use: true`, `saw_permission_request: true`, `permission_allowed: true`, and `saw_result_marker: false`. The missing marker is therefore downstream of permission routing.

Source read explains the observed failure: `inv1-stream-zip-body/host.ts` only forwards a permission response when `inputEvent._tag === "PermissionResponse"` and the current paired output event is the matching `PermissionRequest` (lines 399-426). The body is exactly the two-stream shape under test: `Stream.zipLatest(runtimeInputStream, runtimeOutputStream)` (lines 548-552).

## Conclusion

Lane 1 can fold permission responses into the runtime input stream for Phase 1.
This probe specifically answers the Wave-2A routing question: no separate
permission stream is required for the response event to enter the body, and the
corresponding request is already present in `runtimeOutputStream`.

The follow-up gap belongs to the zip/body correlation axis. Lane 1 should keep
the two-stream shape, but must not depend on the latest output half of
`zipLatest` still being the matching `PermissionRequest`; it needs a
sequence-aware combinator or explicit pending-permission tracking in the body.
That follow-up is Wave-2C territory, not a Wave-2A permission-routing redesign.
