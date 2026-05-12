# Tracer 019: Session Input Row Rename

Status: active cleanup tracer.

Tracer 019 deletes the transitional `runtime_ingress` physical vocabulary from
current code. The durable input fact remains append-only and provider-neutral,
but its canonical wire row type and package namespaces now use session-input
language.

## Goal

```txt
Firegrid.prompt(...)
  -> append firegrid.session.input durable fact
  -> FiregridRuntimeHostLive consumes session input with DurableConsumer
  -> local-process provider receives stdin
  -> runtime output proves provider-visible delivery
```

This tracer is a rename and boundary cleanup only. It does not add a new
delivery protocol, workflow endpoint, materialization surface, compatibility
shim, cancellation, close, replay, or query API.

## Acceptance

- `features/firegrid/firegrid-agent-ingress.feature.yaml` treats session input
  as canonical vocabulary while keeping the stable `firegrid-agent-ingress.*`
  ACIDs.
- The durable input row type is `firegrid.session.input`.
- Protocol session input schemas live under
  `packages/protocol/src/session-input/**`.
- Runtime session input code lives under
  `packages/runtime/src/session-input/**`.
- `@firegrid/runtime` exports `appendSessionInput`, not
  `appendRuntimeIngress`.
- `Firegrid.prompt(...)` continues to append input facts and returns the
  appended `SessionInputRow`.
- Runtime host input delivery still uses
  `effect-durable-operators.DurableConsumer` and
  `ConsumerCheckpointStoreLive`.
- Tracer 012, 016, and 017 scenario proofs still pass with production package
  surfaces.

## Files Touched

- `features/firegrid/firegrid-agent-ingress.feature.yaml`
- `packages/protocol/src/session-input/**`
- `packages/runtime/src/session-input/**`
- `packages/runtime/src/runtime-host/**`
- `packages/runtime/src/runtime-context/workflow.ts`
- `packages/client/src/firegrid.ts`
- `scenarios/firegrid/src/tracer-012.test.ts`
- `scenarios/firegrid/src/tracer-016.test.ts`
- `scenarios/firegrid/src/tracer-017.test.ts`

## Historical Names

Historical tracer docs and old architecture inventories may still mention
`runtime_ingress` to explain previous design states. Current packages, apps,
and scenarios must not import or emit `runtime_ingress`,
`@firegrid/protocol/runtime-ingress`, `@firegrid/runtime/runtime-ingress`, or
`firegrid.runtime_ingress.requested`.
