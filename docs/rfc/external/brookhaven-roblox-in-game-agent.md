# Use-Case Proposal: Brookhaven — In-Game Agent (Roblox) on the Firegrid Substrate

**Status:** Draft for firegrid team review / solution-mapping
**Author:** Brookhaven (Roblox game) operator
**Relates to:** [Stream-First Agent Substrate RFC](./durable-stream-agent-plaform-rfc/outline.md)
**Ask:** Validate this as a real consumer use case and solution-map (up to modifying API
surface) so the substrate can *cleanly* support a constrained, poll-only edge client.

---

## 1. TL;DR

Brookhaven is a Roblox game a kid builds **by chatting with an AI agent from inside the
running game** on an iPad. A prompt ("add a helipad", "make the cars red") goes to a Claude
agent that edits the game's source, validates, and publishes; the game then auto-reloads
everyone onto the new build, preserving position.

We built this against **OpenACP** (an ACP↔messaging bridge daemon) with a hand-rolled
HTTP bridge + a bespoke "progress relay." It works, but every hard part we hit is something
the substrate RFC already names as a first-class primitive. We'd like to rebuild the loop on
firegrid — **but the client is an unusually constrained environment** (Roblox servers:
HTTP request/response only, no SSE/WebSocket, must traverse a public tunnel). This doc
describes the system, the pain, and the specific asks where the substrate's API surface may
need to flex to support a poll-only edge client cleanly.

---

## 2. The Use Case (concrete)

1. Kid (on iPad, in the **published** game) types a request into an in-game box and taps Build.
2. Request reaches an agent that edits the game's `src/`, runs validation, and **publishes** a
   new version of the Roblox place (via Roblox Open Cloud).
3. The game **auto-reloads** every player onto the new published build, landing them back
   where they were (Roblox has no in-place hot reload; "reload" = teleport to a fresh server
   running the new version).
4. While the agent works, the kid sees a **live progress feed** of what it's doing
   ("🔎 searching", "🔧 editing WorldBuilder", "🧪 checking the build", "🚀 publishing").
5. **Next feature: steering** — the kid (or an operator policy) answers the agent's questions
   mid-run ("publish? y/n") or redirects it, without restarting.

Audience matters: end users are kids; latency tolerance is "seconds feel slow." Runs take
~1–5 minutes. Reliability and clear progress matter more than raw throughput.

---

## 3. Current Architecture (hand-rolled)

```
                    Roblox game servers (Roblox cloud — the constrained client)
                          │                       │
        create / prompt / poll status      poll transcript lines
                          ▼                       ▼
   ┌──────────────────────────────┐   ┌──────────────────────────────┐
   │ OpenACP tunnel (named, stable)│   │ Relay tunnel (quick, flaky)   │
   └───────────────┬───────────────┘   └───────────────┬──────────────┘
                   ▼                                    ▼
            localhost:21421                      localhost:21422
            OpenACP daemon  ──writes──►  .openacp/history/<id>.json
                                                        ▲
                                          ai-progress-relay.mjs  reads
```

Request flow for one build (current):

```
client appends nothing durable — it calls OpenACP HTTP directly:
  POST /api/v1/sessions                 -> sessionId
  POST /api/v1/sessions/{id}/prompt     (prompt wrapped: "...publish, do NOT ask")
loop every 2s:
  GET  relay /progress?session&since=N  -> friendly lines  (relay tails the history file)
  GET  /api/v1/sessions/{id}            -> promptRunning / status   (heuristic "done")
on heuristic done: teleport all players to a fresh server (new build); compare a build-SHA
  stamp to detect "landed on stale server" and re-hop.
```

Components we wrote: an in-game server module that gates by player id + dispatches; an HTTP
bridge; a Node "progress relay" that reads OpenACP's internal session-history JSON and
re-serves it as pollable JSON; a build-SHA stamp for reload reliability.

---

## 4. Pain Points (each maps to an RFC primitive)

| # | Pain we hit | Root cause | RFC primitive that addresses it |
|---|---|---|---|
| P1 | **False "Done!"** — reloaded before publish | We infer completion from `promptRunning` flickering false; the agent had actually *paused to ask "publish? y/n"* | Durable **`prompt.completed`** terminal + **first-terminal-wins** (§10.7); pause = **`permission.requested`** (§31.3) |
| P2 | **Two tunnels / two endpoints** (status vs transcript) | Client talks raw agent-protocol HTTP **and** a side relay | Client **appends intents / observes projections** through one surface (§11); client MUST NOT open agent transport directly (§11.2) |
| P3 | **Relay tails an internal file** | OpenACP only streams transcript over **SSE**, which Roblox can't consume; no pollable transcript API | **`chunks/updates` projection** as a declared, rebuildable read model (§10.1, §10.3) |
| P4 | **No idempotency** — double-tap spawns two sessions | No intent identity | **Idempotency key** on prompt intent; first-claim-wins (§11.1, §16) |
| P5 | **No restart safety** | Daemon/relay restart loses the in-flight request | Durable log survives; **re-observe from cursor** (§15) |
| P6 | **Steering is impossible** | Fire-and-forget bridge can't answer the agent | **Required actions / approvals as durable waits** (§14, §31.3); **async→session bridge** recipe (§11.4) |
| P7 | **"Publish done" is invisible** | We can only see "turn ended", not "the place was published" | Model publish as a **claimed-work side effect** with its own terminal (§8, §22-ish) |

---

## 5. The Hard Constraint (why this is a good substrate test)

The client is **not** a normal stream-first client. Roblox game servers can only:

- Make **HTTP request/response** calls (`HttpService:RequestAsync`). **No** SSE, **no**
  WebSocket, **no** raw sockets, **no** long-lived/streaming connections.
- Reach only the **public internet** (they run in Roblox's cloud) → every call must traverse a
  **tunnel** to the substrate.
- Hold one credential via a secret store (`HttpService:GetSecret`) → a **single Bearer token**.
- Tolerate only **polling** for liveness/progress; long-poll is risky (request timeouts).
- Not apply code in place: "reload" = **teleport to a fresh server** carrying small state
  (`TeleportData`) + DataStore; agent runs are **minutes** long.

So this is precisely the **"stream-first client over a poll-only transport"** case. The RFC's
§10.4 snapshot→subscribe assumes the client can *subscribe*; here it cannot. The interesting
question for the substrate is whether the **same correctness guarantees** (no missed terminal,
no cross-prompt bleed, gap-free ordering) can be delivered to a client that can only do
**cursor-based incremental HTTP reads**.

---

## 6. What We Need From the Substrate

Mapped to RFC primitives; **bold = where API surface may need to flex.**

1. **Append a prompt intent over HTTP**, idempotent by `(gameSessionId, playerId, requestId)`.
   Returns a handle/cursor. (Maps to §11.1.)
2. **A single HTTP ingress** (append + read) so the game uses one tunnel/URL. **Ask: does
   `client-sdk` ship an HTTP gateway, or do we wrap one? Can it be the one surface the RFC's
   §11 client model implies?**
3. **Poll-friendly projection reads** for a constrained client. Specifically a
   `GET changes(projection, scopeKey, sinceCursor)` that is **subscription-equivalent**
   (snapshot-at-cursor semantics, §10.4) but delivered as discrete HTTP responses. Needed for:
   - `chunks/updates` (the live transcript feed),
   - `prompt` terminal (`completed` / typed failure),
   - `permissions / required-actions` (for steering).
   **Ask: is there (or can there be) a documented cursor-poll read that preserves the §10.4
   no-gap, per-prompt-filtered guarantees without a live subscription?**
4. **A durable terminal that includes the domain side effect.** We don't just need "turn
   ended" — we need "**the place was published**" so the game reloads at the right instant.
   **Ask: model `publish` as a claimed-work operator with its own terminal record the client
   can observe (e.g., `sideEffect.published`), distinct from `prompt.completed`.**
5. **Required-actions exposed to (and resolvable by) the constrained client** for steering —
   observe `permission.requested`, append `permission.resolved` or a follow-up steering prompt
   into the same session, over the poll transport. (Maps to §11.4, §31.3.)
6. **A scoped, durable, revocable capability token** usable as a single Bearer from a secret
   store — limited to "append prompt intent for game X + read that session's projections."
   (Today we use OpenACP's master api-secret, which is full-admin — unacceptable for an
   embedded token in a published game.) **Ask: capability/role tokens at this granularity.**
7. **Multi-tenant isolation** — many games/kids, each a scoped stream/session namespace.
8. **An ACP adapter** (so OpenACP/Claude-via-ACP plugs in as the agent), per §31.2 — or
   guidance on replacing OpenACP's role entirely with a firegrid runtime + ACP adapter.

---

## 7. Our Hacks → Substrate Primitives (the 1:1)

| Brookhaven (hand-rolled) | Firegrid substrate |
|---|---|
| `AiBridge.send` (create + POST prompt) | append `prompt.requested` intent (idempotent) |
| `ai-progress-relay` tailing `history.json` | `chunks/updates` projection (rebuildable) |
| poll loop (status + relay, `since` cursor) | cursor-poll of projections (snapshot+subscribe-equivalent) |
| `promptRunning` flicker = "done" | durable `prompt.completed` terminal (first-terminal-wins) |
| prompt-wrap "publish, don't ask" hack | `permission.requested` / `permission.resolved` (steering) |
| `busyWithRequest` flag | idempotency key / first-claim-wins |
| build-SHA stamp + teleport re-hop | (client-side; stays — Roblox reload mechanic) |
| two tunnels | one append/observe ingress |
| OpenACP daemon | ACP adapter under the runtime |

---

## 8. What "Cleanly Supported" Looks Like (success criteria)

- The game's entire interaction is: **append one intent**, then **cursor-poll two or three
  projections** (chunks, prompt-terminal, required-actions) through **one** authenticated
  HTTP surface over **one** tunnel.
- No bespoke relay; no tailing of internal files; no heuristic completion.
- Double-taps are idempotent; daemon restarts don't lose a build; the game resumes from its
  cursor.
- Steering (answer/redirect mid-run) is the same append-intent + observe-projection shape.
- The embedded credential is scoped and revocable.

---

## 9. Open Questions for the Firegrid Team

1. Is a **poll-only client** a supported first-class profile, or does §10.4 effectively require
   a subscription transport? If the former, what's the canonical cursor-poll read contract?
2. Does `client-sdk` expose an **HTTP ingress** suitable for an external edge client, or is it
   in-process/Effect-only today? If in-process, what's the recommended gateway?
3. Can a **domain side effect (publish)** be a claimed-work operator with a client-observable
   terminal, or should the client infer it from a custom chunk/record?
4. **Capability-token** granularity and issuance — what's available, what's planned?
5. Recommended **ACP adapter** integration boundary (keep OpenACP as adapter vs. replace).
6. Multi-tenant **scoping/isolation** model for many independent games.

---

## 10. Appendix — Reverse-Engineered OpenACP Contract (for reference)

What we currently call (so the team can see the shape we're replacing):

```
POST /api/v1/sessions                 { agent, workspace }            -> { success, data:{ sessionId } }
POST /api/v1/sessions/{id}/prompt     { prompt }                      -> { success, data }
GET  /api/v1/sessions/{id}            -> { data:{ session:{ status, promptRunning, queueDepth } } }
GET  /api/v1/events                   text/event-stream (SSE — unusable from Roblox)
auth: Authorization: Bearer <token>   (static api-secret works durably; ?code= is one-time)
transcript: only via SSE or by tailing .openacp/history/<id>.json (what our relay does)
```

The relay maps each transcript step to a kid-friendly line (text → 💬, Edit/Write → 🔧 editing
<file>, Terminal+check.sh → 🧪, Terminal+publish.sh → 🚀, etc.). That mapping is exactly the
kind of thing a declared `chunks` projection fold should own.
