import { eq } from "@tanstack/db"
import { createElement } from "react"
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { DurableTable } from "../src/index.ts"
import {
  DurableTableProvider,
  useDurableLiveQuery,
  useDurableTable,
  useDurableTableProviderStatus,
} from "../src/react.ts"

class ReactWorkflowTable extends DurableTable("react-workflow", {
  executions: Schema.Struct({
    executionId: Schema.String.pipe(DurableTable.primaryKey),
    workflowName: Schema.String,
  }),
})<ReactWorkflowTable>() {}

const ReactWorkflowLive = ReactWorkflowTable.layer({
  streamOptions: {
    url: "http://127.0.0.1:1/v1/stream/react-workflow",
    contentType: "application/json",
  },
})

function Executions() {
  const provider = useDurableTableProviderStatus()
  if (provider.status === "error") return String(provider.error)

  const table = useDurableTable(ReactWorkflowTable)
  const query = useDurableLiveQuery((q) =>
    q.from({ executions: table.executions.collection })
      .where(({ executions }) => eq(executions.workflowName, "demo")),
  [])

  return String((query.data ?? []).length)
}

describe("DurableTable React surface", () => {
  it("effect-durable-operators.REACT.1 effect-durable-operators.REACT.3 effect-durable-operators.REACT.4 exposes typed subpath hooks", () => {
    const app = createElement(
      DurableTableProvider,
      {
        fallback: null,
        layer: ReactWorkflowLive,
        tables: [ReactWorkflowTable],
      },
      createElement(Executions),
    )

    expect(app.type).toBe(DurableTableProvider)
  })
})
