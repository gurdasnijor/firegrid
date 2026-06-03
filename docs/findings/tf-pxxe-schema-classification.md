# tf-pxxe — Schema classification: findings

**Status:** evidence only. No schema moved, renamed, or refactored. No registry/redesign proposed.
**Artifacts (machine-generated, re-run with `pnpm inventory:schemas`):**
- `docs/findings/tf-pxxe-schema-inventory.md` — the full classification (summary, CRUD-vs-primitive tally, boundary→role matrix, every schema grouped, ambiguous list).
- `docs/findings/tf-pxxe-schema-inventory.json` — the same, machine-readable.
- `scripts/schema-inventory.ts` — the tool. It **extends** the tf-7whh operation inventory: it imports that tool's reflection/AST machinery and its `build()` output, so the role axis is cross-referenced against the authoritative operation/channel surfaces, not re-derived.

This note interprets those artifacts. Every count is reproducible from the JSON.

## Cutting the fog: 1827 → 256

The "1827 `Schema.` hits across 89 files" count is mostly *nested field types* (`Schema.String` inside a struct). The classifiable unit is the **named schema declaration**: there are **256** of them across **213** source files (`packages/*/src`, non-test). The tool enumerates them by AST (so it catches module-private schemas and schema *classes*, not just `export const *Schema`) — a grep of `export const *Schema` finds only 196; the tool finds 218 exported + 38 private, because branded ids, error classes, and class-based schemas don't follow the name convention. (The name convention undercounts — verified, not assumed.)

## 1. The volume, by role

| role | count | what it is |
| --- | --- | --- |
| internal-DTO | 139 | single-use (reuse < 2), module-local request/response fragments and sub-shapes |
| error | 24 | `Schema.TaggedError` / `TaggedRequest` types |
| durable-table-row | 23 | a field piped through `DurableTable.primaryKey` |
| operation-input | 21 | carries `firegridProjection` (15 agent-tool + 6 session-facade) |
| operation-output | 18 | the paired `*Output/Response/Result` on a projection surface |
| shared-leaf-primitive | 12 | reused by ≥2 modules but bound to no operation/channel/row/event surface — the shared contracts |
| agent-output-event | 9 | `Schema.TaggedStruct` egress events |
| channel-request | 8 | `make*Channel` requestSchema / egress payload |
| channel-response | 2 | `make*Channel` responseSchema |

**The legibility headline:** only **58** of 256 schemas are *surface* contracts (21 op-in + 18 op-out + 10 channel + 9 event). The remaining ~77% is **139 single-use internal DTOs + 24 errors + 23 durable rows + 12 shared contracts**. The PO's "which schema, which boundary, which role" fog is mostly *single-use internal DTOs* — schemas that exist to shape one operation's payload and are never reused.

> Method note worth recording: a first cut bucketed 175 schemas (68%) as "internal-DTO" — itself a new fog. Two fixes made it legible: (a) an AST bug recorded `annotations`/`pipe` as the root constructor for any `Schema.X(…).annotations(…)` chain (the chain's leftmost identifier is still `Schema`); fixing the recursion order recovered the real ctors and split out the 24 `TaggedError`s. (b) `shared-leaf-primitive` was gated on *scalar* ctors and never fired — because in this codebase **scalar leaves are inlined, not shared** (e.g. `RuntimeInputDeliveryKey`, a branded key, has reuse 0 — used only in its declaring file). The reused schemas are small structs/unions/errors, so the role was redefined as "reused (≥2 modules), unbound to a surface." (The count is not the truth — both buckets were artifacts until verified per-item.)

## 2. Boundary / airgap signal (substrate-coupled vs pure contract)

`substrate` = the schema's module transitively imports `effect-durable-operators` (the durable substrate) — i.e. it cannot be a pure contract. **56 of 256** schemas are substrate-coupled; **200** are pure contract.

| package | schemas | substrate-coupled | reading |
| --- | --- | --- | --- |
| protocol | 191 | **31** | the "contract" package is *not* fully airgapped — its durable-table-row + some channel schemas pull `DurableTable` in (dirs: `launch`, `channels`, `runtime-ingress`) |
| runtime | 59 | 22 | expected — runtime owns the substrate wiring (`engine`, `unified`, `sources`, `verified-webhook-ingest`) |
| client-sdk | 2 | **0** | airgap holds at the client edge — the client declares only its own errors and *reuses* protocol contracts |
| cli / host-sdk / observability | 0 | 0 | declare no schemas — they reuse protocol/runtime contracts |
| tiny-firegrid | 3 | 3 | simulation harness, composes substrate |

**The airgap finding:** the client edge (client-sdk, cli) is clean — zero substrate-coupled schema declarations. The coupling that *does* exist inside the "pure contract" layer is **protocol's 31 substrate-coupled schemas**, concentrated in the durable-table-row dirs (`launch/control-request.ts`, `launch/table.ts`, `runtime-ingress/schema.ts`, `channels/session-log.ts`). Those rows import `DurableTable.primaryKey`, so the contract package transitively depends on the substrate. That is the seam where "pure protocol" and "durable substrate" are not actually separated. (Reported as ground truth; no recommendation.)

> Caveat: the `substrate` flag is "imports `effect-durable-operators`", so the substrate package's *own* files read `false` (they are the root, not importers). The signal is about consumers coupling to substrate, which is the airgap question.

## 3. The specific question — CRUD/projection vs workflow-primitive

Hypothesis: *client lifecycle + observe ops reduce to CRUD/projection over a DurableTable; the agent durable-wait ops do not.*

The tool resolves each canonical operation to its lowering mechanism (sourced from the runtime, each evidence **token verified present** at the cited file — all 19 verified ✓) and buckets it:

| bucket | count | operations |
| --- | --- | --- |
| **workflow-primitive** | 5 | `sleep`, `wait.until` (`Clock.sleep`), `wait.for` (dispatch `wait_for` + `raceFirst`), `wait.any` (`raceAll`), `channel.call` (req/res `dispatch` verb `call`) |
| **crud-over-durable-table** | 10 | `session.create`/`createOrLoad` (`control.contexts.insertOrGet`), `session.cancel`/`close`/`prompt` + `permission.respond` + `channel.send` (durable-event append), `session.attach`, `session.wait.forAgentOutput`/`forPermissionRequest` (ingress read/subscribe) |
| **unported** | 4 | `session.status`, `session.spawn`, `session.spawnAll`, `capability.execute` — hit the `default` ("not yet ported onto the unified executor") in `tool-dispatch.ts`; no lowering to classify |

**Verdict (data): the hypothesis is confirmed.** Every `agent-durable-wait` op is a workflow primitive (`DurableClock`/race), reducing to **none** of the table CRUD verbs. Every client `lifecycle`/`observe` op that *has* a lowering reduces to a DurableTable `insertOrGet` or a durable-event append/read. The split is clean along the agent-vs-client line — with the honest caveat that the four unported ops (including the agent `spawn` family) have no lowering yet and so cannot be lowered-classified; their bucket is `unported`, not guessed.

The one nuance: `channel.call` is the lone *client-reachable* op that is a primitive (req/res), and `channel.send` is CRUD-family (append) — consistent with the task's own taxonomy ("req/res call" = primitive).

## 4. Confidence & what's flagged for a human (§5 of the inventory)

- **9 schemas** are flagged `detection=alias` (lower confidence): `const X = SomeSchema` / `X.pipe(…)` aliases where the base is an imported schema (e.g. `HostSessionsCreateOrLoadRequestSchema`, `RuntimeContextIdSchema`). They are real schemas, but the tool cannot prove from AST alone that they aren't thin re-exports. Listed, not silently bucketed.
- **Cross-surface role precedence** is a cascade (operation → channel → event → error → row → config → shared-leaf → internal-DTO). A schema that plays two roles (e.g. a row that is also a channel payload) is recorded under the higher-precedence one; its `basis` names which.
- **Reuse fan-out** follows relative imports, `@firegrid/*` package-export subpaths, and one–three hops of `export *` barrels. Deeply re-exported schemas may undercount; spot-checked against grep (`RuntimeRunEventSchema` reuse 3 = 5 textual hits − declaration − barrel).
- **Unported ops** are evidence of incompleteness in the MCP executor, not a classification gap.
