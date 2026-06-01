/**
 * The thin HTTP binding, exercised end-to-end via `HttpApp.toWebHandler` — no
 * port bound. Proves: the three routes wire to the resolver, the single Bearer
 * is read from `Authorization`, opaque handles travel in the path, and the
 * closed error surface maps to correct HTTP status. The client only ever holds
 * `(opaqueHandle, Bearer)` — never a stream name or DS URL.
 */
import { HttpApp } from "@effect/platform"
import {
  HostStreamPrefixWireSchema,
  runtimeContextOutputStreamName,
} from "@firegrid/protocol/launch"
import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import { Effect, Layer, Redacted, Schema } from "effect"
import { beforeEach, describe, expect, it } from "vitest"
import { EdgeAuthHttpApp } from "../src/http.ts"
import { mintHandle } from "../src/handle.ts"
import { brookhavenTenantGrants, issueToken } from "../src/issue.ts"
import {
  type EdgeAuthConfig,
  EdgeAuthConfigTag,
  EdgeAuthResolverLive,
  RevocationStoreInMemory,
} from "../src/resolver.ts"
import { type OpaqueHandle, TenantIdSchema, TokenClaimsSchema } from "../src/schema.ts"
import { makeInMemoryForwarder } from "../src/testkit.ts"

const TOKEN_SECRET = Redacted.make("token-secret-xyz")
const HANDLE_SECRET = Redacted.make("handle-secret-abc")
const PREFIX = Schema.decodeSync(HostStreamPrefixWireSchema)(
  "brookhaven.prod.firegrid.host.h1",
)
const SOURCE = "brookhaven.game"
const config: EdgeAuthConfig = {
  prefix: PREFIX,
  externalKeySource: SOURCE,
  tokenSecret: TOKEN_SECRET,
  handleSecret: HANDLE_SECRET,
}

const token = (tenant: string, tokenId: string) =>
  Effect.runSync(
    issueToken(
      TOKEN_SECRET,
      Schema.decodeSync(TokenClaimsSchema)({
        iss: "firegrid.test",
        tenant,
        tokenId,
        grants: brookhavenTenantGrants,
      }),
    ),
  )

const mintIntent = (tenant: string, id: string): OpaqueHandle =>
  Effect.runSync(
    mintHandle(HANDLE_SECRET, {
      tenant: Schema.decodeSync(TenantIdSchema)(tenant),
      contextId: sessionContextIdForExternalKey({ source: SOURCE, id }),
      handleClass: "intent",
    }),
  )

const outputStreamFor = (tenant: string, playerId: string) =>
  runtimeContextOutputStreamName({
    prefix: PREFIX,
    contextId: sessionContextIdForExternalKey({ source: SOURCE, id: `${tenant}:${playerId}` }),
  })

let forwarder: ReturnType<typeof makeInMemoryForwarder>
let handler: (request: Request) => Promise<Response>
beforeEach(() => {
  forwarder = makeInMemoryForwarder()
  const layer = EdgeAuthResolverLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(EdgeAuthConfigTag, config),
        RevocationStoreInMemory,
        forwarder.layer,
      ),
    ),
  )
  handler = HttpApp.toWebHandlerLayer(EdgeAuthHttpApp, layer).handler
})

const post = (path: string, bearer: string | undefined, body: unknown) =>
  handler(
    new Request(`http://edge-auth.local${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      },
      body: JSON.stringify(body),
    }),
  )

const get = (path: string, bearer: string | undefined) =>
  handler(
    new Request(`http://edge-auth.local${path}`, {
      method: "GET",
      headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
    }),
  )

describe("POST /open", () => {
  it("200 + two opaque handles for a valid token", async () => {
    const res = await post("/open", token("brookhaven.prod", "tok_1"), { playerId: "player1" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { intent: string; output: string; startOffset: string }
    expect(body.intent.length).toBeGreaterThan(0)
    expect(body.output.length).toBeGreaterThan(0)
    expect(body.startOffset).toBe("")
    // the response carries NO stream name / DS url:
    expect(JSON.stringify(body)).not.toContain("firegrid.host")
    expect(JSON.stringify(body)).not.toContain("runtimeOutput")
  })

  it("401 without a Bearer", async () => {
    const res = await post("/open", undefined, { playerId: "player1" })
    expect(res.status).toBe(401)
  })

  it("401 for a tampered token", async () => {
    const good = token("brookhaven.prod", "tok_1")
    const bad = good.slice(0, -2) + (good.endsWith("a") ? "b" : "a")
    const res = await post("/open", bad, { playerId: "player1" })
    expect(res.status).toBe(401)
  })
})

describe("append + read over the binding", () => {
  it("append intent (200) then read seeded output (200 + Stream-Next-Offset)", async () => {
    const bearer = token("brookhaven.prod", "tok_1")
    const opened = (await (await post("/open", bearer, { playerId: "player1" })).json()) as {
      intent: string
      output: string
    }

    const appendRes = await post(`/append/${opened.intent}`, bearer, {
      kind: "prompt",
      requestId: "r1",
      text: "add a helipad",
    })
    expect(appendRes.status).toBe(200)
    expect(((await appendRes.json()) as { offset: string }).offset).toBe("1")

    forwarder.seed(outputStreamFor("brookhaven.prod", "player1"), ["💬 working", "🚀 published"])
    const readRes = await get(`/read/${opened.output}`, bearer)
    expect(readRes.status).toBe(200)
    expect(readRes.headers.get("stream-next-offset")).toBe("2")
    const page = (await readRes.json()) as { events: ReadonlyArray<unknown>; nextOffset: string }
    expect(page.events).toEqual(["💬 working", "🚀 published"])
    expect(page.nextOffset).toBe("2")
  })

  it("403 using another tenant's handle (tenant-mismatch)", async () => {
    const foreignHandle = mintIntent("other.game", "other.game:p")
    const res = await post(`/append/${foreignHandle}`, token("brookhaven.prod", "tok_1"), {
      kind: "prompt",
    })
    expect(res.status).toBe(403)
  })
})
