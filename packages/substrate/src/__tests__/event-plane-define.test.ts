import { createStateSchema } from "@durable-streams/state"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { EventPlane } from "../event-plane/index.js"

// client-event-plane-registration.EVENT_PLANE_DEFINITION.4
// Substrate vocabulary deliberately excludes Fireline / Firepixel / ACP /
// MCP / Claude / Codex / provider / sandbox / prompt / session / tool-call
// words. The example plane below uses an arbitrary domain name so the
// substrate-native row family list stays clean.
const ExampleRow = Schema.Struct({
  id: Schema.String,
  status: Schema.Literal("pending", "ready"),
  payload: Schema.optional(Schema.Unknown),
})
type ExampleRow = Schema.Schema.Type<typeof ExampleRow>

const buildExampleState = () =>
  createStateSchema({
    rows: {
      type: "example.adapter.row",
      primaryKey: "id",
      schema: Schema.standardSchemaV1(ExampleRow),
    },
  })

describe("client-event-plane-registration.EVENT_PLANE_DEFINITION.1 — plane is a typed value with name + state + Producer/Projection tags", () => {
  it("returns a plane with the supplied name, the original state schema, and per-plane Context.Tag identifiers", () => {
    const state = buildExampleState()
    const plane = EventPlane.define({ name: "example.adapter", state })
    expect(plane.name).toBe("example.adapter")
    expect(plane.state).toBe(state)
    // Tag identity is the key string; per-plane keys use the plane name.
    expect(plane.Producer.key).toBe("event-plane/example.adapter/Producer")
    expect(plane.Projection.key).toBe("event-plane/example.adapter/Projection")
  })
})

describe("client-event-plane-registration.EVENT_PLANE_DEFINITION.3 — no global registry mutated by define", () => {
  it("two define calls for different names produce different Context.Tag identities", () => {
    const a = EventPlane.define({ name: "example.a", state: buildExampleState() })
    const b = EventPlane.define({ name: "example.b", state: buildExampleState() })
    expect(a.Producer.key).not.toBe(b.Producer.key)
    expect(a.Projection.key).not.toBe(b.Projection.key)
  })

  it("two define calls for the same name produce equivalent Tag identities (deterministic, not registry-mutating)", () => {
    // Deterministic Tag identity from the plane name is NOT a hidden mutable
    // registry; substrate maintains no module-level state about previously
    // defined planes. Calling define twice with the same name simply yields
    // Tags that resolve to the same key.
    const a = EventPlane.define({ name: "example.same", state: buildExampleState() })
    const b = EventPlane.define({ name: "example.same", state: buildExampleState() })
    expect(a.Producer.key).toBe(b.Producer.key)
    expect(a.Projection.key).toBe(b.Projection.key)
  })
})

describe("client-event-plane-registration.EVENT_PLANE_DEFINITION.2 — Effect Schema source of truth, Standard Schema for DSS interop only", () => {
  it("typed insert via state helpers produces a ChangeEvent whose value passes the Effect Schema decoder", () => {
    const state = buildExampleState()
    const plane = EventPlane.define({ name: "example.adapter", state })
    const event = plane.state.rows.insert({
      value: { id: "r-1", status: "pending" },
    })
    expect(event.type).toBe("example.adapter.row")
    expect(event.key).toBe("r-1")
    const decoded = Schema.decodeUnknownSync(ExampleRow)(event.value)
    expect(decoded).toEqual({ id: "r-1", status: "pending" })
  })
})
