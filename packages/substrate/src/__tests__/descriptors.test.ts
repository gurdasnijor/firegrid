import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  EventStream,
  EVENT_STREAM_ENVELOPE_TAG,
  EVENT_STREAM_ROW_TYPE,
  OPERATION_ENVELOPE_TAG,
  eventStreamEnvelopeFromStateRow,
  eventStreamStateKey,
  isEventStreamStateRow,
  isOperationEnvelope,
  makeEventStreamStateRow,
  Operation,
  OperationHandle,
  type OperationDescriptor,
  type EventStreamDescriptor,
} from "../descriptors/index.ts"

// firegrid-operation-messaging.OPERATIONS.1
// firegrid-operation-messaging.OPERATIONS.2
// firegrid-operation-messaging.OPERATIONS.4
// firegrid-event-streams.EVENT_STREAM_DEFINITION.1
// firegrid-event-streams.EVENT_STREAM_DEFINITION.2
// firegrid-event-streams.EVENT_STREAM_DEFINITION.3
// firegrid-event-streams.SCHEMA_OWNERSHIP.3
//
// Foundation tests for the descriptor namespaces. Type-level
// inference is asserted via @ts-expect-error rather than runtime
// behavior, since descriptors carry no runtime semantics.

describe("Operation.define — descriptor shape", () => {
  it("returns a frozen descriptor with name + schemas + _tag", () => {
    const Sleep = Operation.define({
      name: "Sleep",
      input: Schema.Struct({ ms: Schema.Number }),
      output: Schema.Struct({ slept: Schema.Boolean }),
    })
    expect(Sleep._tag).toBe("Operation")
    expect(Sleep.name).toBe("Sleep")
    expect(Sleep.input).toBeDefined()
    expect(Sleep.output).toBeDefined()
    expect(Sleep.error).toBeDefined()
    expect(Object.isFrozen(Sleep)).toBe(true)
  })

  it("error defaults to Schema.Never so Operation.Error<Op> is never by default", () => {
    const _Op = Operation.define({
      name: "X",
      input: Schema.String,
      output: Schema.String,
    })
    type _ErrShouldBeNever = Operation.Error<typeof _Op>
    const _check: _ErrShouldBeNever extends never ? true : false = true
    expect(_check).toBe(true)
  })
})

describe("Operation type helpers — inference is descriptor-driven", () => {
  const Echo = Operation.define({
    name: "Echo",
    input: Schema.Struct({ msg: Schema.String }),
    output: Schema.Struct({ msg: Schema.String, len: Schema.Number }),
    error: Schema.Struct({ _tag: Schema.Literal("Boom") }),
  })

  it("Operation.Input / Output / Error infer from descriptor", () => {
    const input: Operation.Input<typeof Echo> = { msg: "hi" }
    const output: Operation.Output<typeof Echo> = { msg: "hi", len: 2 }
    const err: Operation.Error<typeof Echo> = { _tag: "Boom" }
    expect(input.msg).toBe("hi")
    expect(output.len).toBe(2)
    expect(err._tag).toBe("Boom")
  })

  it("Operation.Input rejects mismatched payloads at the type level", () => {
    // @ts-expect-error msg must be string
    const _bad: Operation.Input<typeof Echo> = { msg: 42 }
    void _bad
  })

  it("Operation.Output rejects mismatched payloads at the type level", () => {
    // @ts-expect-error len must be number
    const _bad: Operation.Output<typeof Echo> = { msg: "x", len: "n" }
    void _bad
  })

  it("Operation.Any is the base type for descriptors", () => {
    const _any: Operation.Any = Echo
    void _any
  })
})

describe("OperationHandle — descriptor-bound handle", () => {
  const A = Operation.define({
    name: "A",
    input: Schema.String,
    output: Schema.Number,
  })
  const B = Operation.define({
    name: "B",
    input: Schema.Number,
    output: Schema.String,
  })

  it("OperationHandle.make produces a tagged handle bound to the descriptor", () => {
    const h = OperationHandle.make(A, "op_abc")
    expect(h._tag).toBe("OperationHandle")
    expect(h.id).toBe("op_abc")
    expect(h._operation).toBe("A")
  })

  it("handle types are not interchangeable across descriptors", () => {
    const ha = OperationHandle.make(A, "x")
    const consumeA = (_h: OperationHandle<typeof A>) => undefined
    consumeA(ha)
    const hb = OperationHandle.make(B, "y")
    // @ts-expect-error handle for B is not assignable to handle for A
    consumeA(hb)
  })

  it("same-name handles preserve the full descriptor type, not only the name", () => {
    const SameString = Operation.define({
      name: "Same",
      input: Schema.String,
      output: Schema.String,
    })
    const SameNumber = Operation.define({
      name: "Same",
      input: Schema.Number,
      output: Schema.Number,
    })
    const hs = OperationHandle.make(SameString, "same-string")
    const hn = OperationHandle.make(SameNumber, "same-number")
    const consumeSameString = (_h: OperationHandle<typeof SameString>) =>
      undefined
    consumeSameString(hs)
    // @ts-expect-error same operation name is not enough when schemas diverge
    consumeSameString(hn)
  })
})

describe("firegrid-remediation-hardening.CODE_REUSE.6 — operation envelope schema guard", () => {
  it("accepts the canonical operation envelope and rejects malformed envelope-like values", () => {
    expect(isOperationEnvelope({
      _envelope: OPERATION_ENVELOPE_TAG,
      operation: "Echo",
      payload: { msg: "hi" },
    })).toBe(true)

    expect(isOperationEnvelope({
      _envelope: OPERATION_ENVELOPE_TAG,
      payload: { msg: "hi" },
    })).toBe(false)
    expect(isOperationEnvelope(null)).toBe(false)
  })
})

describe("EventStream.define — descriptor shape", () => {
  it("returns a frozen descriptor with name + event Schema + _tag", () => {
    const Logs = EventStream.define({
      name: "Logs",
      event: Schema.Struct({
        id: Schema.String,
        level: Schema.Literal("info", "warn", "error"),
        message: Schema.String,
      }),
    })
    expect(Logs._tag).toBe("EventStream")
    expect(Logs.name).toBe("Logs")
    expect(Logs.event).toBeDefined()
    expect(Object.isFrozen(Logs)).toBe(true)
  })
})

describe("EventStream State Protocol helpers", () => {
  it("firegrid-event-streams.SCHEMA_OWNERSHIP.2 — makeEventStreamStateRow uses the schema-generated insert helper", () => {
    const row = makeEventStreamStateRow({
      stream: "Hits",
      eventId: "evt-1",
      event: { url: "/x" },
    })

    expect(row).toEqual({
      type: EVENT_STREAM_ROW_TYPE,
      key: eventStreamStateKey("Hits", "evt-1"),
      value: {
        _envelope: EVENT_STREAM_ENVELOPE_TAG,
        stream: "Hits",
        event: { url: "/x" },
      },
      headers: { operation: "insert" },
    })
    expect(isEventStreamStateRow(row)).toBe(true)
    expect(eventStreamEnvelopeFromStateRow(row)).toEqual(row.value)
  })
})

describe("EventStream type helpers — inference is descriptor-driven", () => {
  const _Hits = EventStream.define({
    name: "Hits",
    event: Schema.Struct({
      id: Schema.String,
      url: Schema.String,
      count: Schema.Number,
    }),
  })

  it("EventStream.Event infers from descriptor", () => {
    const e: EventStream.Event<typeof _Hits> = {
      id: "hit-1",
      url: "/x",
      count: 1,
    }
    expect(e.count).toBe(1)
  })

  it("EventStream.Event rejects mismatched payloads at the type level", () => {
    const _bad: EventStream.Event<typeof _Hits> = {
      id: "hit-1",
      url: "/x",
      // @ts-expect-error count must be number
      count: "1",
    }
    void _bad
  })

  it("EventStream.EncodedEvent matches the schema's encoded shape", () => {
    const encoded: EventStream.EncodedEvent<typeof _Hits> = {
      url: "/x",
      id: "hit-1",
      count: 1,
    }
    expect(encoded.count).toBe(1)
  })

  it("EventStream.Event/EncodedEvent diverge under a transforming schema", () => {
    // Encoded form is a string; decoded form is a number. The
    // type helpers must surface the two distinct types so callers
    // can encode for the wire and decode at the boundary.
    const _Counts = EventStream.define({
      name: "Counts",
      event: Schema.Struct({
        id: Schema.String,
        kind: Schema.Literal("count"),
        n: Schema.NumberFromString,
      }),
    })
    const decoded: EventStream.Event<typeof _Counts> = {
      id: "count-1",
      kind: "count",
      n: 7,
    }
    const encoded: EventStream.EncodedEvent<typeof _Counts> = {
      id: "count-1",
      kind: "count",
      n: "7",
    }
    expect(decoded.n).toBe(7)
    expect(encoded.n).toBe("7")

    const _badEncoded: EventStream.EncodedEvent<typeof _Counts> = {
      id: "count-1",
      kind: "count",
      // @ts-expect-error encoded `n` must be a string
      n: 7,
    }
    void _badEncoded

    const _badDecoded: EventStream.Event<typeof _Counts> = {
      id: "count-1",
      kind: "count",
      // @ts-expect-error decoded `n` must be a number
      n: "7",
    }
    void _badDecoded
  })
})

describe("Operation type helpers — encoded surfaces are derived from schemas", () => {
  it("Operation.EncodedInput / EncodedOutput / EncodedError diverge under transforming schemas", () => {
    // Decoded `Date`; encoded ISO string. NumberFromString is the
    // standard transforming pair.
    const _TimedEcho = Operation.define({
      name: "TimedEcho",
      input: Schema.Struct({ ms: Schema.NumberFromString }),
      output: Schema.Struct({ ms: Schema.NumberFromString }),
      error: Schema.Struct({
        _tag: Schema.Literal("Late"),
        afterMs: Schema.NumberFromString,
      }),
    })

    const dInput: Operation.Input<typeof _TimedEcho> = { ms: 5 }
    const eInput: Operation.EncodedInput<typeof _TimedEcho> = { ms: "5" }
    const dOutput: Operation.Output<typeof _TimedEcho> = { ms: 10 }
    const eOutput: Operation.EncodedOutput<typeof _TimedEcho> = { ms: "10" }
    const dError: Operation.Error<typeof _TimedEcho> = {
      _tag: "Late",
      afterMs: 50,
    }
    const eError: Operation.EncodedError<typeof _TimedEcho> = {
      _tag: "Late",
      afterMs: "50",
    }
    expect(dInput.ms).toBe(5)
    expect(eInput.ms).toBe("5")
    expect(dOutput.ms).toBe(10)
    expect(eOutput.ms).toBe("10")
    expect(dError.afterMs).toBe(50)
    expect(eError.afterMs).toBe("50")

    const _badEncodedInput: Operation.EncodedInput<typeof _TimedEcho> = {
      // @ts-expect-error encoded `ms` must be a string
      ms: 5,
    }
    void _badEncodedInput
  })
})

describe("Descriptor module independence", () => {
  it("descriptor types are structural and exportable", () => {
    const op: OperationDescriptor = {
      _tag: "Operation",
      name: "X",
      input: Schema.Unknown,
      output: Schema.Unknown,
      error: Schema.Never,
    }
    const ev: EventStreamDescriptor = {
      _tag: "EventStream",
      name: "Y",
      event: Schema.Unknown,
    }
    expect(op._tag).toBe("Operation")
    expect(ev._tag).toBe("EventStream")
  })

  it("descriptor schema fields reject non-schema values at the type level", () => {
    Operation.define({
      name: "T",
      // @ts-expect-error 42 is not a Schema
      input: 42,
      output: Schema.String,
    })
    EventStream.define({
      name: "S",
      // @ts-expect-error a plain object literal is not a Schema
      event: { foo: "bar" },
    })
  })
})
