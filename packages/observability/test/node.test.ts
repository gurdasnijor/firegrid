import {
  checkFiregridOtelFileWritable,
  resolveFiregridOtelActiveExporter,
  resolveFiregridOtelFileDestination,
  spanToJsonLine,
} from "../src/node.ts"
import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
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
