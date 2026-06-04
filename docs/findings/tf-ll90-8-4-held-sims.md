# tf-ll90.8.4 — comp-sim-idempotent: HELD (real mcp.ts gap, escalated to PO)

`comp-sim-idempotent` validates **caller-controlled external-key create-or-load
idempotency**: the same external `[source, id]` arriving repeatedly (redelivery /
retry / operator replay) must collapse to exactly ONE durable participant
`contextId`, while a different key stays distinct. It never starts the session —
it is participant MAPPING, not a run.

It used `firegrid.sessions.createOrLoad({ externalKey, runtime, createdBy })`,
which keys the context on the **caller's** external key. The MCP surface has no
equivalent:

- `session_new` (`mcp.sessions.createOrLoad`) is the only creation primitive, and
  it derives the externalKey **host-side** (`firegrid.mcp.session_new:${parentContextId}:${toolUseId}`),
  not from a caller-supplied key — so two "same intent" calls get DIFFERENT
  contexts. It also requires a parent + a prompt + bundles start (this sim wants
  create-only, no run).

So this sim cannot be migrated onto mcp.ts without a new MCP operation:
caller-external-key create-or-load (the durable find-or-create participant
mapping), exposed on `FiregridMcpClient`. That is a genuine surface addition, not
a mechanical migration.

**Status:** the sim is left DELETED for now (firegrid.ts is gone). Escalated to
the PO. If the PO decides to fill the gap, that is a follow-up task (add the
caller-external-key create-or-load MCP operation + restore this sim onto it). Do
NOT build the gap as part of the firegrid.ts deletion.

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
