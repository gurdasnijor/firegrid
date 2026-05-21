import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeCallableChannel,
  makeChannelTarget,
  SessionPermissionChannel,
  SessionPermissionChannelRequestSchema,
  SessionPermissionChannelResponseSchema,
  SessionPermissionChannelTarget,
} from "../../src/channels/index.ts"
import { makeSessionPermissionChannelContract } from "../../src/channels/session-permission.ts"

describe("session permission channel contract", () => {
  it("firegrid-sim3-binding-swap-isolation.SESSION_PERMISSION_CHANNEL.1 exposes callable target, schemas, and Context.Tag in protocol", async () => {
    const request = Schema.decodeUnknownSync(SessionPermissionChannelRequestSchema)({
      permissionRequestId: "perm-1",
      decision: { _tag: "Allow", optionId: "allow" },
      idempotencyKey: "idem-1",
      responseOrigin: "test",
    })
    const response = Schema.decodeUnknownSync(SessionPermissionChannelResponseSchema)({
      responded: true,
      contextId: "ctx-1",
      permissionRequestId: "perm-1",
      inputId: "intent-1",
    })
    const channel = makeSessionPermissionChannelContract({
      call: () => Effect.succeed(response),
    })

    expect(String(SessionPermissionChannelTarget)).toBe("session.permissions.respond")
    expect(channel.target).toBe(SessionPermissionChannelTarget)
    expect(channel.direction).toBe("call")
    expect(channel.requestSchema).toBe(SessionPermissionChannelRequestSchema)
    expect(channel.responseSchema).toBe(SessionPermissionChannelResponseSchema)
    await expect(Effect.runPromise(channel.binding.call(request))).resolves.toEqual(response)
    await expect(
      Effect.runPromise(
        SessionPermissionChannel.pipe(
          Effect.provideService(SessionPermissionChannel, channel),
        ),
      ),
    ).resolves.toBe(channel)
  })

  it("firegrid-sim3-binding-swap-isolation.BOUNDARIES.1 keeps generic CallableChannel scaffolding in protocol without ChannelInventory", () => {
    const target = makeChannelTarget("session.example")
    const channel = makeCallableChannel({
      target,
      requestSchema: Schema.Struct({ value: Schema.String }),
      responseSchema: Schema.Struct({ ok: Schema.Boolean }),
      call: () => Effect.succeed({ ok: true }),
    })

    expect(channel.target).toBe(target)
    expect(channel.direction).toBe("call")
    expect("channels" in channel).toBe(false)
  })
})
