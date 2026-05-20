import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  firegridProjection,
  getFiregridProjectionMetadata,
} from "@firegrid/protocol/projection"

describe("projection metadata schema helpers", () => {
  it("firegrid-schema-projection-contract.SCHEMA_CATALOG.4 stores projection metadata as schema annotations", () => {
    const schema = Schema.Struct({
      value: Schema.String,
    }).annotations({
      ...firegridProjection({
        operationId: "example.projected",
        toolName: "example_projected",
        clientName: "example.projected",
      }),
    })

    expect(Option.getOrUndefined(getFiregridProjectionMetadata(schema))).toEqual({
      operationId: "example.projected",
      toolName: "example_projected",
      clientName: "example.projected",
    })
  })
})
