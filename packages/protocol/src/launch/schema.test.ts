import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  RuntimeLaunchRequestSchema,
  runtimeLaunchStateSchema,
  type RuntimeLaunchRequest,
} from "./index.ts"

describe("@firegrid/protocol launch schema", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1 encodes launch requests as durable state rows", async () => {
    const launch: RuntimeLaunchRequest = {
      launchId: "launch-1",
      requestedAt: "2026-05-07T00:00:00.000Z",
      target: {
        kind: "command",
        spec: {
          argv: ["node", "--version"],
        },
      },
      planes: {
        session: {
          "provider-wire": {
            kind: "stream",
            role: "events",
            streamUrl: "https://durable.example/v1/stream/provider-wire",
          },
        },
      },
    }

    const row = runtimeLaunchStateSchema.launchRequests.upsert({
      value: launch,
      headers: { txid: "launch-1" },
    })

    expect(row.type).toEqual("firegrid.launch.request")
  })

  it("firegrid-durable-launch-runtime-operator.PLANES.1 decodes declared launch planes", () => {
    const decoded = Schema.decodeUnknownSync(RuntimeLaunchRequestSchema)({
      launchId: "launch-1",
      requestedAt: "2026-05-07T00:00:00.000Z",
      target: {
        kind: "command",
        spec: {
          argv: ["node", "--version"],
        },
      },
      planes: {
        session: {
          "provider-wire": {
            kind: "stream",
            role: "events",
            streamUrl: "https://durable.example/v1/stream/provider-wire",
          },
        },
        execution: {
          local: {
            kind: "local-process",
          },
        },
      },
    })

    expect(decoded.planes.execution?.["local"]?.kind).toEqual("local-process")
  })
})
