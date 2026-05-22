import {
  checkFiregridOtelFileWritable,
  FiregridOtelLive,
  resolveFiregridOtelActiveExporter,
  resolveFiregridOtelFileDestination,
  spanStartToJsonLine,
  spanToJsonLine,
} from "../src/node.ts"
import { Duration, Effect } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { ReadableSpan } from "../src/node.ts"

interface PhaseRecord {
  readonly phase?: string
  readonly name: string
  readonly attributes: Record<string, unknown>
}

const readPhaseRecords = (filePath: string): ReadonlyArray<PhaseRecord> =>
  readFileSync(filePath, "utf8")
    .split("\n")
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as PhaseRecord)

// Run a single named span through the real FiregridOtelLive file destination
// and return the resulting JSONL records. A short sleep keeps the span open
// across a tick so the deferred start-record microtask fires before the scope
// (and the file stream) is torn down — mirroring a real in-flight span.
const captureSpanRecords = (
  filePath: string,
  attributes: Record<string, unknown>,
): Promise<ReadonlyArray<PhaseRecord>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      yield* Effect.withSpan(Effect.sleep(Duration.millis(20)), "firegrid.test.live", {
        attributes,
      })
      yield* Effect.sleep(Duration.millis(20))
    }).pipe(
      Effect.provide(
        FiregridOtelLive({
          resource: { serviceName: "firegrid-observability-test" },
          destination: { _tag: "file", filePath },
        }),
      ),
      Effect.scoped,
    ),
  ).then(() => readPhaseRecords(filePath))

const withEnv = async (
  patch: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> => {
  const prior: Record<string, string | undefined> = {}
  for (const key of Object.keys(patch)) {
    prior[key] = globalThis.process.env[key]
    if (patch[key] === undefined) delete globalThis.process.env[key]
    else globalThis.process.env[key] = patch[key]
  }
  try {
    await run()
  } finally {
    for (const key of Object.keys(patch)) {
      if (prior[key] === undefined) delete globalThis.process.env[key]
      else globalThis.process.env[key] = prior[key]
    }
  }
}

const fakeSpan = (
  overrides?: Partial<{ readonly attributes: Record<string, unknown> }>,
): ReadableSpan =>
  ({
    name: "firegrid.test.span",
    spanContext: () => ({ traceId: "trace", spanId: "span" }),
    parentSpanContext: { spanId: "parent" },
    kind: 0,
    startTime: [1, 2],
    endTime: [3, 4],
    duration: [2, 2],
    status: { code: 1 },
    attributes: overrides?.attributes ?? { "firegrid.test": true },
    events: [],
    links: [],
    resource: { attributes: { "service.name": "test" } },
  }) as unknown as ReadableSpan

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

  it("tf-r1gz resolves a relative --otel-file against baseDir (repo-correct, not the launch cwd)", () => {
    // A relative path used to resolve against the firegrid process cwd, which
    // under Zed is the editor's cwd — so the trace landed outside the repo.
    // baseDir (the operator-supplied --cwd) pins it to an absolute repo path.
    expect(resolveFiregridOtelFileDestination({
      filePath: ".firegrid/acp-trace.jsonl",
      baseDir: "/repo/root",
    })).toEqual({ _tag: "file", filePath: "/repo/root/.firegrid/acp-trace.jsonl" })

    // An absolute --otel-file ignores baseDir.
    expect(resolveFiregridOtelFileDestination({
      filePath: "/abs/trace.jsonl",
      baseDir: "/repo/root",
    })).toEqual({ _tag: "file", filePath: "/abs/trace.jsonl" })

    // Env-sourced relative paths resolve against baseDir too.
    expect(resolveFiregridOtelFileDestination({
      env: { FIREGRID_OTEL_FILE: "trace.jsonl" },
      baseDir: "/repo/root",
    })).toEqual({ _tag: "file", filePath: "/repo/root/trace.jsonl" })

    // Without baseDir the raw path is returned unchanged (back-compat).
    expect(resolveFiregridOtelFileDestination({
      filePath: ".firegrid/acp-trace.jsonl",
    })).toEqual({ _tag: "file", filePath: ".firegrid/acp-trace.jsonl" })
  })

  it("tf-r1gz active exporter reflects OTLP precedence over the file destination", () => {
    const fileDest = { _tag: "file" as const, filePath: "/repo/.firegrid/acp-trace.jsonl" }

    // No OTLP env: the file destination is what actually runs.
    expect(resolveFiregridOtelActiveExporter({ destination: fileDest, env: {} }))
      .toEqual(fileDest)

    // OTLP env set: OTLP wins, so the file announcement must NOT claim a file.
    expect(resolveFiregridOtelActiveExporter({
      destination: fileDest,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example/v1/traces" },
    })).toEqual({ _tag: "otlp", endpoint: "https://otlp.example/v1/traces" })

    // Empty OTLP env is treated as unset.
    expect(resolveFiregridOtelActiveExporter({
      destination: fileDest,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "" },
    })).toEqual(fileDest)

    // No destination resolved: the OTel layer is never installed.
    expect(resolveFiregridOtelActiveExporter({
      destination: undefined,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example/v1/traces" },
    })).toEqual({ _tag: "none" })

    // Console destination follows the same OTLP precedence.
    expect(resolveFiregridOtelActiveExporter({
      destination: { _tag: "console" },
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example/v1/traces" },
    })).toEqual({ _tag: "otlp", endpoint: "https://otlp.example/v1/traces" })
  })

  it("tf-3718 checkFiregridOtelFileWritable accepts a creatable, writable destination", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tf-3718-ok-"))
    try {
      // nested dir does not exist yet; the check should create it.
      expect(
        checkFiregridOtelFileWritable(path.join(dir, "nested", "acp-trace.jsonl")),
      ).toEqual({ _tag: "writable" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("tf-3718 checkFiregridOtelFileWritable reports an unwritable path with a reason", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tf-3718-bad-"))
    try {
      // Put a FILE where the check needs a directory, so mkdir fails (ENOTDIR).
      const fileAsParent = path.join(dir, "not-a-dir")
      writeFileSync(fileAsParent, "x")
      const result = checkFiregridOtelFileWritable(
        path.join(fileAsParent, "sub", "acp-trace.jsonl"),
      )
      expect(result._tag).toBe("unwritable")
      if (result._tag === "unwritable") {
        expect(result.reason.length).toBeGreaterThan(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("firegrid-observability.HOST_PROCESS_EXPORTERS.2 serializes ended spans as one phase:end JSONL record", () => {
    const line = spanToJsonLine(fakeSpan())

    expect(line.endsWith("\n")).toBe(true)
    const parsed = JSON.parse(line) as Record<string, unknown>
    // tf-9ia9: end records are tagged phase:"end" and keep every prior field, so
    // existing end-span consumers are unaffected (additive only).
    expect(parsed).toMatchObject({
      phase: "end",
      name: "firegrid.test.span",
      traceId: "trace",
      spanId: "span",
      parentSpanId: "parent",
      endTime: [3, 4],
      duration: [2, 2],
      status: { code: 1 },
      attributes: { "firegrid.test": true },
      resource: { "service.name": "test" },
    })
  })

  it("tf-9ia9 serializes an in-flight span as one phase:start JSONL record without end fields", () => {
    const line = spanStartToJsonLine(fakeSpan({ attributes: { "codec.sdk.call.mcp_server_count": 2 } }))

    expect(line.endsWith("\n")).toBe(true)
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed).toMatchObject({
      phase: "start",
      name: "firegrid.test.span",
      traceId: "trace",
      spanId: "span",
      parentSpanId: "parent",
      startTime: [1, 2],
      attributes: { "codec.sdk.call.mcp_server_count": 2 },
    })
    // endTime/duration/status are meaningless while in flight and omitted.
    expect(parsed["endTime"]).toBeUndefined()
    expect(parsed["duration"]).toBeUndefined()
    expect(parsed["status"]).toBeUndefined()
  })

  it("tf-9ia9 FIREGRID_OTEL_FILE_PHASES=start-end records an in-flight start span with creation-time attributes", async () => {
    await withEnv(
      { FIREGRID_OTEL_FILE_PHASES: "start-end", OTEL_EXPORTER_OTLP_ENDPOINT: undefined },
      async () => {
        const filePath = path.join(
          mkdtempSync(path.join(tmpdir(), "fg-otel-start-")),
          "trace.jsonl",
        )
        const records = await captureSpanRecords(filePath, {
          // emulates codec.sdk.call's injected MCP metadata — set via withSpan
          // attributes, i.e. AFTER tracer.startSpan, so this asserts the
          // microtask defer actually captures creation-time attributes.
          "codec.sdk.call.mcp_server_count": 2,
        })

        const live = records.filter(record => record.name === "firegrid.test.live")
        const start = live.find(record => record.phase === "start")
        const end = live.find(record => record.phase === "end")

        expect(start).toBeDefined()
        expect(start?.attributes["codec.sdk.call.mcp_server_count"]).toBe(2)
        expect(end).toBeDefined()
      },
    )
  })

  it("tf-9ia9 default (FIREGRID_OTEL_FILE_PHASES unset) writes end records only — no in-flight start lines", async () => {
    await withEnv(
      { FIREGRID_OTEL_FILE_PHASES: undefined, OTEL_EXPORTER_OTLP_ENDPOINT: undefined },
      async () => {
        const filePath = path.join(
          mkdtempSync(path.join(tmpdir(), "fg-otel-endonly-")),
          "trace.jsonl",
        )
        const records = await captureSpanRecords(filePath, { "firegrid.test": true })

        const live = records.filter(record => record.name === "firegrid.test.live")
        expect(live.some(record => record.phase === "start")).toBe(false)
        expect(live.some(record => record.phase === "end")).toBe(true)
      },
    )
  })
})
