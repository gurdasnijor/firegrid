# Guardrails

Status: draft

This file is a review-time index. The long-term source of truth should be
`features/firegrid/firegrid-platform-invariants.feature.yaml` plus lane-specific
constraints.

## Hard Stops

Do not approve Firegrid PRs that:

- add Flamecast provider names, AgentSpec semantics, capabilities,
  providerAuth, providerOptions, sessions, prompts, permissions, tools,
  sandboxes, callbackEvents, WorkOS, OAuth, BYOK, MCP, or product SDK semantics
  to Firegrid packages;
- add Standard Webhooks signing, callback URL minting, callback tokens, or
  customer webhook fanout policy to Firegrid core;
- store provider credentials, tenant auth policy, or secret material in
  Firegrid substrate/runtime packages;
- use runtime presence as command bus, private host mesh, internal endpoint
  registry, or credential directory;
- claim exactly-once external side effects without target-side idempotency or
  fencing;
- expose raw Durable Streams State envelopes, raw StreamDB collections, kernel
  imports, claim authority, completion authority, or terminal authority to
  browser/app code;
- resurrect dynamic runtime module loading or dev launcher patterns;
- create reusable Flamecast adapter packages under `@firegrid/*`;
- bundle multiple deferred lanes into one PR.

## Required Smokes

Cross-repo or downstream smokes must:

- pin a 40-character Firegrid SHA;
- assert the checkout HEAD equals the pin;
- build and pack Firegrid packages;
- install packed artifacts through `file:<absolute-path>` specs;
- avoid `workspace:`, `link:`, sibling paths, committed tarballs, and registry
  assumptions;
- scan the canonical forbidden source tokens;
- prove no `@firegrid/substrate/kernel` imports in app/smoke code;
- use `Firegrid.composeRuntime`;
- terminalize through handler return or `Effect.fail`;
- observe deterministic Pending/request visibility before external result
  writes.

## Review Routing

Reviewers should not review implementation PRs until:

- CI is green;
- merge state is clean;
- diff scope matches the dispatch;
- `gh pr diff --name-only` shows only authorized files;
- specs/ACIDs exist for all new behavior.

Reviewers do not merge. Coordinator owns merge and cleanup.
