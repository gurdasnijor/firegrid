# tf-ll90 UKV 13-Probe Real-Path Migration

Date: 2026-06-01
Run: `2026-06-01T21-12-49-123Z__unified-kernel-validation`
Trace: `packages/firelab/.simulate/runs/2026-06-01T21-12-49-123Z__unified-kernel-validation/trace.jsonl`
Outcome: `DriverCompleted`, 433 spans, sides `driver=235,sdk=184,subprocess=13`.

## Summary

The shaped `unified-kernel-validation` driver now carries all 13 legacy probe
identities as real-path trace annotations on the public Firegrid client path.
The migration is intentionally evidence-shaped, not a verdict object:

- Line 422 records `firegrid.ukv.migrated_probe_count=13`.
- Line 422 records 3 observed probes, 3 surfaced production gaps, and 7
  public-surface-blocked probes.
- Lines 45 and 53 prove the run used the real local subprocess and
  `production-codec` adapter, not a recorder/fake-codec/fake-sandbox path.

## Trace Evidence

| Probe | Legacy invariant | Trace result |
|---|---|---|
| P1A | Signal happy path | Observed. Line 32 records `firegrid.unified.signal.send` for the public `session.prompt`; line 422 records the durable session prompt offset. |
| P1B | Signal crash recovery | Public-surface-blocked. Line 422 records that the old probe required generation teardown/recovery controls, which the airgapped public SDK driver does not expose. |
| P1C | Bounded signal ownership | Public-surface-blocked. Line 422 records that the old probe required a `DurableDeferred`-only workflow outside the public Firegrid surface. |
| P2A | Concurrent session executes admit one body | Observed as the public start path. Line 53 records one `firegrid.unified.adapter.start_or_attach` with `adapter.kind=production-codec`; line 422 records the `host.sessions.start` durable offset. |
| P2B | Input arrival after body parks | Observed. Line 33 records `firegrid.client.channel.session_prompt.append`; line 32 records the matching unified signal send. |
| P2C | Session crash recovery | Public-surface-blocked. Line 422 records that the old probe recorded a terminal signal without resume and rebuilt the host generation, which is not available through the public SDK. |
| P3A | Permission roundtrip | Surfaced gap. Line 236 shows the real ACP subprocess emitted `session/request_permission`, but line 422 records `permission_wait_matched=false` and `snapshot PermissionRequest count=0`. |
| P3B | Tool dispatch idempotency | Surfaced gap. Line 135 shows the real ACP subprocess emitted `tool_call`; line 172 shows the tool-result signal; lines 188-189 show the production ACP codec rejected `ToolResult` as out-of-band and propagated `codec send failed`. |
| P4A | Scheduled prompt | Public-surface-blocked. Line 422 records no public scheduled-prompt operation is exposed to the airgapped driver. |
| P4B | Webhook observer | Public-surface-blocked. Line 422 records no public webhook ingest/observer operation is exposed to the airgapped driver. |
| P4C | Webhook bad HMAC rejection | Public-surface-blocked. Line 422 records no public webhook ingest operation is exposed to the airgapped driver. |
| P4D | Peer event observer | Public-surface-blocked. Line 422 records no public peer event operation is exposed to the airgapped driver. |
| P5 | Full product surface | Surfaced gap. Lines 79, 135, 217, 223, 234, and 236 show the real subprocess emitted text, tool-call, tool-call-update, and permission events; line 422 records the public wait/snapshot path still observed zero normalized outputs. |

## Finding

The migration restored the 13 probe identities onto the shaped real-path sim
without reintroducing the old backdoor files. The real path is active, but the
former broad UKV proof is not all green:

- Tool-call relay is a production codec gap: the off-the-shelf ACP example
  emits tool calls, the runtime sends `tool-result:*` signals, and the ACP codec
  rejects `ToolResult` as out-of-band.
- Permission/output projection is a public read-surface gap: the subprocess
  emits ACP updates, but the public wait/snapshot path records no normalized
  `PermissionRequest`, `ToolUse`, `TextChunk`, or `TurnComplete` outputs.
- Scheduled prompt, webhook, peer event, crash-recovery, and bounded-ownership
  probes cannot be exercised by the current airgapped public SDK driver without
  adding or exposing real public surfaces for those capabilities.
