import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  local,
  normalizeRuntimeIntent,
  PublicLaunchRequestSchema,
  runtimeLaunchStateSchema,
  type RuntimeLaunchRequest,
} from "./index.ts"

describe("@firegrid/protocol launch schema", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1 firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.7 encodes normalized launch requests as durable state rows", async () => {
    const launch: RuntimeLaunchRequest = {
      launchId: "launch-1",
      requestedAt: "2026-05-07T00:00:00.000Z",
      runtime: {
        provider: "local-process",
        config: {
          argv: ["node", "--version"],
        },
        journal: [
          { source: "stdout", format: "jsonl", stream: "provider-wire" },
          { source: "stderr", format: "text-lines", stream: "diagnostics" },
        ],
      },
    }

    const row = runtimeLaunchStateSchema.launchRequests.upsert({
      value: launch,
      headers: { txid: "launch-1" },
    })

    expect(row.type).toEqual("firegrid.launch.request")
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 decodes the thin public launch request", () => {
    const decoded = Schema.decodeUnknownSync(PublicLaunchRequestSchema)({
      runtime: {
        provider: "local-process",
        config: {
          argv: ["node", "--version"],
          env: {
            ANTHROPIC_API_KEY: "must-not-persist",
          },
        },
        journal: [
          { source: "stdout", format: "jsonl", stream: "provider-wire" },
          { source: "stderr", format: "text-lines", stream: "diagnostics" },
        ],
      },
    })

    expect(decoded.runtime.config.argv).toEqual(["node", "--version"])
    expect("journal" in decoded.runtime).toBe(false)
    expect("env" in decoded.runtime.config).toBe(false)
  })

  it("firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.3 decodes provider-wire rows with parser status", () => {
    const row = runtimeLaunchStateSchema.providerWire.insert({
      value: {
        providerWireRowId: "provider-wire-1",
        launchId: "launch-1",
        activityAttempt: 1,
        sequence: 0,
        channel: "stdout",
        format: "jsonl",
        stream: "provider-wire",
        receivedAt: "2026-05-07T00:00:00.000Z",
        raw: "{\"type\":\"assistant\"}",
        parseStatus: "valid-json",
      },
    })

    expect(row.type).toEqual("firegrid.launch.provider_wire")
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.8 keeps local JSONL defaults out of public helper output until normalization", () => {
    const publicRuntime = local.jsonl({
      argv: ["node", "--version"],
    })
    expect("journal" in publicRuntime).toBe(false)

    const normalized = normalizeRuntimeIntent(publicRuntime)
    expect(normalized.journal).toContainEqual({
      source: "stdout",
      format: "jsonl",
      stream: "provider-wire",
    })
  })
})
