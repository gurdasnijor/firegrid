import { Given, When, Then, DataTable } from "@cucumber/cucumber"
import assert from "node:assert/strict"
import type { Envelope, FluentWorld } from "../support/world.ts"

Given("an in-memory durable stream", function (this: FluentWorld) {
  // The World starts with an empty in-memory stream; nothing else to set up.
})

When(
  "the bridge records a/an {string} envelope {string}",
  function (this: FluentWorld, direction: string, payload: string) {
    this.append({ direction: direction as Envelope["direction"], payload })
  },
)

Then(
  "the stream contents are, in order:",
  function (this: FluentWorld, table: DataTable) {
    const expected = table
      .hashes()
      .map((row) => ({ direction: row.direction, payload: row.payload }))
    const actual = this.readStream().map((e) => ({
      direction: e.direction,
      payload: String(e.payload),
    }))
    assert.deepEqual(actual, expected)
  },
)
