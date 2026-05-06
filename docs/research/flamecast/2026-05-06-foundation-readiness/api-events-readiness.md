# API and Events Readiness

Source: CA3 `FC-FOUNDATION-READINESS/API-EVENTS` read-only report.

## Verdict

Partial foundation. Flamecast already has durable-ish session orchestration and
normalized event storage, but today it is product-specific Cloudflare Durable
Object, agents, ClickHouse, and runtime-adapter infrastructure. Current
Firegrid public APIs can represent a core session run plus normalized event
stream, but not the full provider API, callback, and compatibility-check plane
without Flamecast-owned contracts and some Firegrid decisions.

## What Firegrid Can Represent Today

- `@firegrid/client` `send`, `observe`, `result`, and `events` for session
  operation lifecycle and typed result/error observation.
- `EventStream` for normalized Flamecast event history.
- `@firegrid/substrate/event-plane` for provider callbacks, permission/tool
  decisions, and steering rows owned by Flamecast.
- `RunWait` plus `projectionMatch` for handler suspension on external provider
  callbacks or permission decisions.
- `@firegrid/runtime` `Firegrid.composeRuntime` and `run` for Flamecast-owned
  Node runtime processes.

## Founded or Partial Areas

- Sessions API: partial. Flamecast has `GET/POST /sessions`,
  `GET/DELETE /sessions/:id`, `POST /sessions/:id/messages`, and abort routes.
  PRD route names and steering noun still differ.
- Normalized events: founded for local runtime events. Flamecast has an
  `IngestEvent` union and event constructors. Provider callback input and auth
  are not yet PRD-grade.
- Webhooks/provider callbacks: partial. Existing status callbacks are present,
  but Standard Webhooks signing, `callbackEvents`, `permission.required`, and
  provider callback tokens are missing.
- Steering/cancel/delete: partial. Steering exists through messages; cancel is
  runtime-specific and not yet a product-neutral Firegrid API.
- Runtime/provider services: partial. Internal `AgentRuntime` adapters exist;
  provider API contracts do not.

## Missing or Blocked Areas

- `/providers`, `/providers/:id`, and `/providers/:id/check`.
- Provider manifest schema and compatibility-check semantics.
- Provider API create/steer/cancel/event callback contract.
- Callback authentication, idempotency, and sequence ordering.
- Standard Webhooks signing and callback filtering.
- Structured event versioning aligned to the PRD event shape.

## Smallest Foundation Lanes

1. Flamecast Provider/AgentSpec/Capability/Event v1 schemas and route names.
2. Minimal Firegrid-backed Flamecast session/event smoke using packed Firegrid
   public APIs.
3. Provider callback as Flamecast EventPlane row with `RunWait` and public
   `Pending` observation.
4. Cancellation and wait-state decision lane: Firegrid API vs product-owned
   EventPlane projections.
5. Token-authenticated provider callback ingest with sequence/idempotency tests.

