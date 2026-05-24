// Focused transforms/ test: evaluateFieldEquals is callable with NO Effect
// environment. The transforms purity rule for the Shape C cutover requires
// every exported transform to be reasoned about in isolation
// (docs/cannon/architecture/runtime-pipeline-type-boundaries.md
// §"Enforcement Checklist" item 7).

import { describe, expect, it } from "vitest"
import {
  evaluateFieldEquals,
  type FieldEqualsTrigger,
} from "../../src/transforms/field-equals.ts"

describe("transforms/field-equals (pure)", () => {
  it("matches when every predicate path equals the row value", () => {
    const trigger: FieldEqualsTrigger = [
      { path: ["event", "_tag"], equals: "TurnComplete" },
      { path: ["contextId"], equals: "ctx_a" },
    ]
    const row = { contextId: "ctx_a", event: { _tag: "TurnComplete" } }

    expect(evaluateFieldEquals(trigger, row)).toBe(true)
  })

  it("rejects when any predicate mismatches", () => {
    const trigger: FieldEqualsTrigger = [
      { path: ["event", "_tag"], equals: "TurnComplete" },
    ]
    const row = { event: { _tag: "TextChunk" } }

    expect(evaluateFieldEquals(trigger, row)).toBe(false)
  })

  it("supports numeric and boolean equals predicates", () => {
    const trigger: FieldEqualsTrigger = [
      { path: ["sequence"], equals: 3 },
      { path: ["terminal"], equals: true },
    ]
    expect(evaluateFieldEquals(trigger, { sequence: 3, terminal: true })).toBe(true)
    expect(evaluateFieldEquals(trigger, { sequence: 2, terminal: true })).toBe(false)
  })

  it("treats non-object rows as a non-match without throwing", () => {
    const trigger: FieldEqualsTrigger = [{ path: ["x"], equals: "y" }]
    expect(evaluateFieldEquals(trigger, null)).toBe(false)
    expect(evaluateFieldEquals(trigger, "string-row")).toBe(false)
  })

  it("an empty trigger trivially matches any object row", () => {
    expect(evaluateFieldEquals([], { anything: 1 })).toBe(true)
  })
})
