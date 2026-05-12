import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeWaitMatchedRow,
  makeWaitRequestedRow,
  WaitRowSchema,
} from "./index.ts"

describe("@firegrid/protocol wait descriptor schema", () => {
  it(
    "firegrid-durable-fact-wait-descriptor.DESCRIPTOR.1 firegrid-durable-fact-wait-descriptor.DESCRIPTOR.2 firegrid-durable-fact-wait-descriptor.DESCRIPTOR.3 firegrid-durable-fact-wait-descriptor.DESCRIPTOR.4 declares named wait request + outcome rows with no code-as-data",
    () => {
      const requested = makeWaitRequestedRow({
        waitId: "wait:test-1",
        ownerId: "owner:test",
        idempotencyKey: "idem-1",
        source: {
          streamUrl: "https://durable-streams.example/source",
          cursor: "42",
        },
        matcherId: "json-line.text-equals",
        matcherVersion: 1,
        matcherParams: { text: "hello" },
        at: "2026-05-12T00:00:00.000Z",
      })

      // Round-trips through the wire schema.
      const decoded = Schema.decodeUnknownSync(WaitRowSchema)(requested)
      expect(decoded.type).toBe("firegrid.wait.requested")
      if (decoded.type === "firegrid.wait.requested") {
        expect(decoded.waitId).toBe("wait:test-1")
        expect(decoded.matcherId).toBe("json-line.text-equals")
        expect(decoded.matcherVersion).toBe(1)
        // matcherParams is opaque `unknown` data — no code, no functions.
        expect(decoded.matcherParams).toEqual({ text: "hello" })
      }

      const matched = makeWaitMatchedRow({
        waitId: "wait:test-1",
        at: "2026-05-12T00:00:01.000Z",
        match: {
          waitId: "wait:test-1",
          matcherId: "json-line.text-equals",
          matcherVersion: 1,
          matchedAt: "2026-05-12T00:00:01.000Z",
          sourceOffset: "53",
          matchedValue: { line: "hello" },
        },
      })
      const decodedOutcome = Schema.decodeUnknownSync(WaitRowSchema)(matched)
      expect(decodedOutcome.type).toBe("firegrid.wait.matched")
      if (decodedOutcome.type === "firegrid.wait.matched") {
        expect(decodedOutcome.match.matchedValue).toEqual({ line: "hello" })
      }
    },
  )
})
