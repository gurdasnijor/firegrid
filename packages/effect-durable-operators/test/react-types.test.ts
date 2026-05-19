import { eq } from "@tanstack/db"
import { createElement } from "react"
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { DurableTable } from "../src/index.ts"
import {
  DurableTableProvider,
  type DurableTableProviderProps,
  useDurableLiveQuery,
  useDurableTable,
  useDurableTableProviderStatus,
} from "../src/react.ts"
import type { DurableTableError } from "../src/index.ts"

class ReactWorkflowTable extends DurableTable<ReactWorkflowTable>()("react-workflow", {
  executions: Schema.Struct({
    executionId: Schema.String.pipe(DurableTable.primaryKey),
    workflowName: Schema.String,
  }),
}) {}

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
    // Explicit-props (by-name) path: `react-types.test.ts` is a `.ts`
    // file so it cannot use JSX, and `React.createElement` does not
    // infer a generic component's own type parameters from its props.
    // flamecast uses JSX and infers `ROut` from the layer; here the
    // by-name path pins the concrete props type. This is the legitimate
    // explicit-props usage of the seam — no cast, no `any`, no paper.
    const app = createElement<
      DurableTableProviderProps<ReactWorkflowTable, DurableTableError>
    >(
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
