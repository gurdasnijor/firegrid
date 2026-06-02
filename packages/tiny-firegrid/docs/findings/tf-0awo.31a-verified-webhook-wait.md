# tf-0awo.31a - verified webhook fact -> public wait_for

**Bead:** `tf-0awo.31a`  
**Sim:** `verified-webhook-wait`  
**Date:** 2026-06-02  
**Run:** `.simulate/runs/2026-06-02T13-50-27-894Z__verified-webhook-wait/trace.jsonl`

## What the sim proves

The host composes the real post-section-12 `FiregridRuntime(spec, adapter)` and a
product-owned signed Linear webhook route. The route writes a verified webhook
fact to the durable fact stream through the real `ingestVerifiedWebhook` adapter.

The driver imports only `@firegrid/client-sdk/firegrid` and Effect. It waits on a
public route-ready channel, forks a public `firegrid.wait.for` over
`firegrid.verifiedWebhooks` with `source = linear-cap1` and
`eventType = Issue.update`, posts the signed webhook, then observes the matched
fact.

## Trace evidence

- Line 8: the host publishes the route-ready fact with
  `firegrid.webhook.route_channel = tiny.verifiedWebhookWait.route` and a local
  signed webhook URL.
- Line 56: the public verified-webhook channel opens an SSE read on the durable
  fact stream at `offset=-1`.
- Line 68: the driver posts to the product route and receives HTTP `202`.
- Line 69: the driver records `firegrid.webhook_wait.matched = true`,
  `source = linear-cap1`, `event_type = Issue.update`, and
  `external_event_key = cap1-linear-delivery-1`.
- Line 75: the simulation stops with `firegrid.simulation.outcome =
  DriverCompleted`.

## Finding

**Confirmed:** an external verified webhook fact can wake a public
`wait_for`/`firegrid.wait.for` on the post-section-12 substrate without a fake
adapter or driver-side runtime imports.

Reach-past classification: **no driver reach-past.** The only sim harness
extension is `channels(env)`, which registers host-declared public channel
bindings with the client config. The driver remains on the client SDK. The
verified webhook channel is a durable-stream view over the product-owned fact
stream because a separate `DurableTable.rows()` instance only observes its local
table cache; using the durable-stream floor is the intended post-section-12 read
shape for cross-process/public observation.
