# tf-w0c2 Runtime Structural Drift Map

Date: 2026-06-02

Scope: findings only. This note does not bless a target structure and does not
propose file moves. It records navigation drift that should feed the
canonical-op-registry work (`tf-7whh`) and the runtime-legibility decision.

## Findings

### 1. The runtime root still mixes the pre-unified target tree with `unified/`

`packages/runtime/src/README.md:21-31` lists `subscribers/` and `composition/`
as target surfaces beside `unified/`, and says a
`scripts/runtime-public-surface-check.mjs` guard enforces that list at
`packages/runtime/src/README.md:16-17`. The current root `package.json` lint
script is only `eslint . --max-warnings 0 --cache --cache-location .eslintcache`
at `package.json:17`, with preflight invoking that lint through
`package.json:21`; the named runtime surface script is no longer wired there.

At the same time, `packages/runtime/src/unified/README.md:3-10` says
`unified/` owns the temporary composition replacing the deleted pre-unified
`subscribers/` and `composition/` roots and is not the long-term layer.

Navigation cost: readers get two incompatible maps on the first page: one table
that says the pre-unified roots are first-class surfaces, and one unified README
that says those roots were replaced during stabilization. A new maintainer
cannot tell whether to add a workflow body under `subscribers/`, under
`unified/subscribers/`, or behind a future post-unified target tree.

### 2. `producers/` is retired in the current source surface but still appears in
older architecture maps and tier rules

Part A retired the empty `packages/runtime/src/producers/` husk and removed the
legacy `@firegrid/runtime/producers/{sandbox,codecs}*` aliases. The current
runtime package exports now expose `sources/*`, `channels/*`, `transforms`, and
`unified`, with no `producers/*` entries in
`packages/runtime/package.json:36-99`. The local source README states the legacy
producer aliases are retired at `packages/runtime/src/sources/README.md:61-62`.

Older architecture docs still teach the pre-unified producer tier:
`docs/architecture/2026-05-22-runtime-physical-target-tree.md:76-78` places
`producers/` in the target tree, and
`docs/architecture/2026-05-22-runtime-physical-target-tree.md:236-240` gives a
preferred public subpath under `@firegrid/runtime/producers/...`.
`packages/runtime/src/channels/README.md:3-5` still describes `channels/` as a
peer of `producers/`, and `packages/runtime/src/channels/README.md:162-165`
still lists `producers/` in the must-not-import tier.

Navigation cost: "producer" now names at least three things: a deleted runtime
folder, historical public aliases, and still-present write-authority language.
The same reader must reconcile `sources/` as the live emitter surface with a
producer tier that no longer has files or exports.

### 3. Protocol session creation is split across `channels/`, `launch/`, and
`session-facade/`

The protocol channel package owns channel contracts, per-channel tags, schemas,
and route metadata at `packages/protocol/src/channels/index.ts:4-19`.
`host.contexts.create` carries `runtime`, `createdBy`, and `parentContextId` in
`packages/protocol/src/channels/host-control.ts:31-35`. A parallel session
creation contract uses `SessionCreateOrLoadInputSchema` in
`packages/protocol/src/channels/host-sessions-create-or-load.ts:30-46`.

The launch package separately owns runtime intent and runtime context rows:
`RuntimeContextIntentSchema` and `PublicLaunchRuntimeIntentSchema` are defined
at `packages/protocol/src/launch/schema.ts:264-275`, while the durable
`RuntimeContextSchema` includes `createdBy`, `parentContextId`, `runtime`, and
`host` at `packages/protocol/src/launch/schema.ts:475-482`. The durable control
plane table then defines the `contexts` family from `RuntimeContextRowSchema` at
`packages/protocol/src/launch/table.ts:151-180`.

Navigation cost: the same "create or bind a runtime-backed session/context"
concept requires jumping between channel files, launch schema files, launch
table files, and session-facade operation schemas. The split is defensible, but
the package layout does not make the conceptual route obvious.

### 4. Agent-output observation projection has four entry points

The canonical protocol schema owns `RuntimeAgentOutputObservationSchema` at
`packages/protocol/src/session-facade/schema.ts:276-293` and the row projection
schema/function at `packages/protocol/src/session-facade/schema.ts:516-551`.
Runtime then re-exports the projection from
`packages/runtime/src/transforms/decode-output-row.ts:1-16`, preserves a legacy
event shim in `packages/runtime/src/events/output.ts:1-16`, and uses the same
projection in the live session-output channel at
`packages/runtime/src/channels/session-agent-output.ts:29-46`.

Navigation cost: a reader looking for "where output rows become observations"
can land in protocol, transforms, events, or channels. The current implementation
does centralize behavior in protocol, but the surrounding compatibility paths
make ownership look broader than it is.

### 5. Current runtime docs still point at public subpaths that are not package
exports

`packages/runtime/ARCHITECTURE.md:28-31` lists public subpaths under
`@firegrid/runtime/composition/*` and `@firegrid/runtime/subscribers/*`.
The current export map in `packages/runtime/package.json:36-99` includes
`./unified`, `./events`, `./sources/*`, `./channels/*`, `./agent-adapters`, and
`./transforms`, but not those composition or subscriber subpaths.

Navigation cost: public-surface docs and package exports disagree. That makes
the package boundary harder to audit and encourages callers to search for
non-exported paths.

## Exclusions

- This note does not recommend recreating `producers/`, `subscribers/`, or
  `composition/`.
- This note does not recommend moving live code out of `unified/`.
- Existing historical architecture docs are left in place; they are cited here
  as evidence for the later structure decision.
