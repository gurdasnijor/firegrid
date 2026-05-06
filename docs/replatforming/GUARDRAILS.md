# Guardrails

Status: build-facing draft

This file is a review-time index. The source of truth is the Acai spec graph,
especially `firegrid-platform-invariants.*` plus lane-specific constraints.

## Hard Stops

Do not approve Firegrid PRs that:

- add Flamecast provider names, AgentSpec semantics, capabilities,
  providerAuth, providerOptions, sessions, prompts, permissions, tools,
  sandboxes, callbackEvents, WorkOS, OAuth, BYOK, MCP, or product SDK semantics
  to Firegrid packages as native Firegrid surfaces
  (`firegrid-platform-invariants.BOUNDARY.1`);
- add Standard Webhooks signing, callback URL minting, callback tokens, or
  customer webhook fanout policy to Firegrid core
  (`firegrid-platform-invariants.SECURITY.2`);
- store provider credentials, tenant auth policy, or secret material in
  Firegrid substrate/runtime packages
  (`firegrid-platform-invariants.SECURITY.1`);
- use runtime presence as command bus, private host mesh, internal endpoint
  registry, or credential directory
  (`firegrid-platform-invariants.SECURITY.3`);
- claim exactly-once external side effects without target-side idempotency or
  fencing (`firegrid-platform-invariants.SECURITY.6`);
- expose raw Durable Streams State envelopes, raw StreamDB collections, kernel
  imports, claim authority, completion authority, or terminal authority to
  browser/app code (`firegrid-platform-invariants.AUTHORITY.7`,
  `firegrid-projection-query.AUTHORITY_BOUNDARY.2`);
- resurrect dynamic runtime module loading or dev launcher patterns
  (`firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.4`);
- create reusable Flamecast adapter packages under `@firegrid/*`
  (`firegrid-platform-invariants.NON_SCOPE.3`);
- bundle multiple unrelated implementation lanes into one PR.

## Required Downstream Bars

Cross-repo or downstream package-consumption work must satisfy:

- 40-character Firegrid SHA pin and post-checkout assertion
  (`firegrid-platform-invariants.PACKAGE_DISCIPLINE.1`,
  `firegrid-platform-invariants.PACKAGE_DISCIPLINE.2`);
- packed Firegrid artifacts installed through `file:<absolute-path>` specs
  (`firegrid-platform-invariants.PACKAGE_DISCIPLINE.4`);
- no `workspace:`, `link:`, sibling path, committed tarball, or registry
  version assumption for `@firegrid/*`
  (`firegrid-platform-invariants.PACKAGE_DISCIPLINE.4`,
  `firegrid-platform-invariants.PACKAGE_DISCIPLINE.5`);
- canonical forbidden-token source scan
  (`firegrid-platform-invariants.PACKAGE_DISCIPLINE.6`);
- runtime composition through `Firegrid.composeRuntime`
  (`firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.2`);
- terminalization through handler return or typed `Effect.fail`
  (`firegrid-platform-invariants.AUTHORITY.1`);
- deterministic Pending/request visibility before external result writes
  (`firegrid-platform-invariants.AUTHORITY.5`,
  `firegrid-platform-invariants.AUTHORITY.6`).

## LT-02 Dispatch Rules

The current execution lane should build the real Flamecast chassis:

- target `apps/flamecast`, not a standalone smoke script;
- lift or adapt Flamecast UI/assets where practical;
- remove or quarantine Cloudflare Worker, Durable Object, R2, Postgres,
  ClickHouse, WorkOS, and provider infra from the chassis;
- use a deterministic local provider as a real local runtime adapter, not as a
  throwaway example;
- keep browser code on `@firegrid/client`;
- keep runtime code on Node-tier `@firegrid/runtime`;
- report exact public API gaps instead of using kernel imports, fake terminal
  rows, or direct durable row writes.

## Review Routing

Reviewers should not review implementation PRs until:

- diff scope matches the dispatch;
- `gh pr diff --name-only` shows only authorized files;
- the PR cites relevant ACIDs;
- specs/ACIDs exist for all new behavior.

For docs-only feature specs, local `pnpm run check:specs`, `pnpm run
check:docs`, and `git diff --check` are enough unless the coordinator requests
CI. Reviewers do not merge. Coordinator owns merge and cleanup.
