# tf-61n0 Finding: Stdio JSONL Permissions Truthfulness

Verdict: TRUTHFUL.

`StdioJsonlCapabilities.permissions = false` is truthful for the current
Codex CLI-backed stdio-jsonl codec surface. The codec does not expose a
permission request/response event channel, and current Codex CLI help does not
document one for stdio JSONL execution.

## Evidence

- The stdio-jsonl codec declares permissions unsupported:
  `packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts:15`.
- `decodeStdoutLine` only recognizes stdout events with `type` values
  `text`, `assistant`, `tool_use`, `turn_complete`, `end_turn`, and `status`;
  unrecognized types are surfaced as codec errors, not permission requests:
  `packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts:172`.
- `encodeInputEvent` rejects `PermissionResponse`, `Cancel`, and `Terminate`
  inputs, so the codec has no outbound permission-response path:
  `packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts:201`.
- Current CLI source-read command evidence from 2026-05-20:
  `npx -y @openai/codex --help` and
  `npx -y @openai/codex exec --help` expose sandbox/approval configuration and
  JSON output mode, but no documented permission request/response stdio
  protocol.

## Conclusion

The Codex CLI may still have interactive approval behavior controlled by its
sandbox and approval options, but that is not the same as a Firegrid
stdio-jsonl permission event channel. For this codec's current protocol surface,
`permissions: false` is the accurate capability declaration.
