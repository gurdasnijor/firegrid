# @firegrid/edge-auth

A **thin token → opaque-handle authorizing layer** in front of the existing
durable-streams read/append HTTP surface. It is the Brookhaven **G1** surface
(`tf-r06u.33`) — the one genuinely new thing the consumer needs.

durable-streams puts auth/authz **explicitly out of scope** (PROTOCOL §12.1):
transport + ordering + idempotency are free, but there is no per-stream
scoping. This package adds exactly that scoping — **without becoming a
gateway**. The substrate stays the single read-authority; this layer only
decides _who may address which opaque handle with which verb_, then forwards.

Spec: `docs/analysis/2026-06-01-brookhaven-roblox-solution-map.md` §C-4 and
`docs/analysis/2026-06-01-brookhaven-consumer-contract.md` §6/§9.

## The surface

Three routes, mirroring three verbs. The client holds **one Bearer** (the
capability token) and **opaque handles** — never a stream name or DS URL.

| Route | Verb | Returns |
|---|---|---|
| `POST /open` | `open` | `{ intent, output, startOffset }` — mints the handle pair (DECIDE-1) |
| `POST /append/:handle` | `append` | `{ offset, deduplicated }` — prompts + permission responses (intent in) |
| `GET /read/:handle?offset=` | `read` | `{ events, nextOffset, upToDate }` + `Stream-Next-Offset` (output out). On retention-trim → `410 { error:"gone", snapshotOffset }` (recoverable) |
| `GET /resync/:handle` | `read` | `{ snapshotOffset }` — current snapshot offset to jump to after a `410` / teleport-reload (tf-r06u.43, contract §5.2/§9-Q6) |

## Design

- **Two-layer auth.** The Bearer token proves `(tenant, grant-classes)`; each
  opaque handle is itself a signed envelope proving `(tenant, contextId,
  handleClass)`. `resolve` checks signature + tenant-match + closed-grant
  membership + not-revoked, then maps the handle to a stream name server-side.
- **Signed, stateless handles** (solution-map C-4 (a)+(c)). No shared handle
  store. The client cannot read, forge, enumerate, or derive a sibling handle
  without the server secret. Revocation is a `tokenId` denylist (DECIDE-4:
  long-lived + revocable).
- **Illegal states unrepresentable** (tf-r06u.27 §9). The grant union admits
  exactly `open` / `append:intent` / `read:output`; there is no admin/wildcard
  grant, and "append to output" / "read intent" fail to decode. The edge
  contract is `(opaqueHandle, verb)` from closed sets — it _narrows_ the
  `(string, unknown)` channel-facade hole, never widens it.
- **Stream names come from `@firegrid/protocol/launch`** (single authority):
  output = `runtimeContextOutputStreamName`, intent =
  `runtimeContextIntentStreamName` (added here; the tf-r06u.42 intent-observer
  tails the same name — they cannot drift).

## Scope of this slice (tf-r06u.33)

Confirmed scope: **resolver core + thin HttpApi binding**, validated
end-to-end against an in-memory durable-streams double
(`@firegrid/edge-auth/testkit`). **Deferred (named follow-ups):**

- A live `DurableStreamsForwarder` against the real durable-streams HTTP
  surface (the `DurableStreamsForwarder` tag is the seam; only the in-memory
  double ships here).
- Durable revocation store (in-memory `RevocationStoreInMemory` ships).
- TLS / deployment.
- Token issuance/rotation operator surface (`issueToken` ships as the minting
  primitive).
- APPLYING the output retention floor as a stream `ttlSeconds` at creation
  (tf-r06u.50): `outputRetentionFloorSeconds` config + the 410-resync entry
  point ship in tf-r06u.43, but threading the TTL through `DurableStreamOptions`
  + `DurableTable` create is a substrate follow-up. Resync makes `410`
  recoverable regardless.

## Usage (sketch)

```ts
import { HttpApp } from "@effect/platform"
import { EdgeAuthHttpApp, EdgeAuthResolverLive, RevocationStoreInMemory, EdgeAuthConfigTag } from "@firegrid/edge-auth"

const layer = EdgeAuthResolverLive.pipe(Layer.provide(Layer.mergeAll(
  Layer.succeed(EdgeAuthConfigTag, { prefix, externalKeySource: "brookhaven.game", tokenSecret, handleSecret }),
  RevocationStoreInMemory,
  durableStreamsForwarderLive, // <- live forwarder is the deferred follow-up
)))
const { handler } = HttpApp.toWebHandlerLayer(EdgeAuthHttpApp, layer)
```
