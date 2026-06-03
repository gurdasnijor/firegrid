// tf-0awo.3 — operationId-uniqueness gate.
//
// The protocol schemas are the single source of truth; the
// agent-tool / client / CLI bindings PROJECT from each schema's
// `operationId` (the `firegridProjection` annotation on the input schema). If
// two DISTINCT operations carried the same operationId, projection would
// silently collide — one operation's projected tool/method would shadow the
// other. This gate makes that non-compiling-adjacent: a duplicate fails the
// protocol test run, loud.
//
// Subtlety this gate handles correctly: a single operation is legitimately
// projected onto more than one surface by REUSING the same input schema object
// across surfaces (e.g. the client cancel surface reuses agent-tools'
// `SessionCancelToolInputSchema`, so `session.cancel` appears twice via the
// SAME schema). That is one operation, not a collision.
// So the invariant is keyed on schema IDENTITY: every operationId must be
// backed by exactly one distinct input schema. A collision = one operationId
// backed by two or more DISTINCT schemas.

import type { SchemaAST } from "effect"
import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  FiregridAgentToolOperations,
  PermissionRespondInputSchema,
  SessionCancelToolInputSchema,
  SessionCancelToolOutputSchema,
  SessionCloseToolInputSchema,
  SessionCloseToolOutputSchema,
  SessionPromptToolInputSchema,
  SessionPromptToolOutputSchema,
} from "@firegrid/protocol/agent-tools"
import { EventOffsetSchema } from "@firegrid/protocol/channels"
import {
  SessionAgentOutputWaitInputSchema,
  SessionAgentOutputWaitOutputSchema,
  SessionAttachInputSchema,
  SessionCreateOrLoadInputSchema,
  SessionHandlePromptInputSchema,
  SessionHandleReferenceSchema,
  SessionPermissionRequestWaitInputSchema,
  SessionPermissionRequestWaitOutputSchema,
  SessionPermissionRespondInputSchema,
} from "@firegrid/protocol/session-facade"
import {
  firegridProjection,
  getFiregridProjectionMetadata,
} from "@firegrid/protocol/projection"

interface SchemaLike {
  readonly ast: SchemaAST.AST
}

interface OperationLike {
  readonly input: SchemaLike
  readonly output: unknown
}

interface CatalogEntry {
  readonly path: string
  readonly input: SchemaLike
}

// Effect `Schema` instances are CALLABLE — `typeof schema === "function"` —
// with an `ast` property, so accept both functions and objects here.
const isSchemaLike = (value: unknown): value is SchemaLike =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  "ast" in value &&
  typeof (value as { ast?: unknown }).ast === "object"

const isOperation = (value: unknown): value is OperationLike =>
  typeof value === "object" &&
  value !== null &&
  "input" in value &&
  "output" in value &&
  isSchemaLike((value as { input?: unknown }).input)

// Walk a catalog (flat or nested groups) and collect every {input,output}
// operation leaf with its dotted path (for actionable failure messages).
const collectOperations = (
  node: unknown,
  path: string,
  out: Array<CatalogEntry>,
): void => {
  if (isOperation(node)) {
    out.push({ path, input: node.input })
    return
  }
  if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      collectOperations(value, path === "" ? key : `${path}.${key}`, out)
    }
  }
}

const ClientSchemaOperations = {
  sessions: {
    createOrLoad: {
      input: SessionCreateOrLoadInputSchema,
      output: SessionHandleReferenceSchema,
    },
    attach: {
      input: SessionAttachInputSchema,
      output: SessionHandleReferenceSchema,
    },
    prompt: {
      input: SessionPromptToolInputSchema,
      output: SessionPromptToolOutputSchema,
    },
    promptScoped: {
      input: SessionHandlePromptInputSchema,
      output: EventOffsetSchema,
    },
    cancel: {
      input: SessionCancelToolInputSchema,
      output: SessionCancelToolOutputSchema,
    },
    close: {
      input: SessionCloseToolInputSchema,
      output: SessionCloseToolOutputSchema,
    },
  },
  wait: {
    forAgentOutput: {
      input: SessionAgentOutputWaitInputSchema,
      output: SessionAgentOutputWaitOutputSchema,
    },
    forPermissionRequest: {
      input: SessionPermissionRequestWaitInputSchema,
      output: SessionPermissionRequestWaitOutputSchema,
    },
  },
  permissions: {
    respond: {
      input: PermissionRespondInputSchema,
      output: EventOffsetSchema,
    },
    respondScoped: {
      input: SessionPermissionRespondInputSchema,
      output: EventOffsetSchema,
    },
  },
} as const

// Collision detector: operationId -> distinct input-schema identities. A
// collision is any operationId backed by >1 DISTINCT schema (reuse of one
// schema object across catalogs is one operation, not a collision). Returns a
// human-readable description per collision.
const collisionsOf = (entries: ReadonlyArray<CatalogEntry>): Array<string> => {
  const schemasById = new Map<string, Set<SchemaLike>>()
  const pathsById = new Map<string, Array<string>>()
  for (const entry of entries) {
    const metadata = getFiregridProjectionMetadata(entry.input)
    if (Option.isNone(metadata)) continue
    const { operationId } = metadata.value
    const schemas = schemasById.get(operationId) ?? new Set<SchemaLike>()
    schemas.add(entry.input)
    schemasById.set(operationId, schemas)
    const paths = pathsById.get(operationId) ?? []
    paths.push(entry.path)
    pathsById.set(operationId, paths)
  }
  return [...schemasById.entries()]
    .filter(([, schemas]) => schemas.size > 1)
    .map(([operationId, schemas]) =>
      `${operationId} (backed by ${schemas.size} distinct schemas; at ${pathsById.get(operationId)!.join(", ")})`,
    )
}

describe("firegrid-schema-projection-contract — operationId uniqueness gate (tf-0awo.3)", () => {
  const entries: Array<CatalogEntry> = []
  collectOperations(FiregridAgentToolOperations, "agentTools", entries)
  collectOperations(ClientSchemaOperations, "client", entries)

  it("enumerates operations from both catalogs", () => {
    // Sanity: the walker found the operations (guards against a refactor that
    // changes the catalog shape so the walker silently collects nothing).
    expect(entries.length).toBeGreaterThanOrEqual(
      Object.keys(FiregridAgentToolOperations).length,
    )
  })

  it("every catalog operation carries projection metadata (an operationId)", () => {
    const missing = entries
      .filter((entry) => Option.isNone(getFiregridProjectionMetadata(entry.input)))
      .map((entry) => entry.path)
    expect(
      missing,
      `operations missing a firegridProjection operationId: ${missing.join(", ")}`,
    ).toEqual([])
  })

  it("no two DISTINCT operations share an operationId across agent-tools + session-facade", () => {
    const collisions = collisionsOf(entries)
    expect(
      collisions,
      `operationId collision — distinct operations share an id (projection would shadow one):\n${collisions.join("\n")}`,
    ).toEqual([])

    // Headline invariant (the task's "set size == count", reuse-corrected):
    // distinct operationIds biject with distinct operation schemas — equivalent
    // to "no collision AND no missing id".
    const distinctSchemas = new Set(entries.map((entry) => entry.input))
    const distinctIds = new Set(
      entries
        .map((entry) => getFiregridProjectionMetadata(entry.input))
        .filter(Option.isSome)
        .map((metadata) => metadata.value.operationId),
    )
    expect(
      distinctIds.size,
      "distinct operationIds must equal distinct operation schemas (no collision, no missing)",
    ).toBe(distinctSchemas.size)
  })

  // Proves the gate BITES: two DISTINCT schemas sharing an operationId is a
  // collision the detector flags (guards against a vacuous always-pass).
  it("detects a synthetic duplicate operationId (the gate is not vacuous)", () => {
    const dupId = "synthetic.duplicate"
    const schemaA = Schema.Struct({ a: Schema.String }).annotations(
      firegridProjection({ operationId: dupId }),
    )
    const schemaB = Schema.Struct({ b: Schema.Number }).annotations(
      firegridProjection({ operationId: dupId }),
    )
    const synthetic: Array<CatalogEntry> = [
      { path: "synthetic.a", input: schemaA },
      { path: "synthetic.b", input: schemaB },
    ]
    const collisions = collisionsOf(synthetic)
    expect(collisions).toHaveLength(1)
    expect(collisions[0]).toContain(dupId)

    // And reuse of the SAME schema object is NOT a collision (the legitimate
    // cross-surface projection case).
    const reused: Array<CatalogEntry> = [
      { path: "reuse.x", input: schemaA },
      { path: "reuse.y", input: schemaA },
    ]
    expect(collisionsOf(reused)).toEqual([])
  })
})
