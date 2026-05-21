import {
  resolveFiregridOtelFileDestination,
  spanToJsonLine,
} from "../src/node.ts"
import { describe, expect, it } from "vitest"
import type { ReadableSpan } from "../src/node.ts"

describe("@firegrid/observability node helpers", () => {
  it("firegrid-observability.HOST_PROCESS_EXPORTERS.3 resolves explicit file paths before env defaults", () => {
    expect(resolveFiregridOtelFileDestination({
      filePath: "cli.jsonl",
      env: { FIREGRID_OTEL_FILE: "env.jsonl" },
    })).toEqual({ _tag: "file", filePath: "cli.jsonl" })

    expect(resolveFiregridOtelFileDestination({
      env: { FIREGRID_OTEL_FILE: "env.jsonl" },
    })).toEqual({ _tag: "file", filePath: "env.jsonl" })

    expect(resolveFiregridOtelFileDestination({ env: {} })).toBeUndefined()
  })

  it("firegrid-observability.HOST_PROCESS_EXPORTERS.2 serializes ended spans as one JSONL record", () => {
    const line = spanToJsonLine({
      name: "firegrid.test.span",
      spanContext: () => ({
        traceId: "trace",
        spanId: "span",
      }),
      parentSpanContext: { spanId: "parent" },
      kind: 0,
      startTime: [1, 2],
      endTime: [3, 4],
      duration: [2, 2],
      status: { code: 1 },
      attributes: { "firegrid.test": true },
      events: [],
      links: [],
      resource: { attributes: { "service.name": "test" } },
    } as unknown as ReadableSpan)

    expect(line.endsWith("\n")).toBe(true)
    expect(JSON.parse(line)).toMatchObject({
      name: "firegrid.test.span",
      traceId: "trace",
      spanId: "span",
      parentSpanId: "parent",
      attributes: { "firegrid.test": true },
      resource: { "service.name": "test" },
    })
  })
})
