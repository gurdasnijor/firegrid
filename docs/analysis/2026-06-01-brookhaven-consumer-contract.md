# Brookhaven consumer contract — desired semantics for the Firegrid build team

**Author:** Brookhaven (Roblox in-game agent) consumer
**Pairs with:** `docs/analysis/2026-06-01-brookhaven-roblox-solution-map.md` (firegrid-side)
**Source RFC:** `docs/rfc/external/brookhaven-roblox-in-game-agent.md`
**Purpose:** Give the build team the precise client behavior to support, grounded in current
host/client SDK symbols, so you can decide how to deliver these semantics (current surface or a
proposed one). Every requirement below is tagged **[HAVE]** (exists today, just expose it),
**[BRIDGE]** (host-side glue to write), or **[DECIDE]** (needs a build-team design call).

> The load-bearing constraint that shapes *everything*: the consumer is a **Roblox game server**.
> It is **not** an in-process Effect client. It can only do **short HTTP request/response** calls
> (`HttpService:RequestAsync`), **no** SSE / WebSocket / long-lived connections, reaches only the
> public internet (so: through a tunnel), and authenticates with **one** Bearer token pulled from
> `HttpService:GetSecret`. So the edge cannot call `FiregridClientOperations` in-process — it must
> reach the **durable-streams HTTP surface** (append + `GET ?offset=` catch-up), and the host must
> bridge those appends/reads to the in-process operations. This doc specifies both sides.

---

## 1. Actors & trust boundary

```
 ┌──────────────────────┐         one Bearer (G1)        ┌──────────────────────────────┐
 │ Roblox game server    │  ── append intent (POST) ────► │ durable-streams (HTTP log)     │
 │ (UNTRUSTED edge,       │  ◄─ read output (GET ?offset=) │  + G1 auth/scoping proxy       │
 │  poll-only, 1 token)   │                                └───────────────┬────────────────┘
 └──────────────────────┘                                                 │ in-process
                                                              ┌────────────▼───────────────┐
                                                              │ FiregridHost (TRUSTED)       │
                                                              │  intent observer [BRIDGE]    │
                                                              │  → sessions.promptScoped     │
                                                              │  → permissions.respondScoped │
                                                              │  publish MCP tool + executor │
                                                              │  ACP adapter → Claude/OpenACP│
                                                              └──────────────────────────────┘
```

The edge never sees a substrate symbol, table, raw stream name, channel Tag, or the ACP transport.
It sees **opaque handles + a cursor + typed observation rows**. The host owns all in-process calls.

---

## 2. The two handles the edge needs (please make it exactly two)

Per game session/turn, the edge needs **two opaque, token-scoped handles**:

| Handle | Verb | Carries | Backed by |
|---|---|---|---|
| `intent` | **append** | prompt requests **and** permission responses (discriminated in payload) | a per-session intent stream the host observer tails **[BRIDGE]** |
| `output` | **read** (`GET ?offset=`) | the **whole** typed agent-output observation stream | `RuntimeAgentOutputObservation` projection over `RuntimeOutputTable` **[HAVE]** |

Why two and not four: the agent-output observation union **already** carries progress, tool-use,
permission-requests, and terminals — all on one stream, discriminated by `_tag` and ordered by
`sequence` (`packages/protocol/src/session-facade/schema.ts:280` `RuntimeAgentOutputObservationSchema`).
So the edge polls **one** read stream and switches on `_tag`. Splitting into 3 streams (the RFC's
first guess) is unnecessary — one ordered stream is simpler and keeps cross-event ordering intact.

**[DECIDE 1] Handle issuance.** The edge creates sessions *dynamically* (per kid, per request), so
the token cannot be pre-scoped to a session id that doesn't exist yet. We need one of:
- (a) a **tenant-scoped** token that grants "append to game-X intent + read the resulting session
  output," where the **append acknowledgement returns the `output` handle + start offset** for the
  session/turn it just opened; or
- (b) a tiny **`open` call** (token-scoped to the tenant) that returns `{intent, output, startOffset}`
  for a new/loaded session, after which only those two handles are used.

We lean (b) — one cheap call to mint the pair, then pure append/poll. Either is fine; we just need a
defined way for a poll-only edge to **obtain the `output` handle for a session it just started**.

---

## 3. The lifecycle the edge must run (grounded, step by step)

For each step: **semantic need → SDK symbol it maps to → what the edge needs over HTTP → tag.**

### 3.1 Start a build (idempotent)
- **Need:** kid taps Build; create-or-load the session and submit the prompt, idempotently, so a
  double-tap can't fork two sessions or double-run.
- **Symbol:** `sessions.createOrLoad({externalKey:{source,id}, runtime})` (idempotent by a pure hash,
  `sessionContextIdForExternalKey`, schema.ts:616) + `sessions.promptScoped({payload, idempotencyKey})`
  where `idempotencyKey` is **required, min-length-1** (schema.ts:117). **[HAVE]**
- **Edge over HTTP:** the edge **appends one `intent` record** `{kind:"prompt", playerId, requestId,
  text}`. The host observer maps `externalKey = {source:"brookhaven.game", id:"<game>:<player>"}` and
  `idempotencyKey = requestId`, then calls createOrLoad + promptScoped. Triple-keyed idempotency:
  durable-streams **producer-fence** (`Producer-Id/-Epoch/-Seq`, `seq ≤ lastSeq → 204`, PROTOCOL §5.2.1)
  on the append **+** prompt `idempotencyKey` **+** `createOrLoad` externalKey hash. **[BRIDGE]**
- **Edge keeps:** the `requestId` it generated (its idempotency key) and the `output` handle+offset.

### 3.2 Stream progress (the live feed)
- **Need:** show the kid what the agent is doing, gap-free, in order, over polling.
- **Symbol:** `wait.forAgentOutput({afterSequence, timeoutMs})` in-process; the row type is
  `RuntimeAgentOutputObservation` carrying `sequence` (monotonic cursor), `_tag`, and for ToolUse
  `toolUseId`/`toolName` (schema.ts:280, :534). **[HAVE]**
- **Edge over HTTP:** `GET {output}?offset=<cursor>` (PROTOCOL §5.6 catch-up); persist the returned
  `Stream-Next-Offset` as the next cursor; re-poll. **This is exactly the RFC-§6.3 `changes(...,
  sinceCursor)` ask** — no new contract. The edge folds each row by `_tag` (see §4).
- **[DECIDE 2] cursor identity:** the edge persists the **durable-streams `Stream-Next-Offset`**
  (the HTTP cursor), not the in-process `sequence`. Please confirm the per-session output stream's
  offsets are the gap-free monotone cursor the edge should round-trip, and that `sequence` is
  available **inside** each row for app-level dedup/ordering. (Solution map says offsets are
  monotonic + gap-free + resume-by-persisted-offset — we just need it true for *this* projection.)

### 3.3 The publish terminal (when to reload) — the most important one
- **Need:** reload players **only when the place is actually published**, not when the turn ends or
  the agent pauses. This is the P1/P7 bug at the root: "turn complete" ≠ "published."
- **Proposed mechanism (solution map B-3/C-3):** model `publish` as an **MCP tool the agent calls** →
  `ToolDispatchWorkflow` (idempotencyKey = `toolUseId`, so the Open Cloud publish is **at-most-once
  across host restarts**) → a durable `ToolDispatchResult{published, publishedVersion, buildSha}`. **[BRIDGE/DECIDE]**
- **Edge over HTTP:** the edge is watching the `output` stream; it needs to observe, in that stream,
  a row that says **"publish tool succeeded, here is `buildSha`"**, and reload at that row.
- **[DECIDE 3] — please nail the observable shape.** The agent-output union has `_tag:"ToolUse"`
  (with `toolUseId`/`toolName`) but **no `ToolResult` arm** that I can see in
  `RuntimeAgentOutputObservationSchema`. So today the edge can see *that* `publish` was *called*, not
  that it *succeeded* nor its `buildSha`. We need a **client-observable terminal carrying
  `{publishedVersion, buildSha}`**. Options for you to pick:
  - (a) add a `ToolResult` arm to the agent-output observation union (carrying `toolUseId`,
    `resultJson`), so the edge sees `ToolUse(publish)` then `ToolResult(publish){buildSha}`; or
  - (b) a dedicated `sideEffect.published` projection stream the edge reads as a third handle
    (typed, minimal) — the "optional polish" you flagged; or
  - (c) fold the tool result into a typed `TurnComplete`/status payload.
  We prefer **(a)** — keeps it one stream, one poll loop, ordered with the rest. Whatever you choose,
  the contract the edge needs is: *a durable, replay-safe row, observable by offset, that means
  "published" and carries `buildSha` + `publishedVersion`.*
- **Edge action on that row:** stamp-compare `buildSha` and teleport-reload (the RFC's existing
  re-hop mechanic, now driven by a **durable terminal** instead of a `promptRunning` heuristic).

### 3.4 Steering (observe a question, answer it)
- **Need:** the agent asks something mid-run ("publish to prod? rename it?"); the kid answers, or an
  operator policy auto-answers — without restarting.
- **Symbol:** `wait.forPermissionRequest({afterSequence})` → `RuntimePermissionRequestObservation
  {permissionRequestId, toolUseId, options:[{optionId, kind, name}]}` (schema.ts:342) +
  `permissions.respondScoped({permissionRequestId, decision, idempotencyKey?})` where `decision` is
  `PermissionDecisionSchema` (agent-tools/schema.ts). **[HAVE]**
- **Edge over HTTP:** the `PermissionRequest` arrives **in the same `output` poll** (`_tag:
  "PermissionRequest"`, carrying `permissionRequestId` + `options`). The edge renders the options to
  the kid; when answered, the edge **appends an `intent` record** `{kind:"permission", permissionRequestId,
  optionId}`. The host observer maps it to `permissions.respondScoped`. **[BRIDGE]** Redirect ("no,
  do X instead") = another `{kind:"prompt", ...}` append into the same session.
- This is the §11.4 async→session bridge done correctly: reading the projection does **not** itself
  authorize the response; the explicit edge append + host validation does.

### 3.5 Turn end / failure
- **Need:** distinguish done / errored / terminated / **paused-awaiting-permission** (the P1 culprit).
- **Symbol:** typed arms `TurnComplete` | `Error` | `Terminated` | `PermissionRequest` in the union
  (schema.ts:299–328). **[HAVE]** — the edge switches on `_tag`; a `PermissionRequest` is explicitly
  **not** a completion, so the false-Done bug is structurally impossible.

---

## 4. Projection fold spec — transcript → kid-friendly lines

Today our relay hard-codes this fold; please consider owning it as a **declared projection fold**
(host-side) over the agent-output stream, or document it as the canonical client-side fold. Either
way the rules are:

| Observation `_tag` | Render |
|---|---|
| `TextChunk` (+ `Status`) | `💬 <text>` |
| `ToolUse` where `toolName ∈ {Edit, Write}` | `🔧 editing <basename(file_path)>` |
| `ToolUse` where `toolName ∈ {Read, grep, Glob}` | `📖 reading …` / `🔎 searching` |
| `ToolUse(Terminal/Bash)` cmd has `check.sh` | `🧪 checking the build` |
| `ToolUse(Terminal/Bash)` cmd has `publish.sh` *(legacy)* | `🚀 publishing it live` |
| `ToolUse(publish)` *(the MCP tool, §3.3)* | `🚀 publishing it live` |
| `PermissionRequest` | render `options[]` as tappable choices (steering) |
| `TurnComplete` / `Terminated` / `Error` | end-of-run status line |
| **publish terminal** (DECIDE 3) | trigger reload with `buildSha` |

Collapse consecutive identical "thinking" lines. Cap the feed length client-side.

---

## 5. Edge constraints you must design around (non-negotiable, Roblox-imposed)

1. **Request/response only.** No SSE (`?live=sse` unusable), no WebSocket. **Plain catch-up
   `GET ?offset=` only.** Long-poll (`?live=long-poll`) is risky vs `HttpService` request timeouts —
   if offered, server timeout must be short (≤ ~20s) and the edge treats `204` as "re-poll."
2. **`410 Gone` resync.** If retention trims past the edge's cursor, the edge gets `410`; it must
   treat that as **"resync from a fresh handle/snapshot,"** not fatal. For ~1–5 min runs this is rare,
   but the published game can have a server sitting idle — please keep output retention generous
   (minutes, ideally an hour) or give a defined "current snapshot offset" the edge can jump to.
3. **Cursor does not survive a reload.** The teleport-reload spawns a **fresh Roblox server process**
   — in-memory cursor is gone. That's fine (reload happens post-terminal, the stream is done), but it
   means: **never design resume-across-teleport.** The new server starts a *new* interaction.
4. **One Bearer, set manually.** The token comes from `HttpService:GetSecret`, rotated via the Roblox
   Creator Dashboard (manual). So short-lived tokens fight the rotation workflow — see §6.
5. **Payload sizes & counts.** `HttpService` bodies are bounded and each request has overhead; keep
   observation rows reasonably small, and prefer **few rows per poll** (batch the catch-up read return,
   which §5.6 already does) over many tiny ones.
6. **No reachability to localhost.** Everything is via the tunnel to durable-streams + the G1 proxy.

---

## 6. The G1 token the edge needs (your call on shape)

We need a **single, durable-enough, revocable, narrowly-scoped** Bearer embeddable in a published
game. Today OpenACP's master api-secret works but is full-admin — unacceptable. Desired grant set:

```jsonc
// scoped to ONE tenant (game), able to open sessions + drive only its own
{
  "tenant": "brookhaven.prod",
  "grants": [
    { "verb": "open" },                          // mint {intent, output} for a new/loaded session in this tenant
    { "verb": "append", "handleClass": "intent" },// prompts + permission responses for sessions it opened
    { "verb": "read",   "handleClass": "output" } // read agent-output for sessions it opened
  ]
}
```

- **[DECIDE 4] lifetime vs rotation.** Because the token lives in a dashboard-managed Secret, we
  want **long-lived + revocable** (rotate/denylist on demand) over short-exp + frequent re-paste.
  What's your preferred issuance + revocation model?
- **[DECIDE 5] scoping granularity.** Tenant-scoped (open any session in game X) is enough for us —
  the kid allowlist is enforced **in the Roblox server** before it ever appends. We do **not** need
  per-player tokens. Confirm tenant-scope is grantable, and that a tenant token can only touch the
  sessions it opened (not enumerate siblings) — i.e. opaque handles, no derivation (your C-4 (a)).

---

## 7. What we need from the HOST (the [BRIDGE] pieces)

These are additive host components (siblings to `JournalObserverLive`), per solution-map B-4:

1. **Intent observer** — tails each session's `intent` stream; for `{kind:"prompt"}` → `promptScoped`,
   for `{kind:"permission"}` → `permissions.respondScoped`. Validates origin/policy before dispatch
   (§11.4). The single writer of runtime-owned rows stays the host.
2. **`open` resolution** — given a tenant token + `{playerId, requestId}`, createOrLoad the session
   (externalKey) and return `{intent, output, startOffset}` opaque handles (DECIDE 1).
3. **`publish` MCP tool + real `ToolExecutor`** — does the Roblox Open Cloud publish; its
   `ToolDispatchResult{published, publishedVersion, buildSha}` is the durable terminal (DECIDE 3),
   with the Open Cloud key bound via `RuntimeEnvResolverPolicy` (deny-by-default, never on the edge).
4. **ACP runtime** — `codec:"acp"`, Claude/OpenACP as the agent (no change; you confirmed proven).

---

## 8. Acceptance checklist ("cleanly supported" for Brookhaven)

- [ ] Edge does the whole loop with **one Bearer**, **one tunnel**, **two handles** (`intent`+`output`),
      **one poll loop** switching on `_tag`.
- [ ] Double-tap Build is idempotent end-to-end (producer-fence + `requestId` + externalKey).
- [ ] A paused-for-permission turn is **never** misread as done (`PermissionRequest` arm).
- [ ] Reload fires on a **durable published terminal carrying `buildSha`**, not a heuristic.
- [ ] Steering works as observe-`PermissionRequest` → append-`{kind:"permission"}` over the same two
      handles.
- [ ] Host restart mid-build doesn't double-publish (toolUseId idempotency) and the edge resumes by
      offset (or cleanly `410`-resyncs).
- [ ] No substrate symbol / raw stream name / ACP transport ever reaches the edge.

---

## 9. Open questions for the build team (consolidated)

1. **[DECIDE 1]** How does a poll-only edge **obtain the `output` handle** for a session it opens — an
   `open` call returning `{intent, output, startOffset}`, or an append-ack that returns it?
2. **[DECIDE 2]** Confirm the per-session agent-output **projection stream** exposes a gap-free
   monotone **HTTP offset** as the edge cursor, with in-row `sequence` for dedup.
3. **[DECIDE 3]** The **publish terminal shape** the edge observes: add a `ToolResult` arm to the
   agent-output union (preferred), a dedicated `sideEffect.published` stream, or fold into
   `TurnComplete`? It must carry `buildSha` + `publishedVersion` and be replay-safe.
4. **[DECIDE 4]** G1 token **lifetime + revocation** model (we want long-lived + revocable).
5. **[DECIDE 5]** Confirm **tenant-scoped** opaque-handle grants (open + append-intent + read-output),
   no per-player tokens, no sibling enumeration.
6. **Retention** floor for the output projection (we'd like ≥ minutes, ideally ~1h) and the canonical
   **`410`-resync** entry point (a "current snapshot offset").
7. Are the **stubbed read-side channels** (`host.context.snapshot`, `session.lifecycle`) on a path to
   being wired, or should we treat the agent-output projection as the only live read surface
   indefinitely? (We're fine with the latter — just confirming.)

---

## 10. Appendix — edge call → SDK symbol → wire need (one table)

| Edge action | In-process symbol (file) | Wire (HTTP) the edge actually does | Tag |
|---|---|---|---|
| open session | `sessions.createOrLoad` (schema.ts:54) | `open` → `{intent,output,startOffset}` (DECIDE 1) | HAVE+DECIDE |
| send prompt | `sessions.promptScoped` (schema.ts:117) | append `intent {kind:"prompt", requestId,…}` (producer-fenced) | HAVE+BRIDGE |
| stream progress | `wait.forAgentOutput` (operations.ts:60) | `GET output?offset=` → rows, persist `Stream-Next-Offset` | HAVE |
| detect publish | `ToolDispatchWorkflow` result | observe published-terminal row carrying `buildSha` (DECIDE 3) | DECIDE |
| see a question | `wait.forPermissionRequest` (operations.ts:64) | same `output` poll, `_tag:"PermissionRequest"` | HAVE |
| answer a question | `permissions.respondScoped` (operations.ts:74) | append `intent {kind:"permission", permissionRequestId, optionId}` | HAVE+BRIDGE |
| auth (all calls) | — (durable-streams §12.1 out of scope) | one Bearer → G1 proxy → opaque handles | DECIDE (G1) |
```
