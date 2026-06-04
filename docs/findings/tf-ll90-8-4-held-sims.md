# tf-ll90.8.4 — comp-sim-idempotent: RESTORED (gap filled by tf-focr)

`comp-sim-idempotent` validates **caller-controlled external-key create-or-load
idempotency**: the same external `[source, id]` arriving repeatedly (redelivery /
retry / operator replay) must collapse to exactly ONE durable participant
`contextId`, while a different key stays distinct. It never starts the session —
it is participant MAPPING, not a run.

**Status (tf-focr, 2026-06-04): RESTORED.** The PO decided to fill the gap. The
fix added a `session_create_or_load` MCP tool — the caller-external-key
create-or-load (insert-or-get on `[source, id]`) projected from the EXISTING
`session.createOrLoad` protocol operation, dispatching DIRECT to
`HostSessionsCreateOrLoadChannel` (no router, the tf-s9uj pattern). The
mislabelled client method was corrected: `mcp.sessions.create` now wraps
`session_new` (spawn child), and `mcp.sessions.createOrLoad` wraps the new
idempotent tool. The sim is restored at
`packages/firelab/src/simulations/comp-sim-idempotent/` on `firegridHost`,
driver over `@firegrid/client-sdk/mcp`. Proven: same key (incl. 4 concurrent
replays) → one `contextId`; different id and different source → distinct.

DECISION (reported as the finding before building): `session_new` (spawn+run,
requires `agentKind`+`prompt`, parent-derived runtime) and create-or-load
(create-only mapping, caller runtime, no parent) have disjoint required fields
and opposite spawn behavior — they do NOT reconcile into one clean schema, and
the protocol already models them as two operations (`session.create` +
`session.createOrLoad`). Kept separate.

---

## verified-webhook-wait — ALSO HELD (real mcp.ts gap)

`verified-webhook-wait` validates the verified-webhook ingress: the driver
discovers the host's dynamically-bound webhook route URL, HTTP-POSTs a signed
webhook to it, and observes the resulting verified fact. All three steps are
**Firegrid channel** operations with no mcp.ts equivalent:

1. route-URL discovery — `firegrid.wait.for({ channel: "tiny.verifiedWebhookWait.route" })`; mcp.ts has no channel-read/wait (only session/context resources).
2. webhook DELIVERY — HTTP-POST a signed webhook / `firegrid.channels.send`; mcp.ts has no channel-send / webhook-send tool, and the route URL is unobtainable (gap 1).
3. fact observation — `firegrid.wait.for({ channel: "firegrid.verifiedWebhooks" })`; the fact rides a Firegrid channel, not session agent-output, so `wait.forAgentOutput` does not surface it.

The HOST migrated cleanly onto firegridHost (webhook fact-table + route-ready-table
compose over it), but the DRIVER cannot be expressed on the mcp.ts surface.
**Held (sim left deleted), escalated to PO** — same disposition as
comp-sim-idempotent. Filling it needs an mcp.ts channel-read + channel-send (or a
webhook-deliver) operation; that is a follow-up surface decision, not part of the
firegrid.ts deletion. Do NOT build it here.
